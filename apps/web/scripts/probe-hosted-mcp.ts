// 用法：cd apps/web && pnpm exec tsx scripts/probe-hosted-mcp.ts [python|node ...]
// 以真的 Sprite 部署 docs/creator/examples 的代管範本，逐項檢查隔離與功能；結束時下架、刪除測試資料與 Sprite。
// 需要正式資料庫已套用 20261015000001_hosted_mcp.sql。
// 不需要正式的簽章金鑰：腳本產生一把測試金鑰，在代管 Sprite 上起一個只回這把公鑰的 JWKS 服務當作平台。
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SpritesClient, type Sprite } from '@fly/sprites';
import { zipSync } from 'fflate';

process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
const JWKS_PORT = 9999;
process.env.MCP_SIGNING_KEY = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
process.env.PLATFORM_URL = `http://127.0.0.1:${JWKS_PORT}`;
const { adminDb } = await import('@/lib/supabase/admin');
const { env } = await import('@/lib/env');
const { publicJwk, signCreatorToken } = await import('@/lib/platform-tokens');
const { createTemplate } = await import('@/lib/services/templates');
const { createHostedSpriteOps, HOSTED_RUN, listToolsOver } = await import('@/lib/hosted-sprite');
const hosted = await import('@/lib/services/hosted-mcp');

const runtimes = process.argv.slice(2).length ? process.argv.slice(2) : ['python', 'node'];
const db = adminDb();
const ops = createHostedSpriteOps();
const client = new SpritesClient(env.spritesToken);
const results: { check: string; pass: boolean; detail: string }[] = [];
const record = (check: string, pass: boolean, detail: string) => {
  results.push({ check, pass, detail: detail.slice(0, 300) });
  console.log(`${pass ? '✓' : '✗'} ${check}${detail ? `：${detail.slice(0, 200)}` : ''}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clean = (s: string) => s.split('\n').filter((l) => !/\.bashrc: line \d+: bind: warning/.test(l)).join('\n').trim();

async function sh(sprite: Sprite, cmd: string): Promise<{ code: number; out: string }> {
  try {
    const r = await sprite.execFile('bash', ['-lc', cmd]);
    return { code: 0, out: clean(`${r.stdout ?? ''}${r.stderr ?? ''}`) };
  } catch (e) {
    const err = e as { exitCode?: number; stdout?: unknown; stderr?: unknown; message?: string };
    return { code: err.exitCode ?? 1, out: clean(`${err.stdout ?? ''}${err.stderr ?? ''}${err.message ?? ''}`) };
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

async function callEcho(spriteUrl: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const token = signCreatorToken(
    { iss: env.platformUrl, aud: `${spriteUrl}/mcp`, sub: 'probe', project_id: 'probe', template_id: null }, env.mcpSigningKey,
  );
  const res = await fetch(`${spriteUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'x-agenthub-token': token, authorization: `Bearer ${env.spritesToken}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: args } }),
  });
  const text = await res.text();
  const json = JSON.parse(text.trim().startsWith('{') ? text : text.split('\n').find((l) => l.startsWith('data:'))!.slice(5));
  const result = json.result;
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}

/** 以 Sprite 帳號起一個只回測試公鑰的 JWKS 服務（127.0.0.1，只有 Sprite 內部連得到） */
async function startJwks(sprite: Sprite): Promise<void> {
  const body = Buffer.from(JSON.stringify({ keys: [publicJwk(process.env.MCP_SIGNING_KEY!)] })).toString('base64');
  await sh(sprite, `mkdir -p /tmp/agenthub-probe-jwks/.well-known && printf '%s' '${body}' | base64 -d > /tmp/agenthub-probe-jwks/.well-known/jwks.json`);
  const logs = await sprite.createService('jwks', {
    cmd: 'bash', args: ['-lc', `exec python3 -m http.server ${JWKS_PORT} --bind 127.0.0.1 --directory /tmp/agenthub-probe-jwks`],
  }, '2s');
  await logs.processAll(() => {});
}

async function probe(runtime: string, creatorId: string): Promise<void> {
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
    v = await hosted.syncVersion(db, version.id, ops);
    await startJwks(await client.getSprite(v.sprite_name!));
    const started = Date.now();
    while (v.status === 'deploying') {
      await sleep(5000);
      v = await hosted.syncVersion(db, version.id, ops);
      process.stdout.write(`  ${Math.round((Date.now() - started) / 1000)}s ${v.status} ${v.log_tail.split('\n').at(-1)}\n`);
    }
    record(`${runtime}：部署成功`, v.status === 'ready', `${v.status} ${Math.round((Date.now() - started) / 1000)}s\n${v.status === 'ready' ? '' : v.log_tail}`);
    if (v.status !== 'ready') return;
    record(`${runtime}：工具清單含 echo`, (v.tools as { name: string }[]).some((x) => x.name === 'echo'), JSON.stringify(v.tools));

    const sprite = await client.getSprite(v.sprite_name!);
    const deploy = await sh(sprite, asMcp('cat /srv/agenthub-mcp/deploy/deploy.sh'));
    record(`${runtime}：mcp 讀不到部署腳本（下載網址）`, deploy.code !== 0 && !deploy.out.includes('curl'), deploy.out);
    const sock = await sh(sprite, asMcp('curl -s --max-time 5 --unix-socket /.sprite/api.sock http://sprite/v1/services'));
    record(`${runtime}：mcp 碰不到 Sprite 內部 API`, sock.code !== 0 || !sock.out.includes('"name"'), sock.out);
    const write = await sh(sprite, asMcp('echo X=1 >> /srv/agenthub-mcp/env.sh'));
    record(`${runtime}：mcp 改不了 env.sh`, write.code !== 0, write.out);
    const sudo = await sh(sprite, asMcp('sudo -n true'));
    record(`${runtime}：mcp 沒有 sudo`, sudo.code !== 0, sudo.out);

    const first = await callEcho(v.sprite_url!, { text: 'hi', show_headers: true, env_name: 'PROBE_KEY' });
    const headers = (first.headers as string[]) ?? [];
    record(`${runtime}：經 Fly 呼叫成功`, first.text === 'hi', JSON.stringify(first));
    record(`${runtime}：Authorization 沒有到達程式`, headers.length > 0 && !headers.includes('authorization'), headers.join(','));
    record(`${runtime}：設定金鑰前 PROBE_KEY 不存在`, first.env_present === false, JSON.stringify(first));

    await hosted.setHostedSecrets(db, creatorId, t.id, 'fin', { PROBE_KEY: 'v1' }, ops);
    // 版本還是 ready，setHostedSecrets 會套用並重啟；等程式重新起來
    let after: Record<string, unknown> = {};
    for (let i = 0; i < 12; i++) {
      try {
        after = await callEcho(v.sprite_url!, { text: 'hi', env_name: 'PROBE_KEY' });
        if (after.env_present === true) break;
      } catch {
        // 重啟中
      }
      await sleep(2500);
    }
    record(`${runtime}：金鑰更新後重啟生效`, after.env_present === true, JSON.stringify(after));

    const tools = await listToolsOver(fetch, `${v.sprite_url}/mcp`, {
      'x-agenthub-token': 'not-a-token', authorization: `Bearer ${env.spritesToken}`,
    }).then(() => 'accepted', (e: Error) => e.message);
    record(`${runtime}：沒有有效通行證被程式拒絕`, tools.includes('401'), tools);
  } finally {
    const retired = await hosted.retireVersion(db, creatorId, version.id, ops).catch((e: Error) => e);
    record(`${runtime}：下架並刪除 Sprite`, !(retired instanceof Error) && retired.status === 'retired', retired instanceof Error ? retired.message : '');
    await db.from('agent_templates').delete().eq('id', t.id);
    await db.storage.from('mcp-bundles').remove([v.bundle_path]);
  }
}

const { data: user, error } = await db.auth.admin.createUser({ email: `probe-hosted-${randomUUID().slice(0, 8)}@test.local`, password: randomUUID(), email_confirm: true });
if (error) throw error;
try {
  for (const r of runtimes) await probe(r, user.user.id);
} finally {
  await db.auth.admin.deleteUser(user.user.id);
  const left = await client.listSprites({ prefix: 'agenthub-mcp-' });
  record('沒有殘留的 agenthub-mcp- Sprite', left.sprites.length === 0, left.sprites.map((s) => s.name).join(','));
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} 通過`);
process.exit(failed.length ? 1 : 0);
