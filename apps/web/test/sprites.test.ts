import { APIError, type Sprite } from '@fly/sprites';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '@/lib/http';
import { errorText, forwardChat, installRuntime, isNotFound, retryTransient, runtimeEnvFile, SANDBOX_ADDUSER_SCRIPT, SANDBOX_WRAPPER_SCRIPT, sandboxSetupScript, spriteName } from '@/lib/sprites';
import type { Db } from '@/lib/supabase/admin';

const body = { thread_id: 't1', text: '你好' };

function fakeFetch(steps: Array<'refuse' | number>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const step = steps[calls.length - 1];
    if (step === 'refuse') throw new TypeError('fetch failed: ECONNREFUSED');
    return new Response('stream', { status: step });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('spriteName / runtimeEnvFile', () => {
  it('Sprite 名稱帶前綴；env 檔每行 KEY="value"', () => {
    expect(spriteName('abc')).toBe('agenthub-abc');
    expect(runtimeEnvFile({ A: 'x', B: 'has "quote"' })).toBe('A="x"\nB="has \\"quote\\""\n');
  });
});

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

describe('forwardChat', () => {
  it('送到 /chat，帶 Bearer token 與 JSON body', async () => {
    const { impl, calls } = fakeFetch([200]);
    const res = await forwardChat('https://s.example', body, { token: 'tok', fetchImpl: impl, retryDelayMs: 0 });
    expect(res.status).toBe(200);
    expect(calls[0].url).toBe('https://s.example/chat');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(calls[0].init.body).toBe(JSON.stringify(body));
    expect(calls[0].init.headers).not.toHaveProperty('x-agenthub-token');
  });

  it('有資料庫通行證時放在 x-agenthub-db-token', async () => {
    const { impl, calls } = fakeFetch([200]);
    await forwardChat('https://s.example', body, { token: 'tok', dbToken: 'db1', fetchImpl: impl, retryDelayMs: 0 });
    expect((calls[0].init.headers as Record<string, string>)['x-agenthub-db-token']).toBe('db1');
  });

  it('有專案通行證時放在 x-agenthub-token', async () => {
    const { impl, calls } = fakeFetch([200]);
    await forwardChat('https://s.example', body, { token: 'tok', projectToken: 'pt', fetchImpl: impl, retryDelayMs: 0 });
    expect((calls[0].init.headers as Record<string, string>)['x-agenthub-token']).toBe('pt');
  });

  it('連線被拒或 502/503/504 時重試', async () => {
    const { impl, calls } = fakeFetch(['refuse', 503, 200]);
    const res = await forwardChat('https://s.example', body, { token: 't', fetchImpl: impl, retryDelayMs: 0 });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(3);
  });

  it('409 等其他狀態碼不重試，原樣回傳', async () => {
    const { impl, calls } = fakeFetch([409]);
    const res = await forwardChat('https://s.example', body, { token: 't', fetchImpl: impl, retryDelayMs: 0 });
    expect(res.status).toBe(409);
    expect(calls).toHaveLength(1);
  });

  it('三次都失敗：502', async () => {
    const { impl } = fakeFetch(['refuse', 'refuse', 'refuse']);
    const e = await forwardChat('https://s.example', body, { token: 't', fetchImpl: impl, retryDelayMs: 0 }).catch((err) => err);
    expect(e).toBeInstanceOf(HttpError);
    expect(e.status).toBe(502);
    expect(e.message).toContain('agent 環境無法連線');
  });
});

describe('installRuntime', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('建立服務後重新啟動，讓已存在的 Sprite 載入新的 main.js；兩個 log 串流都讀完', async () => {
    for (const k of ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'VERTEX_API_EXPRESS_MODE_KEY']) vi.stubEnv(k, 'x');
    for (const k of ['PLATFORM_URL', 'VERCEL_PROJECT_PRODUCTION_URL']) vi.stubEnv(k, '');
    const calls: string[] = [];
    const written: Record<string, string> = {};
    const logStream = (label: string) => ({ processAll: async () => { calls.push(`${label}:drained`); } });
    const sprite = {
      execFile: async (_cmd: string, args: string[]) => {
        calls.push(args[1].startsWith('printf') ? 'home' : args[1].startsWith('set -euo pipefail') ? 'setup' : 'download');
        return { stdout: '/home/sprite\n' };
      },
      filesystem: () => ({ writeFile: async (name: string, content: string) => { calls.push(`write:${name}`); written[name] = content; } }),
      createService: async (name: string, _config: unknown, duration?: string) => {
        calls.push(`create:${name}:${duration}`);
        return logStream('create');
      },
      restartService: async (name: string, duration?: string) => {
        calls.push(`restart:${name}:${duration}`);
        return logStream('restart');
      },
    } as unknown as Sprite;
    const db = {
      storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'https://signed' }, error: null }) }) },
    } as unknown as Db;

    expect(await installRuntime(db, sprite, 'p1')).toBe('/home/sprite/agenthub');
    expect(calls).toEqual([
      'home', 'download', 'write:.env', 'setup',
      'create:runtime:10s', 'create:drained',
      'restart:runtime:10s', 'restart:drained',
    ]);
    expect(written['.env']).toContain('AGENTS_ROOT="/workspace/agents"');
    expect(written['.env']).toContain('SHARED_ROOT="/workspace/shared"');
    expect(written['.env']).toContain('SANDBOX_USER="agent"');
    expect(written['.env']).toContain('PLATFORM_URL="https://agenthub-kappa-pink.vercel.app"');
  });
});

describe('sandboxSetupScript', () => {
  it('建立沒有 sudo 的 agent 帳號與工作區，收緊 runtime 目錄，搬移舊工作區', () => {
    const s = sandboxSetupScript('/home/sprite/agenthub');
    expect(s.startsWith('set -euo pipefail')).toBe(true);
    expect(s).toContain('useradd --create-home --shell /bin/bash agent');
    expect(s).not.toMatch(/usermod -aG sudo/);
    expect(s).toContain("cp -a '/home/sprite/agenthub/agents/.' /workspace/agents/");
    expect(s).toContain('chown -R "$(id -un)":workspace /workspace');
    expect(s).toContain('sudo chmod 2770 /workspace/shared');
    // 子專案 2：只有 runtime 能在 /workspace/agents 建立項目；私人 /tmp 的父目錄只有 root 能寫
    expect(s).toContain('sudo chmod 0711 /workspace/agents');
    expect(s).toContain('sudo install -d -m 711 -o root -g root /var/lib/agenthub /var/lib/agenthub/tmp');
    expect(s).toContain('/usr/local/bin/agenthub-sandbox-adduser');
    expect(s).toContain("chmod 700 '/home/sprite/agenthub'");
    expect(s).toContain("chmod 600 '/home/sprite/agenthub/.env'");
    // 沙盒腳本：蓋掉 Sprite 內部 API 再降權
    expect(s).toContain('/usr/local/bin/agenthub-sandbox');
    expect(SANDBOX_WRAPPER_SCRIPT).toContain('mount --bind /dev/null /.sprite/api.sock');
    expect(SANDBOX_WRAPPER_SCRIPT).toContain('setpriv --reuid="$user" --regid="$user" --init-groups --inh-caps=-all');
    expect(SANDBOX_WRAPPER_SCRIPT).toContain('set -eu');
    // root 執行的這段不信任呼叫端的環境變數：先重設 PATH、清掉會被載入的變數，指令都用絕對路徑
    const lines = SANDBOX_WRAPPER_SCRIPT.split('\n');
    expect(lines[2]).toBe('PATH=/usr/sbin:/usr/bin:/sbin:/bin; export PATH');
    expect(lines[3]).toBe('unset LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT BASH_ENV ENV IFS SHELLOPTS');
    expect(SANDBOX_WRAPPER_SCRIPT).toContain('/usr/bin/mount --bind /dev/null /.sprite/api.sock');
    expect(SANDBOX_WRAPPER_SCRIPT).toContain('exec /usr/bin/setpriv');
    // 子專案 2：只接受 agent 或顧問帳號；每個帳號一份私人 /tmp
    // 整串比對（-z：整個參數視為一筆），多行參數不能靠其中一行合格混過去
    expect(SANDBOX_WRAPPER_SCRIPT).toContain("printf '%s' \"$user\" | /usr/bin/grep -Ezqx 'agent(-[0-9a-f]{12})?'");
    expect(SANDBOX_WRAPPER_SCRIPT).not.toMatch(/grep -Eqx/);
    expect(SANDBOX_WRAPPER_SCRIPT).toContain('/usr/bin/install -d -m 700 -o "$user" -g "$user" "/var/lib/agenthub/tmp/$user"');
    // /tmp、/var/tmp、/dev/shm 都換成同一個私人目錄
    for (const target of ['/tmp', '/var/tmp', '/dev/shm']) {
      expect(SANDBOX_WRAPPER_SCRIPT).toContain(`/usr/bin/mount --bind "/var/lib/agenthub/tmp/$user" ${target}`);
    }
  });

  it('把仍是 workspace 群組的舊顧問目錄（已移出專案、adduser 不會再處理）收成只有 runtime 能進', () => {
    expect(sandboxSetupScript('/home/sprite/agenthub')).toContain(
      'sudo find /workspace/agents -mindepth 1 -maxdepth 1 -type d -group workspace -exec chmod 0700 {} +',
    );
  });
});

describe('SANDBOX_ADDUSER_SCRIPT', () => {
  it('以 root 執行：重設環境、檢查參數、拒絕 symlink，建立沒有 sudo 的顧問帳號', () => {
    expect(SANDBOX_ADDUSER_SCRIPT.split('\n')[2]).toBe('PATH=/usr/sbin:/usr/bin:/sbin:/bin; export PATH');
    expect(SANDBOX_ADDUSER_SCRIPT).toContain("printf '%s' \"$user\" | /usr/bin/grep -Ezqx 'agent-[0-9a-f]{12}'");
    expect(SANDBOX_ADDUSER_SCRIPT).toContain("printf '%s' \"$dir\" | /usr/bin/grep -Ezqx '/workspace/agents/[0-9a-f-]{36}'");
    expect(SANDBOX_ADDUSER_SCRIPT).not.toMatch(/grep -Eqx/);
    expect(SANDBOX_ADDUSER_SCRIPT).toContain('[ ! -L "$dir" ]');
    // 兩個 run 同時替新顧問建立帳號：後一個 useradd 失敗時，帳號已存在就算成功
    expect(SANDBOX_ADDUSER_SCRIPT).toContain(
      '/usr/sbin/useradd --create-home --shell /bin/bash --groups workspace "$user" || /usr/bin/id -u "$user" >/dev/null',
    );
    expect(SANDBOX_ADDUSER_SCRIPT).not.toMatch(/\bsudo -/);
  });

  it('skills 目錄放在顧問工作目錄以外、顧問只能讀；不對顧問可控的目錄樹做遞迴操作', () => {
    expect(SANDBOX_ADDUSER_SCRIPT).toContain('skills="/workspace/skills/${dir##*/}"');
    expect(SANDBOX_ADDUSER_SCRIPT).toContain('[ ! -L "$skills" ]');
    expect(SANDBOX_ADDUSER_SCRIPT).toContain('/usr/bin/chown "$owner:$user" "$dir" "$skills"');
    expect(SANDBOX_ADDUSER_SCRIPT).toContain('/usr/bin/chmod 2750 "$skills"');
    expect(SANDBOX_ADDUSER_SCRIPT).not.toMatch(/-R |find /);
    expect(sandboxSetupScript('/home/sprite/agenthub')).toContain('sudo chmod 0711 /workspace/agents /workspace/skills');
  });
});
