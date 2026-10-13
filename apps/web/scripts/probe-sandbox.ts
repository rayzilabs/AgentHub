// 用法：cd apps/web && pnpm exec tsx scripts/probe-sandbox.ts main-<sha>.js
// 建一台暫時的 Sprite，照正式流程佈建（含舊版工作區搬移），以 agent 帳號逐項嘗試拿平台金鑰；
// 全部擋下且功能正常才算通過。結束時一定刪除這台 Sprite。
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SpritesClient, type Sprite } from '@fly/sprites';

process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
const { adminDb } = await import('@/lib/supabase/admin');
const { destroyProjectSprite, installRuntime, SANDBOX_ADDUSER, SANDBOX_WRAPPER, WORKSPACE } = await import('@/lib/sprites');

const runtimeObject = process.argv[2];
if (!runtimeObject) throw new Error('請指定 runtime 物件名稱，例如 main-abc1234.js');

const projectId = randomUUID();
const name = `agenthub-probe-${projectId.slice(0, 8)}`;
const token = process.env.FLY_SPRITES_TOKEN!;
const client = new SpritesClient(token);
const results: { check: string; pass: boolean; detail: string }[] = [];
const record = (check: string, pass: boolean, detail: string) => results.push({ check, pass, detail: detail.slice(0, 300) });

async function sh(sprite: Sprite, cmd: string): Promise<{ code: number; out: string }> {
  try {
    const r = await sprite.execFile('bash', ['-lc', cmd]);
    return { code: 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
  } catch (e) {
    const err = e as { exitCode?: number; stdout?: unknown; stderr?: unknown; message?: string };
    return { code: err.exitCode ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}${err.message ?? ''}`.trim() };
  }
}
// 與 runtime 的 sandbox.ts 相同的執行路徑：root 開獨立掛載命名空間 → 沙盒腳本蓋掉內部 API → 降權成 agent
const sandboxPrefix = () => `SANDBOX_PATH="$PATH" sudo -n -E -- unshare --mount --propagation private -- ${SANDBOX_WRAPPER} agent`;
const asAgent = (cmd: string) => `${sandboxPrefix()} bash -c ${JSON.stringify(cmd)}`;

async function health(url: string): Promise<string> {
  const deadline = Date.now() + 60_000;
  let last = '';
  while (Date.now() < deadline) {
    last = await fetch(`${url}/health`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) })
      .then(async (r) => `${r.status} ${await r.text()}`)
      .catch((e: Error) => e.message);
    if (last.includes(projectId)) return last;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return last;
}

try {
  const sprite = await client.createSprite(name, { urlSettings: { auth: 'sprite' } });
  const base = `${(await sh(sprite, 'printf %s "$HOME"')).out}/agenthub`;

  // 模擬舊版佈建留下的工作區，確認重新佈建時檔案會搬到 /workspace
  await sh(sprite, `mkdir -p '${base}/agents/legacy' '${base}/shared' && echo kept > '${base}/agents/legacy/report.md'`);
  await installRuntime(adminDb(), sprite, projectId, runtimeObject);

  const leak = /SUPABASE|VERTEX|sb_secret/;
  const mustNotLeak = async (check: string, cmd: string) => {
    const r = await sh(sprite, asAgent(cmd));
    record(check, r.code !== 0 || !leak.test(r.out), r.out);
  };

  record('runtime 服務起得來（含沙盒帳號啟動檢查）', (await health(sprite.url!)).includes(projectId), await health(sprite.url!));
  await mustNotLeak('env 看不到平台金鑰', 'env');
  await mustNotLeak('讀不到 .env', `cat '${base}/.env'`);
  await mustNotLeak('symlink 指向 .env 也讀不到', `ln -sf '${base}/.env' ${WORKSPACE}/shared/link && cat ${WORKSPACE}/shared/link`);
  await mustNotLeak('讀不到 runtime 的 /proc environ', 'for p in $(pgrep node); do cat /proc/$p/environ 2>/dev/null | tr "\\0" "\\n"; done');
  const sudo = await sh(sprite, asAgent('sudo -n true'));
  record('agent 不能 sudo', sudo.code !== 0, sudo.out);
  const sockCmd = 'curl -sf --max-time 3 --unix-socket /.sprite/api.sock http://sprite/v1/tasks';
  const sock = await sh(sprite, asAgent(sockCmd));
  record('agent 碰不到 /.sprite/api.sock（它能建立以 runtime 帳號執行的服務）', sock.code !== 0, sock.out);
  // 不只檢查 /.sprite/api.sock：找出沙盒看得到的每個 Unix socket，逐一試著呼叫內部 API
  const anySock = await sh(sprite, asAgent(
    'for s in $(find / \\( -path /proc -o -path /sys \\) -prune -o -type s -print 2>/dev/null); do ' +
    'c=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 --unix-socket "$s" http://sprite/v1/tasks 2>/dev/null); ' +
    'echo "$s $c"; done',
  ));
  record('沙盒看得到的 socket 都連不上內部 API', !/ 2\d\d$/m.test(anySock.out), anySock.out);
  const sockRuntime = await sh(sprite, sockCmd);
  record('runtime 帳號仍然能用 /.sprite/api.sock（保持喚醒需要）', sockRuntime.code === 0, sockRuntime.out);

  const tools = await sh(sprite, asAgent('command -v node && command -v python3'));
  record('沙盒裡找得到 node 與 python3', tools.code === 0, tools.out);
  const legacy = await sh(sprite, asAgent(`cat ${WORKSPACE}/agents/legacy/report.md`));
  record('舊工作區的檔案搬到 /workspace 且 agent 讀得到', legacy.code === 0 && legacy.out.trim() === 'kept', JSON.stringify(legacy));
  const write = await sh(sprite, [
    // runtime 程序的 umask 是 002（main.ts），這裡比照
    `umask 002 && echo r > ${WORKSPACE}/shared/from-runtime`,
    asAgent(`echo a >> ${WORKSPACE}/shared/from-runtime && echo b > ${WORKSPACE}/shared/from-agent`),
    `rm ${WORKSPACE}/shared/from-agent`,
  ].join(' && '));
  record('runtime 與 agent 都能讀寫工作區', write.code === 0, write.out);

  const kill = await sh(sprite, [
    `setsid ${sandboxPrefix()} bash -c 'sleep 300 & sleep 300' &`,
    'pid=$!; sleep 1',
    'sudo -n -u agent -- kill -KILL -- -$pid; sleep 1',
    'pgrep -u agent sleep >/dev/null && echo still-running || echo all-killed',
  ].join('\n'));
  // bash 會在結果後面補印背景工作被終止的通知，所以不能只看最後一行
  record('以 agent 帳號送 SIGKILL 能終止整個程序群組', kill.out.includes('all-killed') && !kill.out.includes('still-running'), kill.out);

  // ---- 子專案 2：顧問之間隔離（兩位顧問 A、B，主管是 agent）----
  const userOf = (id: string) => `agent-${id.replace(/-/g, '').slice(0, 12)}`;
  const adduser = (u: string, d: string) => sh(sprite, `sudo -n ${SANDBOX_ADDUSER} ${u} ${d}`);
  const asUser = (u: string, cmd: string) =>
    `SANDBOX_PATH="$PATH" sudo -n -E -- unshare --mount --propagation private -- ${SANDBOX_WRAPPER} ${u} bash -c ${JSON.stringify(cmd)}`;
  const idA = randomUUID();
  const idB = randomUUID();
  const A = userOf(idA);
  const B = userOf(idB);
  const dirA = `${WORKSPACE}/agents/${idA}`;
  for (const [id, u] of [[idA, A], [idB, B]] as const) {
    const r = await adduser(u, `${WORKSPACE}/agents/${id}`);
    record(`adduser 建立顧問帳號 ${u}`, r.code === 0, r.out);
  }
  // runtime 同步 skill（runtime 的 umask 是 002）
  await sh(sprite, `umask 002 && mkdir -p ${dirA}/skills/s && echo sop > ${dirA}/skills/s/SKILL.md`);
  const aw = await sh(sprite, asUser(A, `echo a-secret > ${dirA}/work.txt && echo a-tmp > /tmp/a.txt && echo shared-a > ${WORKSPACE}/shared/from-a.txt`));
  record('顧問 A 能寫自己的目錄、/tmp、/shared', aw.code === 0, aw.out);
  const ar = await sh(sprite, asUser(A, `cat ${dirA}/skills/s/SKILL.md`));
  record('顧問 A 讀得到自己的 skill', ar.code === 0 && ar.out.trim() === 'sop', JSON.stringify(ar));
  for (const [label, cmd] of [
    ['B 讀不到 A 的 skill', `cat ${dirA}/skills/s/SKILL.md`],
    ['B 讀不到 A 的工作檔', `cat ${dirA}/work.txt`],
    ['B 讀不到 A 的私人 /tmp 實體目錄', `cat /var/lib/agenthub/tmp/${A}/a.txt`],
    ['B 的 /tmp 裡沒有 A 的檔案', 'cat /tmp/a.txt'],
  ] as const) {
    const r = await sh(sprite, asUser(B, cmd));
    record(label, r.code !== 0 && !r.out.includes('sop') && !r.out.includes('a-'), r.out);
  }
  const mgr = await sh(sprite, asUser('agent', `cat ${dirA}/work.txt`));
  record('主管讀不到顧問的工作檔', mgr.code !== 0, mgr.out);
  const shared = await sh(sprite, asUser(B, `cat ${WORKSPACE}/shared/from-a.txt && echo b >> ${WORKSPACE}/shared/from-a.txt`));
  record('B 讀得到也改得了 A 放在 /shared 的檔案', shared.code === 0 && shared.out.startsWith('shared-a'), shared.out);
  const mk = await sh(sprite, asUser(B, `mkdir ${WORKSPACE}/agents/${randomUUID()}`));
  record('顧問不能在 /workspace/agents 建立項目', mk.code !== 0, mk.out);
  const killA = await sh(sprite, [
    `setsid ${asUser(A, 'sleep 300')} &`,
    'pid=$!; sleep 1',
    `${asUser(B, 'kill -KILL -- -$pid')}; sleep 1`,
    `pgrep -u ${A} sleep >/dev/null && echo a-alive || echo a-killed`,
    `sudo -n pkill -u ${A} sleep || true`,
  ].join('\n'));
  record('B 終止不了 A 的程序', killA.out.includes('a-alive'), killA.out);
  for (const [label, args] of [
    ['adduser 拒絕 root 帳號', `root ${dirA}`],
    ['adduser 拒絕 /etc', `${A} /etc`],
    ['adduser 拒絕 ../ 路徑', `${A} ${WORKSPACE}/agents/../../etc`],
  ] as const) {
    const r = await sh(sprite, `sudo -n ${SANDBOX_ADDUSER} ${args}`);
    record(label, r.code !== 0, r.out);
  }
  const badUser = await sh(sprite, `sudo -n -E -- unshare --mount --propagation private -- ${SANDBOX_WRAPPER} root true`);
  record('沙盒腳本拒絕 root 帳號', badUser.code !== 0, badUser.out);
  // 1-A 時期的顧問目錄：workspace 群組、裡面有 agent 擁有的檔案 → 轉換後主管讀不到、該顧問讀得到
  const idOld = randomUUID();
  const dirOld = `${WORKSPACE}/agents/${idOld}`;
  await sh(sprite, `sudo mkdir ${dirOld} && sudo chown "$(id -un)":workspace ${dirOld} && sudo chmod 2770 ${dirOld} && echo old | sudo -u agent tee ${dirOld}/old.txt >/dev/null`);
  const conv = await adduser(userOf(idOld), dirOld);
  const oldMgr = await sh(sprite, asUser('agent', `cat ${dirOld}/old.txt`));
  const oldOwner = await sh(sprite, asUser(userOf(idOld), `cat ${dirOld}/old.txt`));
  record('1-A 時期的目錄轉成顧問群組：主管讀不到、該顧問讀得到', conv.code === 0 && oldMgr.code !== 0 && oldOwner.out.trim() === 'old', `${conv.out} | ${oldMgr.out} | ${oldOwner.out}`);
} finally {
  await destroyProjectSprite(name).catch((e: Error) => console.error('刪除暫時 Sprite 失敗，請手動刪除', name, e.message));
}

for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.check}${r.pass ? '' : `\n      ${r.detail}`}`);
process.exit(results.length > 0 && results.every((r) => r.pass) ? 0 : 1);
