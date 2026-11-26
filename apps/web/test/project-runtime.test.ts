import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from '@/lib/env';
import { loadProjectMachine } from '@/lib/hosts';
import type { Machine } from '@/lib/hosts/types';
import { HttpError } from '@/lib/http';
import {
  forwardChat, installRuntime, provisionProject, RUNTIME_SUPERVISOR, RUNTIME_SUPERVISOR_SCRIPT, runtimeEnvFile, SANDBOX_ADDUSER_SCRIPT,
  SANDBOX_WRAPPER_SCRIPT, sandboxSetupScript, shellQuote, spriteName, startRuntimeService,
} from '@/lib/project-runtime';
import { createProject } from '@/lib/services/projects';
import type { Db } from '@/lib/supabase/admin';
import { fakeRuntimeHost, seedUser, stubHealth, testDb } from './helpers';

const body = { thread_id: 't1', text: '你好' };
const spriteMachine: Machine = { host: 'sprite', name: 'agenthub-p1', url: 'https://s.example', token: null };
const e2bMachine: Machine = { host: 'e2b', name: 'sbx-1', url: 'https://8080-sbx-1.e2b.app', token: 'traffic-tok' };

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

const signedUrlDb = {
  storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'https://signed' }, error: null }) }) },
} as unknown as Db;

describe('spriteName / runtimeEnvFile', () => {
  it('Sprite 名稱帶前綴；env 檔每行 KEY="value"', () => {
    expect(spriteName('abc')).toBe('agenthub-abc');
    expect(runtimeEnvFile({ A: 'x', B: 'has "quote"' })).toBe('A="x"\nB="has \\"quote\\""\n');
  });
});

describe('forwardChat', () => {
  it('送到 /chat，帶 Fly 驗證與 JSON body', async () => {
    const { impl, calls } = fakeFetch([200]);
    const res = await forwardChat(spriteMachine, body, { fetchImpl: impl, retryDelayMs: 0 });
    expect(res.status).toBe(200);
    expect(calls[0].url).toBe('https://s.example/chat');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(`Bearer ${env.spritesToken}`);
    expect(calls[0].init.body).toBe(JSON.stringify(body));
    expect(calls[0].init.headers).not.toHaveProperty('x-agenthub-token');
  });

  it('forwardChat 用 machine 的邊緣標頭：E2B 帶 e2b-traffic-access-token、不帶 Fly token', async () => {
    const { impl, calls } = fakeFetch([200]);
    await forwardChat(e2bMachine, body, { fetchImpl: impl, retryDelayMs: 0 });
    expect(calls[0].url).toBe('https://8080-sbx-1.e2b.app/chat');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['e2b-traffic-access-token']).toBe('traffic-tok');
    expect(headers).not.toHaveProperty('authorization');
    expect(headers['content-type']).toBe('application/json');
  });

  it('有資料庫通行證時放在 x-agenthub-db-token', async () => {
    const { impl, calls } = fakeFetch([200]);
    await forwardChat(spriteMachine, body, { dbToken: 'db1', fetchImpl: impl, retryDelayMs: 0 });
    expect((calls[0].init.headers as Record<string, string>)['x-agenthub-db-token']).toBe('db1');
  });

  it('有專案通行證時放在 x-agenthub-token', async () => {
    const { impl, calls } = fakeFetch([200]);
    await forwardChat(spriteMachine, body, { projectToken: 'pt', fetchImpl: impl, retryDelayMs: 0 });
    expect((calls[0].init.headers as Record<string, string>)['x-agenthub-token']).toBe('pt');
  });

  it('連線被拒或 502/503/504 時重試', async () => {
    const { impl, calls } = fakeFetch(['refuse', 503, 200]);
    const res = await forwardChat(spriteMachine, body, { fetchImpl: impl, retryDelayMs: 0 });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(3);
  });

  it('409 等其他狀態碼不重試，原樣回傳', async () => {
    const { impl, calls } = fakeFetch([409]);
    const res = await forwardChat(spriteMachine, body, { fetchImpl: impl, retryDelayMs: 0 });
    expect(res.status).toBe(409);
    expect(calls).toHaveLength(1);
  });

  it('三次都失敗：502', async () => {
    const { impl } = fakeFetch(['refuse', 'refuse', 'refuse']);
    const e = await forwardChat(spriteMachine, body, { fetchImpl: impl, retryDelayMs: 0 }).catch((err) => err);
    expect(e).toBeInstanceOf(HttpError);
    expect(e.status).toBe(502);
    expect(e.message).toContain('agent 環境無法連線');
  });
});

describe('installRuntime', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  function stubEnv() {
    for (const k of ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'VERTEX_API_EXPRESS_MODE_KEY', 'SUPABASE_PUBLISHABLE_KEY']) vi.stubEnv(k, 'x');
    for (const k of ['PLATFORM_URL', 'VERCEL_PROJECT_PRODUCTION_URL']) vi.stubEnv(k, '');
  }

  it('依序：讀家目錄 → 下載 → 以絕對路徑寫 .env → 佈建腳本（給足時間）→ 啟動服務', async () => {
    stubEnv();
    const host = fakeRuntimeHost('sprite');
    host.exec.mockImplementation(async (_m, script) => (script.startsWith('printf') ? '/home/sprite\n' : ''));

    expect(await installRuntime(signedUrlDb, host, spriteMachine, 'p1')).toBe('/home/sprite/agenthub');
    const scripts = host.exec.mock.calls.map((c) => c[1]);
    expect(scripts[0]).toBe('printf %s "$HOME"');
    expect(scripts[1]).toBe("mkdir -p '/home/sprite/agenthub' && curl -fsSL 'https://signed' -o '/home/sprite/agenthub/main.js'");
    expect(scripts[2]).toBe(sandboxSetupScript('/home/sprite/agenthub', 'sprite'));
    // 下載與佈建腳本可能超過 E2B SDK 預設的 60 秒
    for (const c of host.exec.mock.calls.slice(1)) expect(c[2]).toEqual({ timeoutMs: 600_000 });
    expect(host.writeFile).toHaveBeenCalledWith(spriteMachine, '/home/sprite/agenthub/.env', expect.any(String));
    expect(host.writeFile.mock.invocationCallOrder[0]).toBeLessThan(host.exec.mock.invocationCallOrder[2]);
    // 服務經由看守腳本啟動 node：node 結束後先清掉沙盒程序，才會馬上重啟服務
    expect(host.startService).toHaveBeenCalledWith(spriteMachine, { name: 'runtime', cmd: '/usr/local/bin/agenthub-runtime', args: ['/home/sprite/agenthub'], httpPort: 8080 });
    expect(host.startService.mock.invocationCallOrder[0]).toBeGreaterThan(host.exec.mock.invocationCallOrder[2]);

    const envFile = host.writeFile.mock.calls[0][2];
    expect(envFile).toContain('AGENTS_ROOT="/workspace/agents"');
    expect(envFile).toContain('SHARED_ROOT="/workspace/shared"');
    expect(envFile).toContain('SANDBOX_USER="agent"');
    expect(envFile).toContain('PLATFORM_URL="https://agenthub-kappa-pink.vercel.app"');
    // 機器上不放平台金鑰：資料庫用 runtime 帳號通行證、模型走平台代理
    expect(envFile).toContain('SUPABASE_PUBLISHABLE_KEY="x"');
    expect(envFile).not.toContain('SUPABASE_SECRET_KEY');
    expect(envFile).not.toContain('VERTEX_API_EXPRESS_MODE_KEY');
  });

  it('installRuntime 的 .env 帶 RUNTIME_HOST', async () => {
    stubEnv();
    const e2b = fakeRuntimeHost('e2b');
    expect(await installRuntime(signedUrlDb, e2b, e2bMachine, 'p1')).toBe('/home/user/agenthub');
    expect(e2b.writeFile.mock.calls[0][1]).toBe('/home/user/agenthub/.env');
    expect(e2b.writeFile.mock.calls[0][2]).toContain('RUNTIME_HOST="e2b"');
    expect(e2b.exec.mock.calls[2][1]).toBe(sandboxSetupScript('/home/user/agenthub', 'e2b'));

    const sprite = fakeRuntimeHost('sprite');
    await installRuntime(signedUrlDb, sprite, spriteMachine, 'p1');
    expect(sprite.writeFile.mock.calls[0][2]).toContain('RUNTIME_HOST="sprite"');
  });
});

describe('startRuntimeService', () => {
  it('交給執行環境建立或取代 runtime 服務（看守腳本、runtime 目錄、8080）', async () => {
    const host = fakeRuntimeHost('e2b');
    await startRuntimeService(host, e2bMachine, '/home/user/agenthub');
    expect(host.startService).toHaveBeenCalledExactlyOnceWith(e2bMachine, { name: 'runtime', cmd: RUNTIME_SUPERVISOR, args: ['/home/user/agenthub'], httpPort: 8080 });
  });
});

describe('provisionProject', () => {
  const db = testDb();
  afterEach(() => { vi.unstubAllGlobals(); });

  async function projectOn(host: 'sprite' | 'e2b', row: Record<string, unknown> = {}) {
    const owner = await seedUser(db);
    const p = await createProject(db, owner.id, 'p');
    await db.from('projects').update({ host, ...row }).eq('id', p.id).throwOnError();
    return p.id;
  }
  const projectRow = async (id: string) =>
    (await db.from('projects').select('sprite_name, sprite_url, host_token, sprite_status, sprite_error').eq('id', id).single().throwOnError()).data!;
  const old = { sprite_name: 'sbx-old', sprite_url: 'https://old.example', host_token: 'old-tok' };
  const oldMachine: Machine = { host: 'e2b', name: 'sbx-old', url: 'https://old.example', token: 'old-tok' };

  it('provisionProject：E2B 專案的舊沙盒 gone 時建立新的，並寫回 sprite_name、sprite_url、host_token', async () => {
    const id = await projectOn('e2b', old);
    const host = fakeRuntimeHost('e2b', { host: 'e2b', name: 'sbx-new', url: 'https://new.example', token: 'new-tok' });
    host.status.mockResolvedValue('gone');
    const fetchMock = stubHealth(id);

    await provisionProject(db, id, () => host);

    expect(host.status).toHaveBeenCalledWith(oldMachine);
    expect(host.create).toHaveBeenCalledExactlyOnceWith(spriteName(id), 'project');
    expect(await projectRow(id)).toEqual({ sprite_name: 'sbx-new', sprite_url: 'https://new.example', host_token: 'new-tok', sprite_status: 'ready', sprite_error: null });
    // 等 /health 時帶新沙盒的通行證
    expect(fetchMock).toHaveBeenCalledWith('https://new.example/health', expect.objectContaining({ headers: { 'e2b-traffic-access-token': 'new-tok' } }));
  });

  it('provisionProject：E2B 專案的舊沙盒還在（含暫停）時沿用，不建新的', async () => {
    const id = await projectOn('e2b', old);
    const host = fakeRuntimeHost('e2b');
    host.status.mockResolvedValue('paused');
    stubHealth(id);

    await provisionProject(db, id, () => host);

    expect(host.create).not.toHaveBeenCalled();
    expect(host.startService.mock.calls[0][0]).toEqual(oldMachine);
    expect(await projectRow(id)).toEqual({ ...old, sprite_status: 'ready', sprite_error: null });
  });

  it('provisionProject：建立後立刻寫回名稱，之後的步驟失敗時清理找得到', async () => {
    const id = await projectOn('e2b');
    const half: Machine = { host: 'e2b', name: 'sbx-half', url: 'https://half.example', token: 'half-tok' };
    const host = fakeRuntimeHost('e2b', half);
    host.exec.mockRejectedValue(new Error('沙盒連不上'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});

    await provisionProject(db, id, () => host);
    log.mockRestore();

    expect(await projectRow(id)).toEqual({ sprite_name: 'sbx-half', sprite_url: 'https://half.example', host_token: 'half-tok', sprite_status: 'error', sprite_error: '沙盒連不上' });
    expect(await loadProjectMachine(db, id)).toEqual(half);
  });

  it('Sprite 專案以固定名稱建立（已存在就沿用），不查舊機器狀態', async () => {
    const id = await projectOn('sprite');
    const host = fakeRuntimeHost('sprite', { host: 'sprite', name: spriteName(id), url: 'https://s.example', token: null });
    stubHealth(id);

    await provisionProject(db, id, () => host);

    expect(host.status).not.toHaveBeenCalled();
    expect(host.create).toHaveBeenCalledExactlyOnceWith(spriteName(id), 'project');
    expect(await projectRow(id)).toEqual({ sprite_name: spriteName(id), sprite_url: 'https://s.example', host_token: null, sprite_status: 'ready', sprite_error: null });
  });
});

describe('sandboxSetupScript', () => {
  it('建立沒有 sudo 的 agent 帳號與工作區，收緊 runtime 目錄', () => {
    const s = sandboxSetupScript('/home/sprite/agenthub', 'sprite');
    expect(s.startsWith('set -euo pipefail')).toBe(true);
    expect(s).toContain('useradd --create-home --shell /bin/bash agent');
    expect(s).not.toMatch(/usermod -aG sudo/);
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
    // 降權前盡量把自己放進記憶體上限 6 GiB 的 cgroup。Sprite 的 cgroup 根目錄本身有程序，
    // 核心不准在那層啟用記憶體控制器（EBUSY）；設不起來時照常執行，不能讓顧問的每個指令都失敗
    const cgLines = lines.filter((l) => l.includes('cgroup') || l.startsWith('cg='));
    expect(cgLines.length).toBeGreaterThan(0);
    for (const l of cgLines.filter((x) => !x.startsWith('cg='))) expect(l).toMatch(/2>\/dev\/null \|\| true$/);
    const cg = SANDBOX_WRAPPER_SCRIPT.indexOf('/sys/fs/cgroup/agenthub-sandbox');
    expect(cg).toBeGreaterThan(-1);
    expect(SANDBOX_WRAPPER_SCRIPT).toContain('6442450944');
    expect(SANDBOX_WRAPPER_SCRIPT).toContain('+memory');
    expect(SANDBOX_WRAPPER_SCRIPT.indexOf('cgroup.procs')).toBeLessThan(SANDBOX_WRAPPER_SCRIPT.indexOf('exec /usr/bin/setpriv'));
    expect(cg).toBeLessThan(SANDBOX_WRAPPER_SCRIPT.indexOf('exec /usr/bin/setpriv'));
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

  it('開記憶體控制器前，先把 cgroup 根目錄的程序搬到 init 子群組（根目錄有程序時核心回 EBUSY）', () => {
    const line = SANDBOX_WRAPPER_SCRIPT.split('\n').find((l) => l.includes('+memory'));
    expect(line).toContain('/usr/bin/mkdir -p /sys/fs/cgroup/init && for p in $(/usr/bin/cat /sys/fs/cgroup/cgroup.procs); do echo "$p" > /sys/fs/cgroup/init/cgroup.procs; done; echo +memory > /sys/fs/cgroup/cgroup.subtree_control;');
    expect(line!.indexOf('/sys/fs/cgroup/init/cgroup.procs')).toBeLessThan(line!.indexOf('echo +memory'));
    // 已經開了就不再搬
    expect(line).toContain('/usr/bin/grep -qw memory /sys/fs/cgroup/cgroup.subtree_control ||');
    // 實測吃光整台記憶體時是整個 Sprite 一起重啟，oom_score_adj 沒有作用
    expect(SANDBOX_WRAPPER_SCRIPT).not.toContain('oom_score_adj');
  });

  it('安裝 runtime 的看守腳本（只有 root 能改）', () => {
    const s = sandboxSetupScript('/home/sprite/agenthub', 'sprite');
    expect(s).toContain(`printf '%s' ${shellQuote(RUNTIME_SUPERVISOR_SCRIPT)} | sudo tee /usr/local/bin/agenthub-runtime >/dev/null`);
    expect(s).toContain('sudo chown root:root /usr/local/bin/agenthub-sandbox /usr/local/bin/agenthub-sandbox-adduser /usr/local/bin/agenthub-runtime');
    expect(s).toContain('sudo chmod 755 /usr/local/bin/agenthub-sandbox /usr/local/bin/agenthub-sandbox-adduser /usr/local/bin/agenthub-runtime');
  });
});

describe('RUNTIME_SUPERVISOR_SCRIPT', () => {
  const lines = RUNTIME_SUPERVISOR_SCRIPT.split('\n');

  it('在背景執行 node，把服務收到的停止訊號轉給 node，等 node 真的結束', () => {
    expect(lines[0]).toBe('#!/bin/sh');
    expect(RUNTIME_SUPERVISOR_SCRIPT).toContain('node --env-file="$1/.env" "$1/main.js" &');
    expect(RUNTIME_SUPERVISOR_SCRIPT).toContain('trap \'kill -TERM "$pid" 2>/dev/null\' TERM INT HUP');
    // wait 會被訊號打斷；node 還在就繼續等
    expect(RUNTIME_SUPERVISOR_SCRIPT).toContain('while :; do wait "$pid"; code=$?; kill -0 "$pid" 2>/dev/null || break; done');
  });

  it('node 結束後砍掉所有沙盒帳號的程序，再以 node 的結束碼退出', () => {
    const kill = lines.findIndex((l) => l.includes('pkill'));
    expect(kill).toBeGreaterThan(lines.findIndex((l) => l.startsWith('while :;')));
    expect(RUNTIME_SUPERVISOR_SCRIPT).toContain("grep -Ex 'agent(-[0-9a-f]{12})?'");
    expect(lines[kill]).toContain('sudo -n /usr/bin/pkill -KILL -u "$users"');
    expect(lines.filter(Boolean).at(-1)).toBe('exit "$code"');
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
    expect(sandboxSetupScript('/home/sprite/agenthub', 'sprite')).toContain('sudo chmod 0711 /workspace/agents /workspace/skills');
  });

  it('以 runtime 帳號替所有語言補齊 /etc/profile.d/languages_env（沙盒帳號寫不進去，包裝腳本會失敗）；補不了只警告', () => {
    const s = sandboxSetupScript('/home/sprite/agenthub', 'sprite');
    const line = s.split('\n').find((l) => l.includes('/etc/profile.d/languages_env'));
    expect(line).toBeDefined();
    // 從 /.sprite/bin 的包裝腳本讀出它們會寫的 export 行，依變數名稱判斷缺哪幾行
    expect(line).toContain('/.sprite/bin/*');
    expect(line).toContain('>> "$LANG_ENV"');
    expect(line).toContain('grep -q "^${line%%=*}="');
    expect(line).toMatch(/\|\| echo "\[setup\]/);
    // 在預裝 numpy、pandas 之前
    expect(s.indexOf('languages_env')).toBeLessThan(s.indexOf('numpy pandas'));
  });

  it('也補齊 /etc/profile.d/languages_paths（包裝腳本寫不進去會在每次執行時印 Permission denied）；補不了只警告', () => {
    const s = sandboxSetupScript('/home/sprite/agenthub', 'sprite');
    const line = s.split('\n').find((l) => l.includes('/etc/profile.d/languages_paths'));
    expect(line).toBeDefined();
    // 路徑寫成 "$PYENV_ROOT/shims" 這種形式，用剛補齊的 languages_env 展開；展開不出來的（變數沒定義）跳過
    expect(line).toContain('. "$LANG_ENV"');
    expect(line).toContain('>> "$LANG_PATHS"');
    expect(line).toContain('grep -qxF "$d" "$LANG_PATHS"');
    expect(line).toMatch(/\|\| echo "\[setup\]/);
    expect(s.indexOf('LANG_ENV=/etc/profile.d/languages_env')).toBeLessThan(s.indexOf('/etc/profile.d/languages_paths'));
  });

  it('預先把 numpy、pandas 裝進 pyenv 的 Python；裝不起來只警告，不讓佈建失敗', () => {
    const s = sandboxSetupScript('/home/sprite/agenthub', 'sprite');
    const line = s.split('\n').find((l) => l.includes('numpy pandas'));
    expect(line).toBeDefined();
    expect(line).toContain('/.sprite/languages/python/pyenv/versions/');
    expect(line).toContain('sort -V | tail -1');
    expect(line).toMatch(/sudo "\$py\/pip" install .*numpy pandas \|\| echo /);
  });

  it('sandboxSetupScript：Sprite 補 languages_env／languages_paths 並以 pyenv 裝 numpy、pandas；E2B 兩者都沒有', () => {
    const sprite = sandboxSetupScript('/home/sprite/agenthub', 'sprite');
    for (const part of ['/etc/profile.d/languages_env', '/etc/profile.d/languages_paths', '/.sprite/bin/*', 'numpy pandas', 'pyenv']) {
      expect(sprite).toContain(part);
    }
    // E2B 範本已裝好語言工具與 numpy、pandas，沒有 /.sprite/bin 的包裝腳本
    const e2b = sandboxSetupScript('/home/user/agenthub', 'e2b');
    for (const part of ['languages_env', 'languages_paths', '/.sprite/bin', 'numpy', 'pandas', 'pyenv']) {
      expect(e2b).not.toContain(part);
    }
    // 其餘（帳號、工作區、沙盒腳本、收緊 runtime 目錄）兩邊相同
    expect(e2b).toContain('useradd --create-home --shell /bin/bash agent');
    expect(e2b).toContain(`printf '%s' ${shellQuote(RUNTIME_SUPERVISOR_SCRIPT)} | sudo tee /usr/local/bin/agenthub-runtime >/dev/null`);
    expect(e2b).toContain("chmod 600 '/home/user/agenthub/.env'");
    expect(e2b).toContain("chmod 700 '/home/user/agenthub'");
  });
});
