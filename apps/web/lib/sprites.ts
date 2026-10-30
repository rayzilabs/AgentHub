import { APIError, SpritesClient, type Sprite } from '@fly/sprites';
import { env } from '@/lib/env';
import { HttpError } from '@/lib/http';
import { setSpriteState } from '@/lib/services/projects';
import type { Db } from '@/lib/supabase/admin';

export const RUNTIME_OBJECT = 'main.js';
export const WORKSPACE = '/workspace';
export const SANDBOX_USER = 'agent';
/** 與 packages/runtime/src/sandbox.ts 的 SANDBOX_WRAPPER 相同 */
export const SANDBOX_WRAPPER = '/usr/local/bin/agenthub-sandbox';

/**
 * runtime 以 `sudo unshare --mount -- agenthub-sandbox <帳號> <指令...>` 呼叫（root、獨立掛載命名空間）。
 * Sprite 內部 API 的 socket 能建立以 runtime 帳號執行的服務，且在唯讀掛載上改不了權限；
 * 所以在這個命名空間裡用 /dev/null 蓋掉它，再降權成沙盒帳號。蓋不掉就失敗，不在沒有隔離的狀態下執行。
 */
export const SANDBOX_WRAPPER_SCRIPT = [
  '#!/bin/sh',
  'set -eu',
  // 以 root 執行的這段不信任呼叫端的環境變數：重設 PATH、清掉會被載入的變數，指令一律用絕對路徑
  'PATH=/usr/sbin:/usr/bin:/sbin:/bin; export PATH',
  'unset LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT BASH_ENV ENV IFS SHELLOPTS',
  'user="$1"; shift',
  // 整串比對（-z：整個參數視為一筆），多行參數不能靠其中一行合格混過去
  'printf \'%s\' "$user" | /usr/bin/grep -Ezqx \'agent(-[0-9a-f]{12})?\' || { echo "不合格的帳號：$user" >&2; exit 2; }',
  '[ ! -S /.sprite/api.sock ] || /usr/bin/mount --bind /dev/null /.sprite/api.sock',
  // 每個帳號一份私人暫存區，同時掛到 /tmp、/var/tmp、/dev/shm；實體目錄放在只有 root 能寫的地方，不能被搶先建立或換成 symlink
  '/usr/bin/install -d -m 700 -o "$user" -g "$user" "/var/lib/agenthub/tmp/$user"',
  '/usr/bin/mount --bind "/var/lib/agenthub/tmp/$user" /tmp',
  '/usr/bin/mount --bind "/var/lib/agenthub/tmp/$user" /var/tmp',
  '/usr/bin/mount --bind "/var/lib/agenthub/tmp/$user" /dev/shm',
  // 所有沙盒程序共用一個記憶體上限 6 GiB 的 cgroup（Sprite 8 GB、沒有 swap）：
  // 超過時核心只砍群組裡的程序，runtime 不會被拖垮。每次都確認，Sprite 重開後 cgroup 不會留著
  'cg=/sys/fs/cgroup/agenthub-sandbox',
  '/usr/bin/mkdir -p "$cg"',
  '/usr/bin/grep -qw memory /sys/fs/cgroup/cgroup.subtree_control || echo +memory > /sys/fs/cgroup/cgroup.subtree_control',
  '[ "$(/usr/bin/cat "$cg/memory.max")" = 6442450944 ] || echo 6442450944 > "$cg/memory.max"',
  'echo $$ > "$cg/cgroup.procs"',
  'exec /usr/bin/setpriv --reuid="$user" --regid="$user" --init-groups --inh-caps=-all -- \\',
  '  /usr/bin/env HOME="/home/$user" PATH="${SANDBOX_PATH:-/usr/local/bin:/usr/bin:/bin}" /bin/sh -c \'umask 002; exec "$@"\' sandbox "$@"',
  '',
].join('\n');

/** 與 packages/runtime/src/sandbox.ts 的 SANDBOX_ADDUSER 相同 */
export const SANDBOX_ADDUSER = '/usr/local/bin/agenthub-sandbox-adduser';

/**
 * runtime 以 `sudo agenthub-sandbox-adduser <帳號> <目錄>` 呼叫：確保顧問帳號與工作目錄存在，且只有 runtime 與該顧問進得去。
 * 參數不合格、目錄是 symlink 就失敗；可重複執行。也建立 /workspace/skills/<id>（顧問只能讀）。
 */
export const SANDBOX_ADDUSER_SCRIPT = [
  '#!/bin/sh',
  'set -eu',
  'PATH=/usr/sbin:/usr/bin:/sbin:/bin; export PATH',
  'unset LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT BASH_ENV ENV IFS SHELLOPTS',
  'user="$1"; dir="$2"; owner="${SUDO_USER:?必須由 runtime 以 sudo 呼叫}"',
  'printf \'%s\' "$user" | /usr/bin/grep -Ezqx \'agent-[0-9a-f]{12}\' || { echo "不合格的帳號：$user" >&2; exit 2; }',
  'printf \'%s\' "$dir" | /usr/bin/grep -Ezqx \'/workspace/agents/[0-9a-f-]{36}\' || { echo "不合格的目錄：$dir" >&2; exit 2; }',
  // skills 放在顧問工作目錄以外，顧問只能讀：runtime 解壓時顧問無法把它換成 symlink
  'skills="/workspace/skills/${dir##*/}"',
  '[ ! -L "$dir" ] || { echo "目錄不能是 symlink：$dir" >&2; exit 2; }',
  '[ ! -L "$skills" ] || { echo "目錄不能是 symlink：$skills" >&2; exit 2; }',
  // 兩個 run 同時替新顧問建立帳號時，後一個 useradd 會因帳號已存在而失敗；再確認一次，存在就算成功
  '/usr/bin/id -u "$user" >/dev/null 2>&1 || /usr/sbin/useradd --create-home --shell /bin/bash --groups workspace "$user" || /usr/bin/id -u "$user" >/dev/null',
  '[ -d "$dir" ] || /usr/bin/mkdir "$dir"',
  '[ -d "$skills" ] || /usr/bin/mkdir "$skills"',
  // 只處理頂層目錄：頂層權限就足以擋住其他帳號；不對顧問可控的目錄樹做遞迴操作（會被 symlink 搶時間利用）
  '/usr/bin/chown "$owner:$user" "$dir" "$skills"',
  '/usr/bin/chmod 2770 "$dir"',
  '/usr/bin/chmod 2750 "$skills"',
  '',
].join('\n');

/** 單引號包住，內容裡的單引號改成 '\'' */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
const SERVICE = 'runtime';
const HEALTH_TIMEOUT_MS = 90_000;
const RETRYABLE = new Set([502, 503, 504]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** SDK 的 APIError 會把 API 回傳的錯誤物件當成 message（變成 "[object Object]"），改取裡面的訊息與狀態碼。 */
export function errorText(e: unknown): string {
  if (e instanceof APIError) {
    const detail = e.errorCode as unknown;
    const message = detail && typeof detail === 'object' && 'message' in detail ? String(detail.message) : e.message;
    return e.statusCode ? `Sprites API ${e.statusCode}：${message}` : message;
  }
  return e instanceof Error ? e.message : String(e);
}

/** Sprites API 偶爾回 5xx（例如 internal_error），稍後重試通常就會成功。 */
export async function retryTransient<T>(fn: () => Promise<T>, delayMs = 2000, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const transient = e instanceof APIError && e.statusCode !== undefined && e.statusCode >= 500;
      if (!transient || attempt >= attempts) throw e;
      await sleep(delayMs);
    }
  }
}

/** Sprites API 回 404 時 SDK 一律丟出帶 statusCode 的 APIError；訊息比對只作為保守的備援（不比對 "404"，UUID 可能含這三個字）。 */
export function isNotFound(e: unknown): boolean {
  if (e instanceof APIError && e.statusCode !== undefined) return e.statusCode === 404;
  return /\bnot found\b/i.test(errorText(e));
}

export function spriteName(projectId: string): string {
  return `agenthub-${projectId}`;
}

export function runtimeEnvFile(vars: Record<string, string>): string {
  return Object.entries(vars).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('\n') + '\n';
}

/**
 * 建立沙盒帳號與工作區（可重複執行），以 runtime 帳號透過 sudo 執行。
 * 工作區由 runtime 帳號擁有、workspace 群組可寫；agent 只靠群組權限進入，沒有 sudo，進不了 runtime 目錄。
 */
export function sandboxSetupScript(base: string): string {
  const q = (p: string) => `'${p}'`;
  return [
    'set -euo pipefail',
    `id -u ${SANDBOX_USER} >/dev/null 2>&1 || sudo useradd --create-home --shell /bin/bash ${SANDBOX_USER}`,
    'getent group workspace >/dev/null || sudo groupadd workspace',
    `sudo usermod -aG workspace ${SANDBOX_USER}`,
    `sudo mkdir -p ${WORKSPACE}/agents ${WORKSPACE}/skills ${WORKSPACE}/shared`,
    // 舊版的工作區在 runtime 目錄底下；搬過來，顧問寫出的檔案不會遺失
    `if [ -d ${q(`${base}/agents`)} ]; then sudo cp -a ${q(`${base}/agents/.`)} ${WORKSPACE}/agents/ && sudo rm -rf ${q(`${base}/agents`)}; fi`,
    `if [ -d ${q(`${base}/shared`)} ]; then sudo cp -a ${q(`${base}/shared/.`)} ${WORKSPACE}/shared/ && sudo rm -rf ${q(`${base}/shared`)}; fi`,
    `sudo chown "$(id -un)":workspace ${WORKSPACE} ${WORKSPACE}/agents ${WORKSPACE}/skills`,
    `sudo chown -R "$(id -un)":workspace ${WORKSPACE}/shared`,
    `sudo chmod -R g+rwX,o-rwx ${WORKSPACE}/shared`,
    `sudo find ${WORKSPACE}/shared -type d -exec chmod g+s {} +`,
    `sudo chmod 2770 ${WORKSPACE}/shared`,
    // 只有 runtime 能在這裡建立項目；各顧問目錄的擁有者與群組由 agenthub-sandbox-adduser 處理（不在這裡遞迴改回去）
    `sudo chmod 0711 ${WORKSPACE}/agents ${WORKSPACE}/skills`,
    // 已移出專案的顧問不會再經過 adduser；1-A 時期留下的 workspace 群組目錄收成只有 runtime 能進（只看最上層，不遞迴）
    `sudo find ${WORKSPACE}/agents -mindepth 1 -maxdepth 1 -type d -group workspace -exec chmod 0700 {} +`,
    `sudo chmod 755 ${WORKSPACE}`,
    // 私人 /tmp 的實體位置：父目錄只有 root 能寫，不能被搶先建立或換成 symlink
    'sudo install -d -m 711 -o root -g root /var/lib/agenthub /var/lib/agenthub/tmp',
    // runtime 透過這兩支腳本以沙盒帳號執行指令、建立顧問帳號（見 packages/runtime/src/sandbox.ts）
    `printf '%s' ${shellQuote(SANDBOX_WRAPPER_SCRIPT)} | sudo tee ${SANDBOX_WRAPPER} >/dev/null`,
    `printf '%s' ${shellQuote(SANDBOX_ADDUSER_SCRIPT)} | sudo tee ${SANDBOX_ADDUSER} >/dev/null`,
    `sudo chown root:root ${SANDBOX_WRAPPER} ${SANDBOX_ADDUSER}`,
    `sudo chmod 755 ${SANDBOX_WRAPPER} ${SANDBOX_ADDUSER}`,
    // /.sprite/bin 的語言包裝腳本（python3、node、go、java…）第一次執行時，會把各自的 export 行寫進 runtime 帳號的
    // /etc/profile.d/languages_env；沙盒帳號寫不進去，於是每種語言在沙盒裡都會失敗（2026-10-30 正式站 75% 的對話撞到）。
    // 由 runtime 帳號先替所有包裝腳本補齊（讀出它們會寫的那行，不執行語言工具本身）；補不了只警告
    'LANG_ENV=/etc/profile.d/languages_env; { [ -f "$LANG_ENV" ] || sudo install -m 644 -o "$(id -un)" /dev/null "$LANG_ENV"; '
      + 'grep -h \'>> "$LANG_ENV"\' /.sprite/bin/* 2>/dev/null | sed -n \'s/^ *echo .\\(export [A-Za-z_]*=.*\\). >> "\\$LANG_ENV"$/\\1/p\' | sort -u | '
      + 'while IFS= read -r line; do grep -q "^${line%%=*}=" "$LANG_ENV" || echo "$line" >> "$LANG_ENV"; done; } || echo "[setup] 補齊 languages_env 失敗" >&2',
    // 顧問最常用的計算套件先裝進 pyenv 的 Python，
    // 不必每次自己建 venv 安裝；裝不起來（例如暫時連不上 PyPI）只警告，顧問仍可自行安裝
    // set -euo pipefail 下沒有 pyenv 時 ls 會失敗，|| true 讓這一步不會中止整個佈建
    'py=$(ls -d /.sprite/languages/python/pyenv/versions/*/bin 2>/dev/null | sort -V | tail -1 || true); '
      + 'if [ -n "$py" ]; then sudo "$py/pip" install --quiet --disable-pip-version-check numpy pandas || echo "[setup] 預先安裝 numpy、pandas 失敗" >&2; fi',
    // .env 可能由檔案 API 以別的帳號寫入，先改回 runtime 帳號再收緊
    `sudo chown "$(id -un)" ${q(`${base}/.env`)}`,
    `chmod 600 ${q(`${base}/.env`)}`,
    `chmod 700 ${q(base)}`,
  ].join('\n');
}

function client() {
  return new SpritesClient(env.spritesToken);
}

async function getOrCreateSprite(name: string): Promise<Sprite> {
  const c = client();
  try {
    return await c.getSprite(name);
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }
  return c.createSprite(name, { urlSettings: { auth: 'sprite' } });
}

export async function installRuntime(db: Db, sprite: Sprite, projectId: string, runtimeObject = RUNTIME_OBJECT): Promise<string> {
  const { stdout } = await sprite.execFile('bash', ['-lc', 'printf %s "$HOME"']);
  const base = `${String(stdout).trim()}/agenthub`;
  const { data, error } = await db.storage.from('runtime').createSignedUrl(runtimeObject, 600);
  if (error) throw new Error(`找不到 runtime 安裝檔：${error.message}`);
  await sprite.execFile('bash', ['-lc', `mkdir -p '${base}' && curl -fsSL '${data.signedUrl}' -o '${base}/main.js'`]);
  await sprite.filesystem(base).writeFile('.env', runtimeEnvFile({
    PROJECT_ID: projectId,
    SUPABASE_URL: env.supabaseUrl,
    // 不放平台金鑰：資料庫用 Vercel 每次附上的 runtime 帳號通行證，模型走平台代理
    SUPABASE_PUBLISHABLE_KEY: env.supabasePublishableKey,
    AGENTS_ROOT: `${WORKSPACE}/agents`,
    SHARED_ROOT: `${WORKSPACE}/shared`,
    SANDBOX_USER,
    PLATFORM_URL: env.platformUrl,
  }));
  await sprite.execFile('bash', ['-lc', sandboxSetupScript(base)]);
  const logs = await sprite.createService(SERVICE, {
    cmd: 'node',
    args: [`--env-file=${base}/.env`, `${base}/main.js`],
    httpPort: 8080,
  }, '10s');
  await logs.processAll(() => {});
  // 重新佈建已存在的 Sprite 時，createService 不會重啟正在跑的程序；重新啟動才會載入剛下載的 main.js 與 .env
  const restartLogs = await sprite.restartService(SERVICE, '10s');
  await restartLogs.processAll(() => {});
  return base;
}

async function waitForHealth(url: string, projectId: string): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`, {
        headers: { authorization: `Bearer ${env.spritesToken}` },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const body = (await res.json()) as { project_id?: string };
        if (body.project_id === projectId) return;
        last = `health 回傳的專案不符：${body.project_id}`;
      } else {
        last = `health 回應 ${res.status}`;
      }
    } catch (e) {
      last = errorText(e);
    }
    await sleep(2000);
  }
  throw new Error(`agent 環境啟動逾時（${last}）`);
}

export async function provisionProject(db: Db, projectId: string): Promise<void> {
  const name = spriteName(projectId);
  try {
    await setSpriteState(db, projectId, { sprite_status: 'provisioning', sprite_error: null, sprite_name: name });
    const sprite = await retryTransient(() => getOrCreateSprite(name));
    if (!sprite.url) throw new Error('agent 環境沒有對外網址');
    await installRuntime(db, sprite, projectId);
    await waitForHealth(sprite.url, projectId);
    await setSpriteState(db, projectId, { sprite_status: 'ready', sprite_url: sprite.url });
  } catch (e) {
    console.error('[provision]', projectId, e);
    await setSpriteState(db, projectId, { sprite_status: 'error', sprite_error: errorText(e) }).catch(() => undefined);
  }
}

export async function destroyProjectSprite(name: string): Promise<void> {
  if (!name.startsWith('agenthub-')) throw new Error(`拒絕刪除非 AgentHub 的 Sprite：${name}`);
  await client().deleteSprite(name).catch((e) => {
    if (!isNotFound(e)) throw e;
  });
}

export async function forwardChat(
  spriteUrl: string,
  body: { thread_id: string; text: string },
  opts: { token?: string; projectToken?: string; dbToken?: string; fetchImpl?: typeof fetch; retryDelayMs?: number } = {},
): Promise<Response> {
  const token = opts.token ?? env.spritesToken;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const delay = opts.retryDelayMs ?? 1000;
  let last = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchImpl(`${spriteUrl}/chat`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          ...(opts.projectToken ? { 'x-agenthub-token': opts.projectToken } : {}),
          ...(opts.dbToken ? { 'x-agenthub-db-token': opts.dbToken } : {}),
        },
        body: JSON.stringify(body),
      });
      if (!RETRYABLE.has(res.status)) return res;
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = errorText(e);
    }
    if (attempt < 2) await sleep(delay);
  }
  throw new HttpError(502, `agent 環境無法連線，請稍後再試（${last}）`);
}
