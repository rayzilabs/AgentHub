import { APIError, type Sprite } from '@fly/sprites';
import { describe, expect, it, vi } from 'vitest';
import { createSpriteHost, errorText, isNotFound, retryTransient } from '@/lib/hosts/sprite';
import type { Machine } from '@/lib/hosts/types';

const machine: Machine = { host: 'sprite', name: 'agenthub-p1', url: 'https://s.example', token: null };

describe('isNotFound', () => {
  it('依 API 狀態碼判斷，不因訊息裡的 404（例如 UUID）誤判', () => {
    expect(isNotFound(new APIError('sprite not found', { statusCode: 404 }))).toBe(true);
    expect(isNotFound(new APIError('agenthub-1404abcd 刪除失敗', { statusCode: 500 }))).toBe(false);
    expect(isNotFound(new APIError('not found upstream', { statusCode: 502 }))).toBe(false);
    expect(isNotFound(new Error('agenthub-0404-aaaa failed'))).toBe(false);
    expect(isNotFound(new Error('Sprite not found'))).toBe(true);
    expect(isNotFound(new Error('notfound'))).toBe(false);
  });
});

describe('errorText', () => {
  it('APIError 帶錯誤物件時取出 API 訊息與狀態碼，不顯示 [object Object]', () => {
    const e = new APIError('[object Object]', { statusCode: 500, errorCode: { code: 'internal_error', message: 'Internal server error.' } as never });
    expect(errorText(e)).toBe('Sprites API 500：Internal server error.');
    expect(errorText(new APIError('sprite not found', { statusCode: 404 }))).toBe('Sprites API 404：sprite not found');
    expect(errorText(new Error('一般錯誤'))).toBe('一般錯誤');
    expect(errorText('字串')).toBe('字串');
  });
});

describe('retryTransient', () => {
  it('Sprites API 5xx 時重試，成功就回傳', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new APIError('x', { statusCode: 500 }))
      .mockRejectedValueOnce(new APIError('x', { statusCode: 503 }))
      .mockResolvedValue('ok');
    await expect(retryTransient(fn, 0)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('4xx 與一般錯誤不重試', async () => {
    const notFound = vi.fn().mockRejectedValue(new APIError('nope', { statusCode: 404 }));
    await expect(retryTransient(notFound, 0)).rejects.toThrow('nope');
    expect(notFound).toHaveBeenCalledTimes(1);
    const plain = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(retryTransient(plain, 0)).rejects.toThrow('boom');
    expect(plain).toHaveBeenCalledTimes(1);
  });

  it('連續失敗到上限就丟出最後的錯誤', async () => {
    const fn = vi.fn().mockRejectedValue(new APIError('down', { statusCode: 500 }));
    await expect(retryTransient(fn, 0, 3)).rejects.toThrow('down');
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe('createSpriteHost', () => {
  it('edgeHeaders 帶 Fly token；extend 回 running 不呼叫 API', async () => {
    vi.stubEnv('FLY_SPRITES_TOKEN', 'fly-tok');
    const client = { getSprite: vi.fn(), createSprite: vi.fn(), deleteSprite: vi.fn() };
    const host = createSpriteHost(client);
    expect(host.name).toBe('sprite');
    expect(host.edgeHeaders(machine)).toEqual({ authorization: 'Bearer fly-tok' });
    await expect(host.extend(machine, 60_000)).resolves.toBe('running');
    expect(client.getSprite).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  function fakeHost(existing: { cmd: string; args: string[] } | null) {
    const calls: string[] = [];
    let config: unknown;
    const stream = (label: string) => ({ processAll: async () => { calls.push(`${label}:drained`); } });
    const sprite = {
      getService: async () => {
        if (!existing) throw new Error('Service not found: {"error":"service not found"}');
        return { name: 'runtime', ...existing, needs: [] };
      },
      deleteService: async () => { calls.push('delete'); },
      createService: async (_n: string, c: unknown) => { calls.push('create'); config = c; return stream('create'); },
      restartService: async () => { calls.push('restart'); return stream('restart'); },
    } as unknown as Sprite;
    const client = { getSprite: async () => sprite, createSprite: vi.fn(), deleteSprite: vi.fn() };
    return { host: createSpriteHost(client), calls, config: () => config };
  }
  const spec = { name: 'runtime', cmd: '/usr/local/bin/agenthub-runtime', args: ['/home/sprite/agenthub'], httpPort: 8080 };

  it('startService 設定不同時先刪再建，再重啟；兩個 log 串流都讀完', async () => {
    const { host, calls, config } = fakeHost({ cmd: 'node', args: ['/home/sprite/agenthub/main.js'] });
    await host.startService(machine, spec);
    expect(calls).toEqual(['delete', 'create', 'create:drained', 'restart', 'restart:drained']);
    expect(config()).toEqual({ cmd: spec.cmd, args: spec.args, httpPort: 8080 });
  });

  it('startService 設定相同時不刪除、重啟載入新檔；還沒有服務時只建立、不重啟', async () => {
    const same = fakeHost({ cmd: spec.cmd, args: spec.args });
    await same.host.startService(machine, spec);
    expect(same.calls).toEqual(['create', 'create:drained', 'restart', 'restart:drained']);
    // 新建立的服務已經在跑：再重啟會中斷正在跑的程式（例如代管 MCP 的部署）
    const none = fakeHost(null);
    await none.host.startService(machine, spec);
    expect(none.calls).toEqual(['create', 'create:drained']);
    expect(await none.host.hasService(machine, 'runtime')).toBe(false);
  });

  it('status：存在回 running，404 回 gone', async () => {
    const ok = createSpriteHost({ getSprite: async () => ({}) as Sprite, createSprite: vi.fn(), deleteSprite: vi.fn() });
    expect(await ok.status(machine)).toBe('running');
    const gone = createSpriteHost({ getSprite: async () => { throw new APIError('nf', { statusCode: 404 }); }, createSprite: vi.fn(), deleteSprite: vi.fn() });
    expect(await gone.status(machine)).toBe('gone');
  });

  it('destroy 拒絕前綴不符的名稱，已不在算成功', async () => {
    const deleteSprite = vi.fn().mockRejectedValue(new APIError('nf', { statusCode: 404 }));
    const host = createSpriteHost({ getSprite: vi.fn(), createSprite: vi.fn(), deleteSprite });
    await expect(host.destroy('other-p1', 'agenthub-')).rejects.toThrow('拒絕刪除');
    expect(deleteSprite).not.toHaveBeenCalled();
    await expect(host.destroy('agenthub-p1', 'agenthub-')).resolves.toBeUndefined();
  });

  it('writeFile 以根目錄的檔案系統寫入絕對路徑；exec 有 timeoutMs 時傳給 SDK', async () => {
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const filesystem = vi.fn(() => ({ writeFile }));
    const execFile = vi.fn().mockResolvedValue({ stdout: 'out', stderr: '' });
    const client = { getSprite: async () => ({ filesystem, execFile }) as unknown as Sprite, createSprite: vi.fn(), deleteSprite: vi.fn() };
    const host = createSpriteHost(client);

    await host.writeFile(machine, '/home/sprite/agenthub/.env', 'A="1"\n');
    expect(filesystem).toHaveBeenCalledWith('/');
    expect(writeFile).toHaveBeenCalledWith('/home/sprite/agenthub/.env', 'A="1"\n');

    expect(await host.exec(machine, 'echo hi')).toBe('out');
    expect(execFile).toHaveBeenLastCalledWith('bash', ['-lc', 'echo hi'], undefined);
    await host.exec(machine, 'long', { timeoutMs: 600_000 });
    expect(execFile).toHaveBeenLastCalledWith('bash', ['-lc', 'long'], { timeout: 600_000 });
  });

  it('create 沿用或建立 Sprite，回傳 Machine（token 為 null）', async () => {
    const client = { getSprite: async () => ({ url: 'https://x.example' }) as Sprite, createSprite: vi.fn(), deleteSprite: vi.fn() };
    const m = await createSpriteHost(client).create('agenthub-p1', 'project');
    expect(m).toEqual({ host: 'sprite', name: 'agenthub-p1', url: 'https://x.example', token: null });
  });
});
