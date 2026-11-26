// 用法：cd apps/web && pnpm exec tsx scripts/probe-hosted-mcp.ts [--host sprite|e2b] [python|node ...]
// 在指定的執行環境（預設 E2B）部署 docs/creator/examples 的代管範本，逐項檢查隔離與功能；結束時下架、刪除測試資料與機器。
// 需要正式資料庫已套用 20261015000001_hosted_mcp.sql 與執行環境欄位的 migration。
// 不需要正式的簽章金鑰：腳本產生一把測試金鑰，在代管機器上起一個只回這把公鑰的 JWKS 服務當作平台。
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import type { HostName, Machine } from '@/lib/hosts/types';

process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
const argv = process.argv.slice(2);
const hostAt = argv.indexOf('--host');
const hostName = hostAt < 0 ? 'e2b' : argv[hostAt + 1];
if (hostName !== 'sprite' && hostName !== 'e2b') throw new Error('--host 只能是 sprite 或 e2b');
const runtimeArgs = hostAt < 0 ? argv : [...argv.slice(0, hostAt), ...argv.slice(hostAt + 2)];
// 新版本建在預設執行環境（createVersion 讀 DEFAULT_RUNTIME_HOST）
process.env.DEFAULT_RUNTIME_HOST = hostName;
const JWKS_PORT = 9999;
process.env.MCP_SIGNING_KEY = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
process.env.PLATFORM_URL = `http://127.0.0.1:${JWKS_PORT}`;
const { adminDb } = await import('@/lib/supabase/admin');
const { env } = await import('@/lib/env');
const { hostFor, versionMachine } = await import('@/lib/hosts');
const { errorText } = await import('@/lib/hosts/sprite');
const { shellQuote } = await import('@/lib/project-runtime');
const { publicJwk, signCreatorToken } = await import('@/lib/platform-tokens');
const { createTemplate } = await import('@/lib/services/templates');
const { createHostedOps, HOSTED_RUN, listToolsOver } = await import('@/lib/hosted-runtime');
const hosted = await import('@/lib/services/hosted-mcp');

const runtimes = runtimeArgs.length ? runtimeArgs : ['python', 'node'];
const db = adminDb();
const ops = createHostedOps();
const host = hostFor(hostName as HostName);
const results: { check: string; pass: boolean; detail: string }[] = [];
const record = (check: string, pass: boolean, detail: string) => {
  results.push({ check, pass, detail: detail.slice(0, 300) });
  console.log(`${pass ? '✓' : '✗'} ${check}${detail ? `：${detail.slice(0, 200)}` : ''}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clean = (s: string) => s.split('\n').filter((l) => !/\.bashrc: line \d+: bind: warning/.test(l)).join('\n').trim();
console.log(`執行環境：${hostName}`);

/** 這次建立的機器：結束時逐一確認已不在 */
const created: Machine[] = [];

const RC = '__probe_rc=';
/** 以機器的 runtime 帳號執行；結束碼與 stderr 都從輸出帶回（兩家 exec 在非 0 結束時丟的錯誤格式不同） */
async function sh(m: Machine, cmd: string): Promise<{ code: number; out: string }> {
  try {
    const raw = await host.exec(m, `bash -lc ${shellQuote(cmd)} 2>&1; echo "${RC}$?"`, { timeoutMs: 120_000 });
    const at = raw.lastIndexOf(RC);
    if (at < 0) return { code: 1, out: clean(raw) };
    return { code: Number(raw.slice(at + RC.length).trim()), out: clean(raw.slice(0, at)) };
  } catch (e) {
    return { code: 1, out: errorText(e) };
  }
}
const asMcp = (cmd: string) => `sudo -n unshare --mount --propagation private -- ${HOSTED_RUN} /bin/sh -c ${JSON.stringify(cmd)}`;

function zipDir(dir: string): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const walk = (rel: string) => {
    for (const name of readdirSync(join(dir, rel))) {
      if (name === 'node_modules' || name === '.venv' || name === '__pycache__') continue;
      const p = rel ? `${rel}/${name}` : name;
      if (statSync(join(dir, p)).isDirectory()) walk(p);
      else files[p] = readFileSync(join(dir, p));
    }
  };
  walk('');
  return zipSync(files);
}

async function callEcho(m: Machine, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const token = signCreatorToken(
    { iss: env.platformUrl, aud: `${m.url}/mcp`, sub: 'probe', project_id: 'probe', template_id: null }, env.mcpSigningKey,
  );
  // 與閘道相同：邊緣驗證標頭依執行環境（Sprite 是 Fly token，E2B 是這台自己的通行證）
  const res = await fetch(`${m.url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'x-agenthub-token': token, ...host.edgeHeaders(m),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: args } }),
  });
  const text = await res.text();
  const json = JSON.parse(text.trim().startsWith('{') ? text : text.split('\n').find((l) => l.startsWith('data:'))!.slice(5));
  const result = json.result;
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}

/** 以 runtime 帳號起一個只回測試公鑰的 JWKS 服務（127.0.0.1，只有機器內部連得到） */
async function startJwks(m: Machine): Promise<void> {
  const body = Buffer.from(JSON.stringify({ keys: [publicJwk(process.env.MCP_SIGNING_KEY!)] })).toString('base64');
  await sh(m, `mkdir -p /tmp/agenthub-probe-jwks/.well-known && printf '%s' '${body}' | base64 -d > /tmp/agenthub-probe-jwks/.well-known/jwks.json`);
  await host.startService(m, {
    name: 'jwks', cmd: 'bash', args: ['-lc', `exec python3 -m http.server ${JWKS_PORT} --bind 127.0.0.1 --directory /tmp/agenthub-probe-jwks`],
  });
}

async function probe(runtime: string, creatorId: string, decoy: Machine | null): Promise<void> {
  console.log(`\n== ${runtime}`);
  const t = await createTemplate(db, creatorId, {
    name: `代管驗收 ${runtime}`, description: '', category: '', system_prompt: 'p',
    mcp_servers: [{ name: 'fin', transport: 'remote', hosted: true, required_secrets: [] }],
  });
  const dir = fileURLToPath(new URL(`../../../docs/creator/examples/hosted-${runtime}/`, import.meta.url));
  const { version, signedUrl } = await hosted.createVersion(db, creatorId, t.id, 'fin');
  const up = await fetch(signedUrl, { method: 'PUT', body: new Blob([zipDir(dir) as BlobPart]), headers: { 'content-type': 'application/zip', 'x-upsert': 'true' } });
  if (!up.ok) throw new Error(`上傳失敗 ${up.status}`);
  await hosted.startDeploy(db, creatorId, version.id);

  let v = version;
  try {
    record(`${runtime}：版本建在 ${hostName}`, version.host === hostName, version.host);
    v = await hosted.syncVersion(db, version.id, ops);
    const first = versionMachine(v);
    if (!first) {
      record(`${runtime}：部署成功`, false, `沒有建立機器：${v.status} ${v.log_tail}`);
      return;
    }
    created.push(first);
    await startJwks(first);
    const started = Date.now();
    while (v.status === 'deploying') {
      await sleep(5000);
      v = await hosted.syncVersion(db, version.id, ops);
      process.stdout.write(`  ${Math.round((Date.now() - started) / 1000)}s ${v.status} ${v.log_tail.split('\n').at(-1)}\n`);
    }
    record(`${runtime}：部署成功`, v.status === 'ready', `${v.status} ${Math.round((Date.now() - started) / 1000)}s\n${v.status === 'ready' ? '' : v.log_tail}`);
    if (v.status !== 'ready') return;
    record(`${runtime}：工具清單含 echo`, (v.tools as { name: string }[]).some((x) => x.name === 'echo'), JSON.stringify(v.tools));

    const m = versionMachine(v)!;
    const deploy = await sh(m, asMcp('cat /srv/agenthub-mcp/deploy/deploy.sh'));
    record(`${runtime}：mcp 讀不到部署腳本（下載網址）`, deploy.code !== 0 && !deploy.out.includes('curl'), deploy.out);
    if (hostName === 'sprite') {
      const sock = await sh(m, asMcp('curl -s --max-time 5 --unix-socket /.sprite/api.sock http://sprite/v1/services'));
      record(`${runtime}：mcp 碰不到 Sprite 內部 API`, sock.code !== 0 || !sock.out.includes('"name"'), sock.out);
    } else {
      const body = JSON.stringify({ process: { cmd: '/bin/sh', args: ['-c', 'id > /srv/agenthub-mcp/envd-probe'] } });
      const envd = await sh(m, asMcp(`curl -sS -m 5 -o /dev/null -w "start=%{http_code}" -u root: -H "Content-Type: application/json" -H "Connect-Protocol-Version: 1" -d '${body}' http://127.0.0.1:49983/process.Process/Start`));
      const ran = await sh(m, 'sudo -n test -e /srv/agenthub-mcp/envd-probe && echo created || echo absent');
      record(`${runtime}：mcp 呼叫 envd 啟動程序被拒（401）`, envd.out.includes('start=401') && ran.out.includes('absent'), `${envd.out} | ${ran.out}`);
    }
    const runtimeUser = (await sh(m, 'id -un')).out.split('\n').at(-1)!;
    for (const target of [runtimeUser, 'root']) {
      const su = await sh(m, asMcp(`su ${target} -c id </dev/null`));
      record(`${runtime}：mcp 不能 su 成 ${target}`, su.code !== 0 && !/uid=/.test(su.out), su.out);
      if (hostName === 'e2b') {
        const ssh = await sh(m, asMcp(`ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 ${target}@127.0.0.1 id </dev/null`));
        record(`${runtime}：mcp 無法經 sshd 登入 ${target}`, ssh.code !== 0 && !/uid=/.test(ssh.out), ssh.out);
      }
    }
    const write = await sh(m, asMcp('echo X=1 >> /srv/agenthub-mcp/env.sh'));
    record(`${runtime}：mcp 改不了 env.sh`, write.code !== 0, write.out);
    const sudo = await sh(m, asMcp('sudo -n true'));
    record(`${runtime}：mcp 沒有 sudo`, sudo.code !== 0, sudo.out);
    // 系統目錄可寫就能換掉部署腳本與服務會執行的 node、python（E2B 基底映像的 /usr/local 曾整棵可寫）
    const writable = await sh(m, asMcp('find /usr /etc /opt /bin /sbin /lib /code \\( -perm -0002 ! -type l ! -perm -1000 \\) -print 2>/dev/null | head -5'));
    record(`${runtime}：系統目錄沒有 mcp 可寫的項目`, writable.out === '', writable.out);

    const echo = await callEcho(m, { text: 'hi', show_headers: true, env_name: 'PROBE_KEY' });
    const headers = (echo.headers as string[]) ?? [];
    record(`${runtime}：經邊緣驗證呼叫成功`, echo.text === 'hi', JSON.stringify(echo));
    // Sprite：Fly token 放在 Authorization，Fly 驗證後拿掉；E2B：平台不送 Authorization（E2B 會原封不動轉進來）
    record(`${runtime}：Authorization 沒有到達程式`, headers.length > 0 && !headers.includes('authorization'), headers.join(','));
    record(`${runtime}：設定金鑰前 PROBE_KEY 不存在`, echo.env_present === false, JSON.stringify(echo));

    // 程式看得到的環境：自己的環境變數、env.sh、mcp 帳號所有程序（含正在跑的程式）的 environ 與命令列。
    // 平台的金鑰與別台的通行證只在本機比對，不送進機器；腳本以 base64 傳入，$ 才會在 mcp 的 shell 展開
    const dumpScript = 'env; cat /srv/agenthub-mcp/env.sh; for p in $(pgrep -u mcp); do tr "\\0" "\\n" < /proc/$p/environ; tr "\\0" " " < /proc/$p/cmdline; echo; done';
    const dump = await sh(m, asMcp(`echo ${Buffer.from(dumpScript).toString('base64')} | base64 -d | /bin/sh`));
    const platformSecrets = [env.spritesToken, env.e2bApiKey, process.env.SUPABASE_SECRET_KEY].filter((x): x is string => !!x);
    record(
      `${runtime}：程式看不到 Fly token、E2B API key 與平台金鑰`,
      dump.out.includes('AGENTHUB_MCP_URL=') && !platformSecrets.some((x) => dump.out.includes(x)),
      [...new Set(dump.out.split('\n').map((l) => /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(l)?.[1]).filter(Boolean))].join(','),
    );
    if (decoy?.token && m.token) {
      record(`${runtime}：程式看不到別台沙盒的通行證`, dump.out.includes('AGENTHUB_MCP_URL=') && !dump.out.includes(decoy.token), '');
      // 這台的通行證只能連回自己：拿去連別台，E2B 邊緣就擋掉
      const status = async (token: string) =>
        (await fetch(decoy.url, { headers: { 'e2b-traffic-access-token': token }, signal: AbortSignal.timeout(15_000) })).status;
      const own = await status(m.token);
      const theirs = await status(decoy.token);
      record(`${runtime}：這台的通行證連不進別台沙盒`, own === 403 && theirs !== 403, `用這台的 ${own}；用那台自己的 ${theirs}`);
    }

    await hosted.setHostedSecrets(db, creatorId, t.id, 'fin', { PROBE_KEY: 'v1' }, ops);
    // 版本還是 ready，setHostedSecrets 會套用並重啟；等程式重新起來
    let after: Record<string, unknown> = {};
    for (let i = 0; i < 12; i++) {
      try {
        after = await callEcho(m, { text: 'hi', env_name: 'PROBE_KEY' });
        if (after.env_present === true) break;
      } catch {
        // 重啟中
      }
      await sleep(2500);
    }
    record(`${runtime}：金鑰更新後重啟生效`, after.env_present === true, JSON.stringify(after));

    const tools = await listToolsOver(fetch, `${m.url}/mcp`, {
      'x-agenthub-token': 'not-a-token', ...host.edgeHeaders(m),
    }).then(() => 'accepted', (e: Error) => e.message);
    record(`${runtime}：沒有有效通行證被程式拒絕`, tools.includes('401'), tools);
  } finally {
    const retired = await hosted.retireVersion(db, creatorId, version.id, ops).catch((e: Error) => e);
    record(`${runtime}：下架並刪除機器`, !(retired instanceof Error) && retired.status === 'retired', retired instanceof Error ? retired.message : '');
    // 部署中途失敗、資料列沒記到的機器：依 claim 再刪一次（Sprite 的名稱就是 claim；E2B 找 metadata）
    await host.destroy(hosted.hostedSpriteName(version.id), 'agenthub-mcp-').catch((e: unknown) => console.error('依 claim 刪除失敗', errorText(e)));
    await db.from('agent_templates').delete().eq('id', t.id);
    await db.storage.from('mcp-bundles').remove([v.bundle_path]);
  }
}

const { data: user, error } = await db.auth.admin.createUser({ email: `probe-hosted-${randomUUID().slice(0, 8)}@test.local`, password: randomUUID(), email_confirm: true });
if (error) throw error;
// E2B：另開一台空的沙盒當「別台」，檢查程式拿不到它的通行證、自己的通行證也連不進它
const decoyClaim = `agenthub-mcp-probe-${randomUUID().slice(0, 8)}`;
try {
  let decoy: Machine | null = null;
  if (hostName === 'e2b') {
    decoy = await host.create(decoyClaim, 'mcp');
    created.push(decoy);
  }
  for (const r of runtimes) await probe(r, user.user.id, decoy);
} finally {
  await db.auth.admin.deleteUser(user.user.id);
  if (hostName === 'e2b') await host.destroy(decoyClaim, 'agenthub-mcp-').catch((e: unknown) => console.error('刪除對照沙盒失敗，請手動刪除', decoyClaim, errorText(e)));
  const left: string[] = [];
  for (const m of created) {
    const state = await host.status(m).catch((e: unknown) => errorText(e));
    if (state !== 'gone') left.push(`${m.name} ${state}`);
  }
  record('這次建立的機器都已刪除', left.length === 0, left.join(','));
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} 通過`);
process.exit(failed.length ? 1 : 0);
