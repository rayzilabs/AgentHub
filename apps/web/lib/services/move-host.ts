import { setTimeout as sleep } from 'node:timers/promises';
import { createHostedOps } from '@/lib/hosted-runtime';
import { hostFor, projectMachine, sleepSoon, versionMachine } from '@/lib/hosts';
import { errorText } from '@/lib/hosts/sprite';
import type { HostName, Machine, RuntimeHost } from '@/lib/hosts/types';
import { bringUpProject, destroyProjectMachine, spriteName } from '@/lib/project-runtime';
import type { Db } from '@/lib/supabase/admin';
import {
  deployCheckToken, HOSTED_BUCKET, HOSTED_LIMITS, hostedEnv, hostedSpriteName, type HostedOps, type HostedVersion,
} from './hosted-mcp';
import { STALE_RUN_MS } from './threads';

/** 只有這兩種狀態的代管版本有人在用（或即將發布），需要搬 */
export const MOVABLE_VERSION_STATUSES = ['published', 'ready'];

type ProjectHostRow = {
  host: HostName; sprite_name: string | null; sprite_url: string | null; host_token: string | null;
  sprite_status: 'provisioning' | 'ready' | 'error'; sprite_error: string | null;
};

/** 刪機器失敗不影響搬遷結果（新機器與資料列才是重點）；印出哪一台、哪一家、什麼錯，讓人手動清 */
async function bestEffortDestroy(what: string, host: HostName, name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.warn(`[move-host] ${what}失敗，請手動刪除：${host} ${name}（${errorText(e)}）`);
  }
}

/** 還在跑的 run（超過 20 分鐘的視為已中斷，與對話頁的判斷相同） */
async function hasRunningRun(db: Db, projectId: string): Promise<boolean> {
  const { count, error } = await db.from('runs').select('id, threads!inner(project_id)', { count: 'exact', head: true })
    .eq('threads.project_id', projectId).eq('status', 'running')
    .gt('started_at', new Date(Date.now() - STALE_RUN_MS).toISOString());
  if (error) throw error;
  return (count ?? 0) > 0;
}

/**
 * 把專案的機器搬到 to（目標與現在同一家時，只有機器不見才重新部署，見規格 §6.9）：先標 provisioning（對話路由不再收新對話）再檢查進行中的 run；
 * 新機器健康才一次更新資料列，之後刪舊機器（失敗只警告）。新機器失敗就刪掉它、資料列還原、丟出錯誤。
 */
export async function moveProject(
  db: Db, projectId: string, to: HostName, deps: { hosts?: (n: HostName) => RuntimeHost } = {},
): Promise<'moved' | 'skipped-running' | 'already-there'> {
  const hosts = deps.hosts ?? hostFor;
  const { data, error } = await db.from('projects')
    .select('host, sprite_name, sprite_url, host_token, sprite_status, sprite_error').eq('id', projectId).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`找不到專案 ${projectId}`);
  const original = data as ProjectHostRow;
  const current = projectMachine(original);
  const sameHost = original.host === to;
  if (sameHost && current && (await hosts(to).status(current)) !== 'gone') return 'already-there';
  if (original.sprite_status === 'provisioning') throw new Error('專案正在佈建中，等它完成後再搬');

  // 狀態沒變才標：與「重新建立環境」或另一個搬遷互斥
  const { data: claimed, error: claimError } = await db.from('projects')
    .update({ sprite_status: 'provisioning', sprite_error: null })
    .eq('id', projectId).eq('host', original.host).eq('sprite_status', original.sprite_status).select('id').maybeSingle();
  if (claimError) throw claimError;
  if (!claimed) throw new Error('專案狀態剛好改變，請重新執行');

  const restore = async () => {
    const { error: restoreError } = await db.from('projects').update(original).eq('id', projectId);
    if (restoreError) throw restoreError;
  };
  const restoreOrWarn = () => restore().catch((e) => {
    console.error(`[move-host] 還原專案 ${projectId} 的資料列失敗，請手動改回 ${JSON.stringify(original)}：${errorText(e)}`);
  });

  let running: boolean;
  try {
    running = await hasRunningRun(db, projectId);
  } catch (e) {
    await restoreOrWarn();
    throw e;
  }
  if (running) {
    await restore();
    return 'skipped-running';
  }

  let m: Machine;
  try {
    m = await bringUpProject(db, hosts(to), projectId);
    // 換列之前還沒有對話會打到這台：讓它先睡，--all 逐台搬時才不會同時醒著超過 Hobby 的 10 台
    await sleepSoon(hosts(to), m);
    const { error: swapError } = await db.from('projects').update({
      host: to, sprite_name: m.name, sprite_url: m.url, host_token: m.token, sprite_status: 'ready', sprite_error: null,
    }).eq('id', projectId);
    if (swapError) throw swapError;
  } catch (e) {
    // E2B 依 claim 刪掉這個專案在目標的全部沙盒（含建立到一半的）；Sprite 的名稱就是 claim
    await bestEffortDestroy('刪除新機器', to, spriteName(projectId), () => destroyProjectMachine(null, projectId, to, hosts));
    await restoreOrWarn();
    throw e;
  }

  if (!sameHost) {
    await bestEffortDestroy('刪除舊機器', original.host, original.sprite_name ?? spriteName(projectId),
      () => destroyProjectMachine(current, projectId, original.host, hosts));
  } else if (current && current.name !== m.name) {
    // 同一家：依名稱只刪舊的那台（E2B 依 claim 刪會連新沙盒一起刪；Sprite 名稱固定，新舊同名就不刪）
    await bestEffortDestroy('刪除舊機器', to, current.name, () => hosts(to).destroy(current.name, 'agenthub-'));
  }
  return 'moved';
}

/** 等部署完成、啟動 mcp 服務、tools/list 至少一個工具；程式還在啟動就重試到逾時 */
async function waitForTools(ops: HostedOps, m: Machine, templateId: string, pollMs: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '部署中';
  for (;;) {
    const state = await ops.readState(m);
    if (state.phase === 'failed') throw new Error(`新機器部署失敗：${state.error}\n${state.log}`);
    if (state.phase === 'installed') {
      await ops.startService(m, state.start);
      let tools: unknown[] | null = null;
      try {
        tools = await ops.listTools(m, deployCheckToken(templateId, m));
      } catch (e) {
        last = `等待程式回應：${errorText(e)}`;
      }
      if (tools) {
        if (tools.length === 0) throw new Error('新機器的 MCP 沒有任何工具');
        return;
      }
    }
    if (Date.now() >= deadline) throw new Error(`新機器部署逾時（${last}）`);
    await sleep(pollMs);
  }
}

/**
 * 把代管 MCP 版本搬到 to（目標與現在同一家時，只有機器不見才重新部署，見規格 §6.9）：用 Storage 同一份套件與 Vault 的金鑰在目標部署，listTools 成功才換資料列，
 * 之後刪舊機器（失敗只警告）。只搬 published、ready；新機器失敗就刪掉它、資料列不動、丟出錯誤。
 */
export async function moveHostedVersion(
  db: Db, versionId: string, to: HostName,
  deps: { ops?: HostedOps; pollMs?: number; timeoutMs?: number } = {},
): Promise<'moved' | 'skipped' | 'already-there'> {
  const ops = deps.ops ?? createHostedOps();
  const { data, error } = await db.from('hosted_mcp_versions').select('*').eq('id', versionId).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`找不到代管版本 ${versionId}`);
  const version = data as HostedVersion;
  if (!MOVABLE_VERSION_STATUSES.includes(version.status)) return 'skipped';
  const current = versionMachine(version);
  const sameHost = version.host === to;
  if (sameHost && current && (await ops.status(current)) !== 'gone') return 'already-there';

  const claim = hostedSpriteName(version.id);
  let m: Machine;
  try {
    const { data: signed, error: signError } = await db.storage.from(HOSTED_BUCKET).createSignedUrl(version.bundle_path, 900);
    if (signError) throw new Error(`讀不到套件 ${version.bundle_path}：${signError.message}`);
    const vars = await hostedEnv(db, version.template_id, version.mcp_name);
    m = await ops.provision({ ...version, host: to }, vars, signed.signedUrl);
    // 部署腳本上限 9 分鐘，再留一點給程式啟動；本機腳本沒有 Vercel 的 300 秒限制
    await waitForTools(ops, m, version.template_id, deps.pollMs ?? 5000, deps.timeoutMs ?? HOSTED_LIMITS.deployMs);
    // 檢查完、換列之前沒有請求會打到這台：讓它先睡（同上，避免同時醒著太多台）
    await sleepSoon(ops, m);
    const { data: swapped, error: swapError } = await db.from('hosted_mcp_versions')
      .update({ host: to, sprite_name: m.name, sprite_url: m.url, host_token: m.token })
      .eq('id', version.id).eq('host', version.host).in('status', MOVABLE_VERSION_STATUSES).select('id').maybeSingle();
    if (swapError) throw swapError;
    if (!swapped) throw new Error('版本在搬遷期間被下架或停用，不換機器');
  } catch (e) {
    // E2B 依 claim 刪掉這個版本在目標的全部沙盒；Sprite 的名稱就是 claim
    await bestEffortDestroy('刪除新機器', to, claim, () => ops.destroy(to, claim));
    throw e;
  }

  const old = version.sprite_name;
  // 同一家：Sprite 新舊同名（claim）不刪；E2B 依 sandboxId 只刪舊的那台，不能依 claim（會刪到新沙盒）
  if (old && !(sameHost && old === m.name)) {
    await bestEffortDestroy('刪除舊機器', version.host, old, () => ops.destroy(version.host, old));
  }
  return 'moved';
}
