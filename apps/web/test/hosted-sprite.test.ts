import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createHostedSpriteOps, deployScript, envScript, HOSTED_RUN, HOSTED_RUN_SCRIPT, HOSTED_SETUP_SCRIPT, hostedSpriteName, listToolsOver,
} from '@/lib/hosted-sprite';
import type { HostedVersion } from '@/lib/services/hosted-mcp';

const SANDBOXED = `sudo -n unshare --mount --propagation private -- ${HOSTED_RUN}`;

describe('名稱與腳本', () => {
  it('Sprite 名稱取版本 id 去連字號前 12 碼', () => {
    expect(hostedSpriteName('123e4567-e89b-12d3-a456-426614174000')).toBe('agenthub-mcp-123e4567e89b');
  });

  it('setup：mcp 帳號沒有 sudo；部署目錄只有 Sprite 帳號進得去；程式目錄屬於 mcp', () => {
    const s = HOSTED_SETUP_SCRIPT;
    expect(s.startsWith('set -euo pipefail')).toBe(true);
    expect(s).toMatch(/useradd [^\n]*\bmcp\b/);
    expect(s).not.toMatch(/usermod -aG (sudo|wheel)/);
    expect(s).toContain('sudo install -d -m 700 -o "$(id -un)" -g "$(id -gn)" /srv/agenthub-mcp/deploy');
    expect(s).toContain('sudo install -d -m 700 -o mcp -g mcp /srv/agenthub-mcp/app');
    expect(s).toContain('sudo install -d -m 755 -o root -g root /srv/agenthub-mcp');
    expect(s).toContain(`sudo chown root:root ${HOSTED_RUN}`);
    expect(s).toContain(`sudo chmod 755 ${HOSTED_RUN}`);
    // sudo 會重設 PATH；記下 Sprite 帳號的 PATH（/.sprite/languages 底下的 node、python）
    // /.sprite/bin 的 node／npm 包裝腳本會寫 /etc/profile.d/languages_env，mcp 沒權限；真實目錄放最前面，不經過包裝
    expect(s).toContain("node -e 'process.stdout.write(process.execPath)'");
    expect(s).toContain('python3 -c \'import sys; print(sys.executable, end="")\'');
    expect(s).toContain(`printf '%s' "$langs:$PATH" | sudo tee /srv/agenthub-mcp/path >/dev/null`);
  });

  it('agenthub-mcp-run：清環境、遮住 Sprite API、降權成 mcp 後才讀金鑰', () => {
    const s = HOSTED_RUN_SCRIPT;
    expect(s).toContain('PATH=/usr/sbin:/usr/bin:/sbin:/bin; export PATH');
    expect(s).toContain('unset LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT');
    expect(s).toContain('/usr/bin/mount --bind /dev/null /.sprite/api.sock');
    expect(s).toContain('/usr/bin/setpriv --reuid=mcp --regid=mcp --init-groups --inh-caps=-all');
    expect(s).toContain('/usr/bin/env -i');
    expect(s).toContain('/srv/agenthub-mcp/path');
    // 只在獨立的掛載命名空間裡執行，避免把 bind 套到整台 Sprite
    expect(s).toContain('/proc/1/ns/mnt');
    // 金鑰檔在降權之後才讀：以 root 執行 mcp 能影響的檔案會變成提權
    const drop = s.indexOf('setpriv');
    expect(s.indexOf('. /srv/agenthub-mcp/env.sh')).toBeGreaterThan(drop);
    expect(s).toContain('set -a');
    // 呼叫端的工作目錄（Sprite 帳號的家目錄）mcp 進不去，pyenv 的 shim 會失敗；先切到程式目錄
    expect(s).toContain("cd /srv/agenthub-mcp/app || cd /;");
  });

  it('部署腳本：下載與解壓都在沙盒外的私有目錄；創作者的檔案只在沙盒裡處理；全程有時限', () => {
    const s = deployScript("https://x.test/bundle?token=a'b");
    expect(s).toContain("'https://x.test/bundle?token=a'\\''b'");
    expect(s).toContain('curl -fsSL');
    expect(s).toContain('/srv/agenthub-mcp/deploy/bundle.zip');
    expect(s).toContain('timeout 540');
    expect(s).toContain('/srv/agenthub-mcp/deploy/state.json');
    expect(s).toContain('/srv/agenthub-mcp/deploy/log.txt');
    // 解壓、讀 mcp.json、安裝都以 mcp 在沙盒執行
    expect(s).toMatch(new RegExp(`${SANDBOXED.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} [^\\n]*zipfile`));
    expect(s).toContain(`${SANDBOXED} /bin/sh -c`);
    expect(s).toContain('python3 -m venv .venv');
    expect(s).toContain('.venv/bin/pip install -r "$1"');
    expect(s).toContain('npm ci || npm install');
    // 安裝不能以 Sprite 帳號直接執行
    expect(s.split('\n').filter((l) => /pip install|npm (ci|install)/.test(l)).every((l) => l.includes(SANDBOXED))).toBe(true);
    // 跑完停在這裡：服務結束會被重啟，不要重新部署
    expect(s).toContain('exec sleep infinity');
  });

  it('env.sh：每行一個、單引號跳脫正確', () => {
    expect(envScript({ API_KEY: "a'b", PORT: '8080' })).toBe("API_KEY='a'\\''b'\nPORT='8080'\n");
  });
});

describe('createHostedSpriteOps', () => {
  function fakeClient() {
    const calls: string[] = [];
    const scripts: string[] = [];
    const sprite = {
      url: 'https://agenthub-mcp-abc.sprites.app',
      execFile: async (_cmd: string, args: string[]) => {
        scripts.push(args[1]);
        const s = args[1];
        calls.push(s.includes('env.sh.new') ? 'env' : s.includes('deploy/deploy.sh') ? 'script' : s.startsWith('set -euo pipefail') ? 'setup' : 'exec');
        return { stdout: '' };
      },
      createService: async (name: string, config: { cmd: string; args?: string[]; httpPort?: number }) => {
        calls.push(`create:${name}:${config.cmd}:${(config.args ?? []).join(' ')}:${config.httpPort ?? ''}`);
        return { processAll: async () => {} };
      },
      getService: async (name: string) => {
        calls.push(`get:${name}`);
        throw Object.assign(new Error('service not found'), { statusCode: 404 });
      },
      restartService: async (name: string) => { calls.push(`restart:${name}`); return { processAll: async () => {} }; },
    };
    const client = {
      getSprite: async (name: string) => { calls.push(`get-sprite:${name}`); throw Object.assign(new Error('sprite not found'), { statusCode: 404 }); },
      createSprite: async (name: string, opts: unknown) => { calls.push(`create-sprite:${name}:${JSON.stringify(opts)}`); return sprite; },
      deleteSprite: async (name: string) => { calls.push(`delete-sprite:${name}`); },
    };
    return { client, calls, scripts, sprite };
  }

  const version = { id: '123e4567-e89b-12d3-a456-426614174000' } as HostedVersion;

  it('provision：建立 Sprite → setup → 寫 env.sh 與部署腳本 → 以服務 deploy 啟動', async () => {
    const { client, calls, scripts } = fakeClient();
    const ops = createHostedSpriteOps({ client: client as never, spritesToken: 't' });
    const out = await ops.provision(version, { API_KEY: 'k', PORT: '8080' }, 'https://signed/bundle');
    expect(out).toEqual({ spriteName: 'agenthub-mcp-123e4567e89b', spriteUrl: 'https://agenthub-mcp-abc.sprites.app' });
    expect(calls).toEqual([
      'get-sprite:agenthub-mcp-123e4567e89b',
      'create-sprite:agenthub-mcp-123e4567e89b:{"urlSettings":{"auth":"sprite"}}',
      'setup', 'env', 'script',
      'create:deploy:bash:/srv/agenthub-mcp/deploy/deploy.sh:',
    ]);
    // env.sh 補上此版本的對外網址；以 root 擁有、mcp 群組可讀，mcp 改不了
    const envCmd = scripts[1];
    const b64 = /printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d/.exec(envCmd)![1];
    expect(Buffer.from(b64, 'base64').toString()).toBe(
      "API_KEY='k'\nPORT='8080'\nAGENTHUB_MCP_URL='https://agenthub-mcp-abc.sprites.app/mcp'\n",
    );
    expect(envCmd).toContain('sudo chown root:mcp /srv/agenthub-mcp/env.sh.new');
    expect(envCmd).toContain('sudo chmod 440 /srv/agenthub-mcp/env.sh.new');
    // 部署腳本（含一次性下載網址）只寫在 deploy/
    // 先寫暫存檔再 mv：不改寫部署服務正在讀的那個檔
    expect(scripts[2]).toContain('> /srv/agenthub-mcp/deploy/deploy.sh.tmp');
    expect(scripts[2]).toContain('mv -f /srv/agenthub-mcp/deploy/deploy.sh.tmp /srv/agenthub-mcp/deploy/deploy.sh');
  });

  it('readState：解析 state.json 與日誌；還沒有 state 時視為安裝中', async () => {
    const make = (stdout: string) => ({ getSprite: async () => ({ execFile: async () => ({ stdout }) }) });
    const read = (stdout: string) => createHostedSpriteOps({ client: make(stdout) as never, spritesToken: 't' }).readState('agenthub-mcp-x');
    expect(await read('{"phase":"installed","start":"python server.py"}\n---agenthub-log---\nok\n'))
      .toEqual({ phase: 'installed', start: 'python server.py', log: 'ok' });
    expect(await read('{"phase":"failed","error":"安裝失敗"}\n---agenthub-log---\nE\n'))
      .toEqual({ phase: 'failed', error: '安裝失敗', log: 'E' });
    expect(await read('\n---agenthub-log---\n')).toEqual({ phase: 'installing', log: '' });
    expect(await read('{"phase":"installing"}\n---agenthub-log---\npip\n')).toEqual({ phase: 'installing', log: 'pip' });
  });

  it('startService：服務 mcp 在沙盒以 mcp 執行 start，httpPort 8080；已存在就不重建', async () => {
    const { client, calls } = fakeClient();
    client.getSprite = (async () => (await client.createSprite('x', {}))) as never;
    const ops = createHostedSpriteOps({ client: client as never, spritesToken: 't' });
    await ops.startService('agenthub-mcp-x', 'python server.py');
    expect(calls.at(-1)).toBe(
      `create:mcp:sudo:-n unshare --mount --propagation private -- ${HOSTED_RUN} /bin/bash -c cd /srv/agenthub-mcp/app && exec python server.py:8080`,
    );

    const second = fakeClient();
    const existing = { ...second.sprite, getService: async () => ({ name: 'mcp', state: { status: 'running' } }) };
    const ops2 = createHostedSpriteOps({ client: { getSprite: async () => existing } as never, spritesToken: 't' });
    await ops2.startService('agenthub-mcp-x', 'python server.py');
    expect(second.calls.filter((c) => c.startsWith('create:'))).toEqual([]);
  });

  it('applyEnv：改寫 env.sh；服務已存在才重啟（部署中還沒有服務）；destroy 只刪 agenthub- 開頭的 Sprite', async () => {
    const { client, calls, sprite } = fakeClient();
    client.getSprite = (async () => sprite) as never;
    const ops = createHostedSpriteOps({ client: client as never, spritesToken: 't' });
    await ops.applyEnv('agenthub-mcp-x', { API_KEY: 'v1' });
    expect(calls.slice(-2)).toEqual(['env', 'get:mcp']);

    const running = { ...sprite, getService: async (name: string) => { calls.push(`get:${name}`); return { name }; } };
    client.getSprite = (async () => running) as never;
    await ops.applyEnv('agenthub-mcp-x', { API_KEY: 'v2' });
    expect(calls.slice(-3)).toEqual(['env', 'get:mcp', 'restart:mcp']);
    await ops.destroy('agenthub-mcp-x');
    expect(calls.at(-1)).toBe('delete-sprite:agenthub-mcp-x');
    await expect(ops.destroy('other')).rejects.toThrow('拒絕刪除');
  });
});

describe('serviceLog', () => {
  it('取 mcp 服務最後 100 行的 stdout／stderr', async () => {
    const seen: unknown[] = [];
    const sprite = {
      getServiceLogs: async (name: string, opts: unknown) => {
        seen.push([name, opts]);
        return {
          processAll: async (fn: (e: { type: string; data?: string }) => void) => {
            for (const e of [{ type: 'started' }, { type: 'stdout', data: 'booting\n' }, { type: 'stderr', data: 'Traceback\n' }, { type: 'exit' }]) fn(e);
          },
        };
      },
    };
    const ops = createHostedSpriteOps({ client: { getSprite: async () => sprite } as never, spritesToken: 't' });
    expect(await ops.serviceLog('agenthub-mcp-x')).toBe('booting\nTraceback');
    expect(seen).toEqual([['mcp', { lines: 100, duration: '1s' }]]);
  });
});

describe('listToolsOver', () => {
  let server: Server;
  let base: string;
  let mode: 'json' | 'sse' = 'json';
  const seen: { headers: IncomingHttpHeaders; body: { method: string; id?: number } }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        seen.push({ headers: req.headers, body });
        if (body.method === 'notifications/initialized') { res.writeHead(202).end(); return; }
        const result = body.method === 'initialize'
          ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'x', version: '1' } }
          : { tools: [{ name: 'rate', description: '匯率', inputSchema: {} }] };
        const msg = JSON.stringify({ jsonrpc: '2.0', id: body.id, result });
        const headers: Record<string, string> = body.method === 'initialize' ? { 'mcp-session-id': 's1' } : {};
        if (mode === 'sse') {
          res.writeHead(200, { ...headers, 'content-type': 'text/event-stream' });
          res.end(`event: message\ndata: ${msg}\n\n`);
        } else {
          res.writeHead(200, { ...headers, 'content-type': 'application/json' });
          res.end(msg);
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

  it.each(['json', 'sse'] as const)('initialize → initialized → tools/list，帶 session 與兩個通行證（%s）', async (m) => {
    mode = m;
    seen.length = 0;
    const tools = await listToolsOver(fetch, `${base}/mcp`, { 'x-agenthub-token': 'creator', authorization: 'Bearer sprites' });
    expect(tools).toEqual([{ name: 'rate', description: '匯率' }]);
    expect(seen.map((s) => s.body.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
    expect(seen[0].headers['mcp-session-id']).toBeUndefined();
    expect(seen[1].headers['mcp-session-id']).toBe('s1');
    expect(seen[2].headers['mcp-session-id']).toBe('s1');
    for (const s of seen) {
      expect(s.headers['x-agenthub-token']).toBe('creator');
      expect(s.headers.authorization).toBe('Bearer sprites');
    }
  });

  it('不跟隨轉址：帶著 Sprites token 的請求不會被導到別的網址', async () => {
    const hits: string[] = [];
    const elsewhere = createServer((req, res) => { hits.push(req.headers.authorization ?? ''); res.end('{}'); });
    await new Promise<void>((r) => elsewhere.listen(0, '127.0.0.1', r));
    const target = `http://127.0.0.1:${(elsewhere.address() as AddressInfo).port}/mcp`;
    const redirector = createServer((_req, res) => { res.writeHead(307, { location: target }).end(); });
    await new Promise<void>((r) => redirector.listen(0, '127.0.0.1', r));
    try {
      await expect(listToolsOver(fetch, `http://127.0.0.1:${(redirector.address() as AddressInfo).port}/mcp`, { authorization: 'Bearer sprites' }))
        .rejects.toThrow();
      expect(hits).toEqual([]);
    } finally {
      elsewhere.close();
      redirector.close();
    }
  });

  it('程式回錯誤狀態：丟出含狀態碼的錯誤', async () => {
    const down = (async () => new Response('down', { status: 502 })) as typeof fetch;
    await expect(listToolsOver(down, `${base}/mcp`, {}))
      .rejects.toThrow('502');
  });
});
