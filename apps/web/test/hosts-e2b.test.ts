import { CommandExitError, NotFoundError, SandboxNotFoundError } from 'e2b';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createE2bHost, E2B_LOCKDOWN_SCRIPT, E2B_SERVICE_SCRIPT, E2B_TEMPLATES, E2B_TIMEOUT_MS } from '@/lib/hosts/e2b';
import type { Machine } from '@/lib/hosts/types';

const machine: Machine = { host: 'e2b', name: 'sbx-1', url: 'https://8080-sbx-1.e2b.app', token: 'tok' };
const KEY = { apiKey: 'test-e2b-key' };

function setup() {
  const run = vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
  const write = vi.fn().mockResolvedValue(undefined);
  const sbx = { sandboxId: 'sbx-new', getHost: (p: number) => `${p}-sbx-new.e2b.app`, trafficAccessToken: 'traffic-tok', commands: { run }, files: { write } };
  const sdk = {
    create: vi.fn().mockResolvedValue(sbx),
    connect: vi.fn().mockResolvedValue(sbx),
    kill: vi.fn().mockResolvedValue(true),
    setTimeout: vi.fn().mockResolvedValue(undefined),
    getInfo: vi.fn(),
    list: vi.fn(),
  };
  return { sdk, run, write, host: createE2bHost(sdk as never) };
}

const pager = (items: unknown[]) => ({ hasNext: true, nextItems: vi.fn().mockImplementation(async function (this: { hasNext: boolean }) { pagerDone(this); return items; }) });
function pagerDone(p: { hasNext: boolean }) { p.hasNext = false; }

beforeEach(() => { process.env.E2B_API_KEY = 'test-e2b-key'; });

describe('create', () => {
  it('以範本、暫停／自動叫醒、私有網路與 metadata 建立，回傳機器', async () => {
    const { sdk, host } = setup();
    const m = await host.create('agenthub-p1', 'project');
    expect(sdk.create).toHaveBeenCalledWith(E2B_TEMPLATES.project, {
      ...KEY,
      timeoutMs: E2B_TIMEOUT_MS.project,
      lifecycle: { onTimeout: 'pause', autoResume: true },
      network: { allowPublicTraffic: false },
      metadata: { app: 'agenthub', kind: 'project', claim: 'agenthub-p1' },
    });
    expect(m).toEqual({ host: 'e2b', name: 'sbx-new', url: 'https://8080-sbx-new.e2b.app', token: 'traffic-tok' });
  });

  it('建立後先以 root 鎖住密碼與 /usr/local', async () => {
    const { run, host } = setup();
    await host.create('agenthub-p1', 'project');
    expect(run).toHaveBeenCalledWith(E2B_LOCKDOWN_SCRIPT, { user: 'root', timeoutMs: 120_000 });
    expect(E2B_LOCKDOWN_SCRIPT).toContain("usermod -p '*' user");
    expect(E2B_LOCKDOWN_SCRIPT).toContain('chmod -R go-w /usr/local');
  });

  it('鎖不起來就刪掉這台並丟錯', async () => {
    const { sdk, run, host } = setup();
    run.mockRejectedValueOnce(new Error('boom'));
    await expect(host.create('agenthub-p1', 'project')).rejects.toThrow('沙盒權限鎖定失敗：boom');
    expect(sdk.kill).toHaveBeenCalledWith('sbx-new', KEY);
  });

  it('mcp 用 mcp 範本與逾時', async () => {
    const { sdk, host } = setup();
    await host.create('agenthub-mcp-v1', 'mcp');
    expect(sdk.create.mock.calls[0][0]).toBe('agenthub-mcp');
    expect(sdk.create.mock.calls[0][1].timeoutMs).toBe(900_000);
  });
});

describe('destroy', () => {
  it('sandboxId 且 metadata 相符就 kill', async () => {
    const { sdk, host } = setup();
    sdk.getInfo.mockResolvedValue({ metadata: { app: 'agenthub', claim: 'agenthub-p1' } });
    await host.destroy('sbx-1', 'agenthub-');
    expect(sdk.kill).toHaveBeenCalledWith('sbx-1', KEY);
  });

  it('metadata 不符（不是本平台或前綴不符）不 kill', async () => {
    const { sdk, host } = setup();
    sdk.getInfo.mockResolvedValueOnce({ metadata: { app: 'other', claim: 'agenthub-p1' } });
    await expect(host.destroy('sbx-1', 'agenthub-')).rejects.toThrow('拒絕刪除');
    sdk.getInfo.mockResolvedValueOnce({ metadata: { app: 'agenthub', claim: 'zzz-p1' } });
    await expect(host.destroy('sbx-1', 'agenthub-')).rejects.toThrow('拒絕刪除');
    sdk.getInfo.mockResolvedValueOnce({});
    await expect(host.destroy('sbx-1', 'agenthub-')).rejects.toThrow('拒絕刪除');
    expect(sdk.kill).not.toHaveBeenCalled();
  });

  it('名稱是 claim：依 metadata 列出並全部 kill，metadata 不符的跳過', async () => {
    const { sdk, host } = setup();
    sdk.list.mockReturnValue(pager([
      { sandboxId: 'a', metadata: { app: 'agenthub', claim: 'agenthub-mcp-v1' } },
      { sandboxId: 'b', metadata: { app: 'agenthub', claim: 'agenthub-mcp-v1' } },
      { sandboxId: 'c', metadata: { app: 'other', claim: 'agenthub-mcp-v1' } },
    ]));
    await host.destroy('agenthub-mcp-v1', 'agenthub-mcp-');
    expect(sdk.list).toHaveBeenCalledWith({ ...KEY, query: { metadata: { app: 'agenthub', claim: 'agenthub-mcp-v1' } } });
    expect(sdk.kill.mock.calls.map((c) => c[0])).toEqual(['a', 'b']);
  });

  it('getInfo 丟 NotFound 或 kill 時不存在都算成功', async () => {
    const { sdk, host } = setup();
    sdk.getInfo.mockRejectedValueOnce(new SandboxNotFoundError('gone'));
    await expect(host.destroy('sbx-1', 'agenthub-')).resolves.toBeUndefined();
    expect(sdk.kill).not.toHaveBeenCalled();
    sdk.getInfo.mockResolvedValueOnce({ metadata: { app: 'agenthub', claim: 'agenthub-p1' } });
    sdk.kill.mockRejectedValueOnce(new NotFoundError('gone'));
    await expect(host.destroy('sbx-1', 'agenthub-')).resolves.toBeUndefined();
  });
});

describe('extend', () => {
  it('setTimeout 成功回 running', async () => {
    const { sdk, host } = setup();
    await expect(host.extend(machine, 300_000)).resolves.toBe('running');
    expect(sdk.setTimeout).toHaveBeenCalledWith('sbx-1', 300_000, KEY);
  });

  it('setTimeout 丟 SandboxNotFoundError 但 getInfo 是 paused：暫停不等於不見', async () => {
    const { sdk, host } = setup();
    sdk.setTimeout.mockRejectedValue(new SandboxNotFoundError('paused'));
    sdk.getInfo.mockResolvedValue({ state: 'paused' });
    await expect(host.extend(machine, 1)).resolves.toBe('paused');
  });

  it('getInfo 也 NotFound 才是 gone', async () => {
    const { sdk, host } = setup();
    sdk.setTimeout.mockRejectedValue(new SandboxNotFoundError('x'));
    sdk.getInfo.mockRejectedValue(new SandboxNotFoundError('x'));
    await expect(host.extend(machine, 1)).resolves.toBe('gone');
  });

  it('其他錯誤照丟', async () => {
    const { sdk, host } = setup();
    sdk.setTimeout.mockRejectedValue(new Error('boom'));
    await expect(host.extend(machine, 1)).rejects.toThrow('boom');
  });
});

describe('status', () => {
  it('running／paused／NotFound 對應三種', async () => {
    const { sdk, host } = setup();
    sdk.getInfo.mockResolvedValueOnce({ state: 'running' });
    await expect(host.status(machine)).resolves.toBe('running');
    sdk.getInfo.mockResolvedValueOnce({ state: 'paused' });
    await expect(host.status(machine)).resolves.toBe('paused');
    sdk.getInfo.mockRejectedValueOnce(new SandboxNotFoundError('x'));
    await expect(host.status(machine)).resolves.toBe('gone');
  });
});

describe('edgeHeaders', () => {
  it('帶通行證標頭；token 為 null 丟錯', () => {
    const { host } = setup();
    expect(host.edgeHeaders(machine)).toEqual({ 'e2b-traffic-access-token': 'tok' });
    expect(() => host.edgeHeaders({ ...machine, token: null })).toThrow('通行證');
  });
});

describe('exec / writeFile', () => {
  it('connect 後以 bash -lc 執行並回 stdout', async () => {
    const { sdk, run, host } = setup();
    run.mockResolvedValue({ stdout: 'hello\n', stderr: '', exitCode: 0 });
    await expect(host.exec(machine, "echo 'hi'")).resolves.toBe('hello\n');
    expect(sdk.connect).toHaveBeenCalledWith('sbx-1', KEY);
    expect(run).toHaveBeenCalledWith(`bash -lc 'echo '\\''hi'\\'''`, {});
  });

  it('exec 有 timeoutMs 時取代 SDK 預設的 60 秒', async () => {
    const { run, host } = setup();
    await host.exec(machine, 'long', { timeoutMs: 600_000 });
    expect(run).toHaveBeenCalledWith(`bash -lc 'long'`, { timeoutMs: 600_000 });
  });

  it('非 0 結束時錯誤訊息含 stderr', async () => {
    const { run, host } = setup();
    run.mockRejectedValue(new CommandExitError({ stdout: '', stderr: 'no such file', exitCode: 2, error: 'x' }));
    await expect(host.exec(machine, 'cat x')).rejects.toThrow('no such file');
  });

  it('writeFile 寫進沙盒', async () => {
    const { write, host } = setup();
    await host.writeFile(machine, '/home/user/a.txt', 'abc');
    expect(write).toHaveBeenCalledWith('/home/user/a.txt', 'abc');
  });
});

describe('服務', () => {
  const cmds = (run: ReturnType<typeof vi.fn>) => run.mock.calls.map((c) => c[0] as string);

  it('startService：每次安裝腳本（內容不同才替換）、先停舊的、再以 setsid -f 背景啟動並等 pid 檔', async () => {
    const { run, host } = setup();
    await host.startService(machine, { name: 'runtime', cmd: 'node', args: ['main.js', "it's"] });
    const c = cmds(run);
    expect(c).toHaveLength(4);
    expect(c[0]).toContain(E2B_SERVICE_SCRIPT);
    expect(c[0]).toContain('cmp -s /usr/local/bin/agenthub-svc.new /usr/local/bin/agenthub-svc');
    expect(c[0]).toContain('mv -f');
    expect(c[0]).toContain('chmod 755');
    expect(run.mock.calls[0][1]).toEqual({ user: 'root' });
    expect(c[1]).toBe(`sudo -n agenthub-svc --stop 'runtime'`);
    expect(c[2]).toBe(`sudo -n setsid -f agenthub-svc 'runtime' 'node' 'main.js' 'it'\\''s'`);
    expect(run.mock.calls[2][1]).toEqual({ background: true, timeoutMs: 0 });
    expect(c[3]).toContain('/run/agenthub/runtime.pid');
  });

  it('stop 失敗（找不到程序群組）要丟錯，不啟動新的', async () => {
    const { run, host } = setup();
    run.mockImplementation(async (cmd: string) => {
      if (cmd.includes('--stop')) throw new CommandExitError({ stdout: '', stderr: '停不掉服務', exitCode: 1, error: 'x' });
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    await expect(host.startService(machine, { name: 'runtime', cmd: 'node', args: [] })).rejects.toThrow('停不掉服務');
    expect(cmds(run).some((c) => c.includes('setsid -f'))).toBe(false);
  });

  it('服務腳本：以群組領頭記 pid、停止會等待並升級成 KILL、降權成 user 執行', () => {
    expect(E2B_SERVICE_SCRIPT).toContain('echo $$ > "/run/agenthub/$name.pid"');
    expect(E2B_SERVICE_SCRIPT).toContain('kill -TERM -- "-$pid" ||');
    expect(E2B_SERVICE_SCRIPT).toContain('kill -KILL -- "-$pid"');
    expect(E2B_SERVICE_SCRIPT).toContain('sudo -n -u user -H -- "$@"');
    expect(E2B_SERVICE_SCRIPT).toContain(`printf '%s\\0'`);
  });

  it('服務腳本：同名服務的停止與「停舊的、記自己的 pid」以 flock 排隊，迴圈開始前放掉鎖', () => {
    const lines = E2B_SERVICE_SCRIPT.split('\n');
    const at = (text: string) => {
      const i = lines.findIndex((l) => l.includes(text));
      expect(i, text).toBeGreaterThanOrEqual(0);
      return i;
    };
    // 鎖檔放在只有 root 進得去的目錄，沙盒帳號不能搶鎖卡住服務
    expect(E2B_SERVICE_SCRIPT).toContain('chmod 700 /var/log/agenthub /run/agenthub/locks');
    expect(E2B_SERVICE_SCRIPT).toContain('exec 9> "/run/agenthub/locks/$1.lock" && flock 9');
    // --stop 也要先拿鎖
    expect(at('lock "$2" || exit 1')).toBeLessThan(at('stop "$2"'));
    // 啟動：拿鎖 → 停舊的 → 記 pid → 放鎖 → 迴圈
    const order = ['lock "$name" || exit 1', 'stop "$name" || exit 1', 'echo $$ > "/run/agenthub/$name.pid"', 'exec 9>&-', 'while true; do'].map(at);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('服務腳本：日誌目錄 700、日誌檔 600（顧問帳號讀不到 runtime.log）', () => {
    expect(E2B_SERVICE_SCRIPT).toContain('touch "$log" && chmod 600 "$log"');
    expect(E2B_SERVICE_SCRIPT).toContain('tail -n 1000 "$log" > "$log.tmp" && chmod 600 "$log.tmp" && mv "$log.tmp" "$log"');
  });

  it('startService 拒絕不合法的服務名稱', async () => {
    const { host } = setup();
    await expect(host.startService(machine, { name: 'a; rm -rf /', cmd: 'x', args: [] })).rejects.toThrow('服務名稱');
  });

  it('serviceLog 以 root 讀 tail -n（日誌只限 root）', async () => {
    const { run, host } = setup();
    run.mockResolvedValue({ stdout: 'l1\nl2\n', stderr: '', exitCode: 0 });
    await expect(host.serviceLog(machine, 'runtime', 50)).resolves.toBe('l1\nl2');
    expect(run.mock.calls[0][0]).toContain('tail -n 50 /var/log/agenthub/runtime.log');
    expect(run.mock.calls[0][1]).toEqual({ user: 'root' });
  });

  it('hasService 依 pid 檔與程序是否存在', async () => {
    const { run, host } = setup();
    await expect(host.hasService(machine, 'runtime')).resolves.toBe(true);
    run.mockRejectedValue(new CommandExitError({ stdout: '', stderr: '', exitCode: 1, error: 'x' }));
    await expect(host.hasService(machine, 'runtime')).resolves.toBe(false);
  });

  it('restartService：先 --stop，再以 setsid -f 呼叫 --restart（不經 xargs）；沒啟動過就丟錯', async () => {
    const { run, host } = setup();
    await host.restartService(machine, 'runtime');
    const c = cmds(run);
    expect(c[1]).toBe(`sudo -n agenthub-svc --stop 'runtime'`);
    expect(c[2]).toBe(`sudo -n setsid -f agenthub-svc '--restart' 'runtime'`);
    expect(run.mock.calls[2][1]).toEqual({ background: true, timeoutMs: 0 });
    run.mockRejectedValue(new CommandExitError({ stdout: '', stderr: '', exitCode: 1, error: 'x' }));
    await expect(host.restartService(machine, 'runtime')).rejects.toThrow('尚未啟動');
  });
});
