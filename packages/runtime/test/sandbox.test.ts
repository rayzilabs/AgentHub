import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkSandboxUser, type CommandRunner, consultantUser, createSandbox, ensureConsultantSandboxes, killArgv, runInSandbox,
  SANDBOX_ADDUSER, SANDBOX_WRAPPER, sandboxEnv, sandboxUserFor, sudoArgv,
} from '../src/sandbox';

describe('consultantUser', () => {
  it('agent- 加上去掉連字號後的前 12 個小寫十六進位字元', () => {
    expect(consultantUser('5F0C2A9B-31D4-4e5f-8a9b-0c1d2e3f4a5b')).toBe('agent-5f0c2a9b31d4');
  });
});

describe('ensureConsultantSandboxes', () => {
  it('本機模式（沒有 SANDBOX_USER）：不執行任何指令', async () => {
    const calls: string[][] = [];
    await ensureConsultantSandboxes(undefined, '/workspace/agents', ['11111111-1111-1111-1111-111111111111'], async (a) => { calls.push(a); return { code: 0, stderr: '' }; });
    expect(calls).toEqual([]);
  });

  it('以 sudo 呼叫 adduser；同一個 id 在同一個程序只呼叫一次', async () => {
    const calls: string[][] = [];
    const run: CommandRunner = async (a) => { calls.push(a); return { code: 0, stderr: '' }; };
    const id = '22222222-2222-2222-2222-222222222222';
    await ensureConsultantSandboxes('agent', '/workspace/agents', [id], run);
    await ensureConsultantSandboxes('agent', '/workspace/agents', [id], run);
    expect(calls).toEqual([['sudo', '-n', SANDBOX_ADDUSER, 'agent-222222222222', `/workspace/agents/${id}`]]);
  });

  it('失敗時丟出錯誤，且下次會重試', async () => {
    const id = '33333333-3333-3333-3333-333333333333';
    await expect(ensureConsultantSandboxes('agent', '/workspace/agents', [id], async () => ({ code: 1, stderr: 'useradd: 失敗' })))
      .rejects.toThrow('useradd: 失敗');
    const calls: string[][] = [];
    await ensureConsultantSandboxes('agent', '/workspace/agents', [id], async (a) => { calls.push(a); return { code: 0, stderr: '' }; });
    expect(calls).toHaveLength(1);
  });
});

describe('sandboxUserFor', () => {
  it('Sprite 上顧問用自己的帳號；本機不設定', () => {
    expect(sandboxUserFor({ SANDBOX_USER: 'agent' }, '44444444-4444-4444-4444-444444444444')).toBe('agent-444444444444');
    expect(sandboxUserFor({}, '44444444-4444-4444-4444-444444444444')).toBeUndefined();
  });
});

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
    // sudo 會把 PATH 重設成系統預設，另外帶一份給沙盒腳本還原（node、python 在 /.sprite/languages 底下）
    expect(env.SANDBOX_PATH).toBe(env.PATH);
  });

  it('extraEnv（創作者定義的金鑰名稱）不能蓋掉或注入會影響執行的變數', () => {
    const env = sandboxEnv('agent', {
      PATH: '/evil', HOME: '/evil', SANDBOX_PATH: '/evil', LD_PRELOAD: '/evil.so', LD_LIBRARY_PATH: '/evil',
      BASH_ENV: '/evil', ENV: '/evil', IFS: 'x', SHELLOPTS: 'x', MCP_KEY: 'k',
    });
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.HOME).toBe('/home/agent');
    expect(env.SANDBOX_PATH).toBe(process.env.PATH);
    for (const k of ['LD_PRELOAD', 'LD_LIBRARY_PATH', 'BASH_ENV', 'ENV', 'IFS', 'SHELLOPTS']) expect(env[k]).toBeUndefined();
    expect(env.MCP_KEY).toBe('k');
  });

  it('本機模式不帶 SANDBOX_PATH', () => {
    expect(sandboxEnv(undefined).SANDBOX_PATH).toBeUndefined();
  });
});

describe('sudoArgv / killArgv', () => {
  it('以 root 開獨立的掛載命名空間，交給沙盒腳本蓋掉 Sprite 內部 API 再降權；祕密不放進指令參數', () => {
    expect(sudoArgv('agent', ['bash', '-c', 'ls'])).toEqual([
      'sudo', '-n', '-E', '--', 'unshare', '--mount', '--propagation', 'private', '--', SANDBOX_WRAPPER, 'agent', 'bash', '-c', 'ls',
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
    expect(c.args).toEqual(['-n', '-E', '--', 'unshare', '--mount', '--propagation', 'private', '--', SANDBOX_WRAPPER, 'agent', 'node', 'server.js']);
  });
});

describe('checkSandboxUser', () => {
  it('帳號不存在或 sudo 不能用時回報錯誤，不丟例外', async () => {
    const r = await checkSandboxUser('agenthub-no-such-user');
    expect(r.ok).toBe(false);
  });
});

