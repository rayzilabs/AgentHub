import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { checkSandboxUser, createSandbox, killArgv, runInSandbox, sandboxEnv, sudoArgv } from '../src/sandbox';

afterEach(() => {
  delete process.env.AGENTHUB_FAKE_SECRET;
});

describe('sandboxEnv', () => {
  it('只保留白名單與 extraEnv，平台金鑰之類的變數不會帶進去', () => {
    process.env.AGENTHUB_FAKE_SECRET = 'leak';
    const env = sandboxEnv('agent', { MCP_KEY: 'k' });
    expect(env.AGENTHUB_FAKE_SECRET).toBeUndefined();
    expect(env.MCP_KEY).toBe('k');
    expect(env.HOME).toBe('/home/agent');
    expect(env.PATH).toBeTruthy();
  });
});

describe('sudoArgv / killArgv', () => {
  it('以指定帳號執行：保留呼叫端給的環境變數、umask 002，祕密不放進指令參數', () => {
    expect(sudoArgv('agent', ['bash', '-c', 'ls'])).toEqual([
      'sudo', '-n', '-E', '-u', 'agent', '--', 'sh', '-c', 'umask 002; exec "$@"', 'sandbox', 'bash', '-c', 'ls',
    ]);
  });

  it('以沙盒帳號終止整個程序群組', () => {
    expect(killArgv('agent', 1234)).toEqual(['sudo', '-n', '-u', 'agent', '--', 'kill', '-KILL', '--', '-1234']);
  });
});

describe('createSandbox（本機模式）', () => {
  it('執行的指令看不到 runtime 的環境變數', async () => {
    process.env.AGENTHUB_FAKE_SECRET = 'leak';
    const r = await runInSandbox(createSandbox(), ['bash', '-c', 'echo "[$AGENTHUB_FAKE_SECRET]"'], { cwd: os.tmpdir() });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('[]');
  });

  it('stdin 會傳進去', async () => {
    const r = await runInSandbox(createSandbox(), ['bash', '-c', 'cat'], { cwd: os.tmpdir(), input: '你好' });
    expect(r.stdout).toBe('你好');
  });

  it('command：本機模式不改寫指令，環境變數一樣清空', () => {
    process.env.AGENTHUB_FAKE_SECRET = 'leak';
    const c = createSandbox().command(['node', 'server.js'], { MCP_KEY: 'k' });
    expect(c.command).toBe('node');
    expect(c.args).toEqual(['server.js']);
    expect(c.env.MCP_KEY).toBe('k');
    expect(c.env.AGENTHUB_FAKE_SECRET).toBeUndefined();
  });

  it('command：指定帳號時改寫成 sudo', () => {
    const c = createSandbox('agent').command(['node', 'server.js']);
    expect(c.command).toBe('sudo');
    expect(c.args).toEqual(['-n', '-E', '-u', 'agent', '--', 'sh', '-c', 'umask 002; exec "$@"', 'sandbox', 'node', 'server.js']);
  });
});

describe('checkSandboxUser', () => {
  it('帳號不存在或 sudo 不能用時回報錯誤，不丟例外', async () => {
    const r = await checkSandboxUser('agenthub-no-such-user');
    expect(r.ok).toBe(false);
  });
});
