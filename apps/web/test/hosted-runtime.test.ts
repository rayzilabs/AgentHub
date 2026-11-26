import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createHostedOps, deployScript, envScript, HOSTED_RUN, HOSTED_RUN_SCRIPT, HOSTED_SETUP_SCRIPT, listToolsOver,
} from '@/lib/hosted-runtime';
import { createE2bHost, E2B_TEMPLATES } from '@/lib/hosts/e2b';
import type { Machine } from '@/lib/hosts/types';
import { hostedSpriteName, type HostedVersion } from '@/lib/services/hosted-mcp';
import { fakeRuntimeHost } from './helpers';

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

describe('createHostedOps', () => {
  const version = { id: '123e4567-e89b-12d3-a456-426614174000', host: 'sprite' } as HostedVersion;
  const spriteMachine: Machine = { host: 'sprite', name: 'agenthub-mcp-123e4567e89b', url: 'https://agenthub-mcp-abc.sprites.app', token: null };
  const e2bMachine: Machine = { host: 'e2b', name: 'sbx-1', url: 'https://8080-sbx-1.e2b.app', token: 'tok-1' };
  const opsWith = (host: ReturnType<typeof fakeRuntimeHost>, fetchImpl?: typeof fetch) => createHostedOps({ hosts: () => host, fetchImpl });
  const scriptOf = (call: unknown[]) => call[1] as string;
  const envOf = (script: string) => Buffer.from(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d/.exec(script)![1], 'base64').toString();

  it('provision：以 claim 建立 mcp 機器 → setup → 寫 env.sh 與部署腳本 → 以服務 deploy 啟動，回傳機器', async () => {
    const host = fakeRuntimeHost('sprite', spriteMachine);
    const m = await opsWith(host).provision(version, { API_KEY: 'k', PORT: '8080' }, 'https://signed/bundle');
    expect(m).toEqual(spriteMachine);
    expect(host.create).toHaveBeenCalledWith('agenthub-mcp-123e4567e89b', 'mcp');
    const scripts = host.exec.mock.calls.map(scriptOf);
    expect(scripts).toHaveLength(3);
    expect(scripts[0]).toBe(HOSTED_SETUP_SCRIPT);
    // env.sh 補上此版本的對外網址；以 root 擁有、mcp 群組可讀，mcp 改不了
    expect(envOf(scripts[1])).toBe("API_KEY='k'\nPORT='8080'\nAGENTHUB_MCP_URL='https://agenthub-mcp-abc.sprites.app/mcp'\n");
    expect(scripts[1]).toContain('sudo chown root:mcp /srv/agenthub-mcp/env.sh.new');
    expect(scripts[1]).toContain('sudo chmod 440 /srv/agenthub-mcp/env.sh.new');
    // 部署腳本（含一次性下載網址）只寫在 deploy/；先寫暫存檔再 mv：不改寫部署服務正在讀的那個檔
    expect(scripts[2]).toContain('> /srv/agenthub-mcp/deploy/deploy.sh.tmp');
    expect(scripts[2]).toContain('mv -f /srv/agenthub-mcp/deploy/deploy.sh.tmp /srv/agenthub-mcp/deploy/deploy.sh');
    expect(host.startService).toHaveBeenCalledWith(spriteMachine, { name: 'deploy', cmd: 'bash', args: ['/srv/agenthub-mcp/deploy/deploy.sh'] });
  });

  it('provision 在 E2B 上：建立時逾時 15 分鐘、以 agenthub-svc 啟動 deploy 服務', async () => {
    process.env.E2B_API_KEY = 'test-e2b-key';
    const run = vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    const sbx = { sandboxId: 'sbx-new', getHost: (p: number) => `${p}-sbx-new.e2b.app`, trafficAccessToken: 'traffic-tok', commands: { run } };
    const sdk = { create: vi.fn().mockResolvedValue(sbx), connect: vi.fn().mockResolvedValue(sbx) };
    const ops = createHostedOps({ hosts: () => createE2bHost(sdk as never) });
    const m = await ops.provision({ ...version, host: 'e2b' }, { PORT: '8080' }, 'https://signed/bundle');
    expect(m).toEqual({ host: 'e2b', name: 'sbx-new', url: 'https://8080-sbx-new.e2b.app', token: 'traffic-tok' });
    expect(sdk.create).toHaveBeenCalledTimes(1);
    expect(sdk.create.mock.calls[0][0]).toBe(E2B_TEMPLATES.mcp);
    expect(sdk.create.mock.calls[0][1]).toMatchObject({
      timeoutMs: 15 * 60_000, metadata: { app: 'agenthub', kind: 'mcp', claim: 'agenthub-mcp-123e4567e89b' },
    });
    const cmds = run.mock.calls.map((c) => c[0] as string);
    expect(cmds).toContain(`sudo -n setsid -f agenthub-svc 'deploy' 'bash' '/srv/agenthub-mcp/deploy/deploy.sh'`);
    // env.sh 的網址是沙盒的對外網址
    const env = Buffer.from("PORT='8080'\nAGENTHUB_MCP_URL='https://8080-sbx-new.e2b.app/mcp'\n").toString('base64');
    expect(cmds.some((c) => c.includes('env.sh.new') && c.includes(env))).toBe(true);
  });

  it('readState：解析 state.json 與日誌；還沒有 state 時視為安裝中', async () => {
    const read = async (stdout: string) => {
      const host = fakeRuntimeHost('e2b');
      host.exec.mockResolvedValue(stdout);
      const state = await opsWith(host).readState(e2bMachine);
      expect(host.exec.mock.calls[0][0]).toBe(e2bMachine);
      return state;
    };
    expect(await read('{"phase":"installed","start":"python server.py"}\n---agenthub-log---\nok\n'))
      .toEqual({ phase: 'installed', start: 'python server.py', log: 'ok' });
    expect(await read('{"phase":"failed","error":"安裝失敗"}\n---agenthub-log---\nE\n'))
      .toEqual({ phase: 'failed', error: '安裝失敗', log: 'E' });
    expect(await read('\n---agenthub-log---\n')).toEqual({ phase: 'installing', log: '' });
    expect(await read('{"phase":"installing"}\n---agenthub-log---\npip\n')).toEqual({ phase: 'installing', log: 'pip' });
  });

  it('startService：服務 mcp 在沙盒以 mcp 執行 start，httpPort 8080；已存在就不重建', async () => {
    const host = fakeRuntimeHost('e2b');
    host.hasService.mockResolvedValue(false);
    await opsWith(host).startService(e2bMachine, 'python server.py');
    expect(host.hasService).toHaveBeenCalledWith(e2bMachine, 'mcp');
    expect(host.startService).toHaveBeenCalledWith(e2bMachine, {
      name: 'mcp',
      cmd: 'sudo',
      args: ['-n', 'unshare', '--mount', '--propagation', 'private', '--', HOSTED_RUN, '/bin/bash', '-c', 'cd /srv/agenthub-mcp/app && exec python server.py'],
      httpPort: 8080,
    });

    // E2B 的 startService 會取代既有服務：已存在時不能呼叫（會重啟正在啟動的程式）
    const running = fakeRuntimeHost('e2b');
    await opsWith(running).startService(e2bMachine, 'python server.py');
    expect(running.startService).not.toHaveBeenCalled();
  });

  it('applyEnv：改寫 env.sh；服務已存在才重啟（部署中還沒有服務）', async () => {
    const host = fakeRuntimeHost('e2b');
    host.hasService.mockResolvedValue(false);
    await opsWith(host).applyEnv(e2bMachine, { API_KEY: 'v1' });
    expect(envOf(scriptOf(host.exec.mock.calls[0]))).toBe("API_KEY='v1'\n");
    expect(host.restartService).not.toHaveBeenCalled();

    host.hasService.mockResolvedValue(true);
    await opsWith(host).applyEnv(e2bMachine, { API_KEY: 'v2' });
    expect(host.restartService).toHaveBeenCalledWith(e2bMachine, 'mcp');
  });

  it('serviceLog、extend、destroy：交給版本所在的執行環境', async () => {
    const sprite = fakeRuntimeHost('sprite');
    const e2b = fakeRuntimeHost('e2b');
    e2b.serviceLog.mockResolvedValue('Traceback');
    e2b.extend.mockResolvedValue('paused');
    const ops = createHostedOps({ hosts: (n) => (n === 'e2b' ? e2b : sprite) });
    expect(await ops.serviceLog(e2bMachine)).toBe('Traceback');
    expect(e2b.serviceLog).toHaveBeenCalledWith(e2bMachine, 'mcp', 100);
    expect(await ops.extend(e2bMachine, 300_000)).toBe('paused');
    expect(e2b.extend).toHaveBeenCalledWith(e2bMachine, 300_000);
    await ops.destroy('e2b', 'sbx-1');
    await ops.destroy('sprite', 'agenthub-mcp-x');
    expect(e2b.destroy).toHaveBeenCalledWith('sbx-1', 'agenthub-mcp-');
    expect(sprite.destroy).toHaveBeenCalledWith('agenthub-mcp-x', 'agenthub-mcp-');
  });

  it('listTools：邊緣驗證標頭依機器而定；E2B 不送 authorization', async () => {
    const seen: Headers[] = [];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      seen.push(new Headers(init.headers));
      const body = JSON.parse(init.body as string) as { id?: number; method: string };
      if (body.id === undefined) return new Response(null, { status: 202 });
      const result = body.method === 'tools/list' ? { tools: [{ name: 'rate' }] } : {};
      return Response.json({ jsonrpc: '2.0', id: body.id, result });
    }) as unknown as typeof fetch;
    const ops = createHostedOps({ hosts: (n) => fakeRuntimeHost(n), fetchImpl: fakeFetch });

    expect(await ops.listTools(e2bMachine, 'creator')).toEqual([{ name: 'rate' }]);
    expect(seen).toHaveLength(3);
    for (const h of seen) {
      expect(h.get('x-agenthub-token')).toBe('creator');
      expect(h.get('e2b-traffic-access-token')).toBe('tok-1');
      expect(h.get('authorization')).toBeNull();
    }
    seen.length = 0;
    await ops.listTools(spriteMachine, 'creator');
    expect(seen).toHaveLength(3);
    for (const h of seen) {
      expect(h.get('authorization')).toBe('Bearer fly');
      expect(h.get('e2b-traffic-access-token')).toBeNull();
    }
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
