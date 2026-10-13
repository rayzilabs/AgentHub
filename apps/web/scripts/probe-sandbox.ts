// 用法：cd apps/web && pnpm exec tsx scripts/probe-sandbox.ts main-<sha>.js
// 建一台暫時的 Sprite，照正式流程佈建（含舊版工作區搬移），以 agent 帳號逐項嘗試拿平台金鑰；
// 全部擋下且功能正常才算通過。結束時一定刪除這台 Sprite。
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SpritesClient, type Sprite } from '@fly/sprites';

process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
const { adminDb } = await import('@/lib/supabase/admin');
const { destroyProjectSprite, installRuntime, WORKSPACE } = await import('@/lib/sprites');

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
const asAgent = (cmd: string) => `sudo -n -u agent -- bash -c ${JSON.stringify(cmd)}`;

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
  const sock = await sh(sprite, asAgent('curl -s --max-time 3 --unix-socket /.sprite/api.sock http://sprite/v1/tasks'));
  record('碰不到 /.sprite/api.sock', sock.code !== 0, sock.out);

  const legacy = await sh(sprite, asAgent(`cat ${WORKSPACE}/agents/legacy/report.md`));
  record('舊工作區的檔案搬到 /workspace 且 agent 讀得到', legacy.out === 'kept', legacy.out);
  const write = await sh(sprite, [
    `echo r > ${WORKSPACE}/shared/from-runtime`,
    asAgent(`echo a >> ${WORKSPACE}/shared/from-runtime && echo b > ${WORKSPACE}/shared/from-agent`),
    `rm ${WORKSPACE}/shared/from-agent`,
  ].join(' && '));
  record('runtime 與 agent 都能讀寫工作區', write.code === 0, write.out);

  const kill = await sh(sprite, [
    `setsid sudo -n -E -u agent -- sh -c 'umask 002; exec "$@"' sandbox bash -c 'sleep 300 & sleep 300' &`,
    'pid=$!; sleep 1',
    'sudo -n -u agent -- kill -KILL -- -$pid; sleep 1',
    'pgrep -u agent sleep >/dev/null && echo still-running || echo all-killed',
  ].join('\n'));
  record('以 agent 帳號送 SIGKILL 能終止整個程序群組', kill.out.endsWith('all-killed'), kill.out);
} finally {
  await destroyProjectSprite(name).catch((e: Error) => console.error('刪除暫時 Sprite 失敗，請手動刪除', name, e.message));
}

for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.check}${r.pass ? '' : `\n      ${r.detail}`}`);
process.exit(results.length > 0 && results.every((r) => r.pass) ? 0 : 1);
