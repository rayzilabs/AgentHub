import { setTimeout as sleep } from 'node:timers/promises';
import { env } from '@/lib/env';
import { hostFor, projectMachine } from '@/lib/hosts';
import { errorText } from '@/lib/hosts/sprite';
import type { HostName, Machine, RuntimeHost } from '@/lib/hosts/types';
import { HttpError } from '@/lib/http';
import { setSpriteState } from '@/lib/services/projects';
import type { Db } from '@/lib/supabase/admin';

export const RUNTIME_OBJECT = 'main.js';
/** 機器整台不見（例如被刪除）時給使用者的訊息；專案頁的「重新建立環境」會建新的一台 */
export const RUNTIME_GONE = 'agent 環境已不存在，請重新建立';
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
  // 所有沙盒程序共用一個記憶體上限 6 GiB 的 cgroup：超過時核心只砍群組裡的程序。沒有這個群組時，吃光記憶體會讓整個 Sprite 停住再全部重啟。
  // 根目錄有程序時核心不准在那層啟用記憶體控制器（EBUSY），先把它們（Sprite 的 init、exec 開的 shell）搬到 init 子群組；
  // Sprite 重啟後 cgroup 會恢復原狀，所以每次都檢查。設不起來就照常執行，不加入群組
  'cg=/sys/fs/cgroup/agenthub-sandbox',
  '{ /usr/bin/mkdir -p "$cg" && { /usr/bin/grep -qw memory /sys/fs/cgroup/cgroup.subtree_control || { /usr/bin/mkdir -p /sys/fs/cgroup/init && for p in $(/usr/bin/cat /sys/fs/cgroup/cgroup.procs); do echo "$p" > /sys/fs/cgroup/init/cgroup.procs; done; echo +memory > /sys/fs/cgroup/cgroup.subtree_control; }; } && { [ "$(/usr/bin/cat "$cg/memory.max")" = 6442450944 ] || echo 6442450944 > "$cg/memory.max"; } && echo $$ > "$cg/cgroup.procs"; } 2>/dev/null || true',
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

export const RUNTIME_SUPERVISOR = '/usr/local/bin/agenthub-runtime';

/**
 * runtime 服務的啟動指令，參數是 runtime 目錄。runtime 不論怎麼結束，都先砍掉沙盒帳號的程序再退出：
 * 沙盒程序還在時 Sprite 不會重啟服務（2026-11-01 實測等了 233 秒），這段期間整個專案都連不上。
 */
export const RUNTIME_SUPERVISOR_SCRIPT = [
  '#!/bin/sh',
  'node --env-file="$1/.env" "$1/main.js" &',
  'pid=$!',
  'trap \'kill -TERM "$pid" 2>/dev/null\' TERM INT HUP',
  // wait 會被訊號打斷；node 還在就繼續等
  'while :; do wait "$pid"; code=$?; kill -0 "$pid" 2>/dev/null || break; done',
  'users=$(/usr/bin/getent passwd | /usr/bin/cut -d: -f1 | /usr/bin/grep -Ex \'agent(-[0-9a-f]{12})?\' | /usr/bin/paste -sd, -)',
  '[ -z "$users" ] || /usr/bin/sudo -n /usr/bin/pkill -KILL -u "$users"',
  'exit "$code"',
  '',
].join('\n');

/** 單引號包住，內容裡的單引號改成 '\'' */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
const SERVICE = 'runtime';
const HEALTH_TIMEOUT_MS = 90_000;
const RETRYABLE = new Set([502, 503, 504]);

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
export function sandboxSetupScript(base: string, host: HostName): string {
  const q = (p: string) => `'${p}'`;
  return [
    'set -euo pipefail',
    `id -u ${SANDBOX_USER} >/dev/null 2>&1 || sudo useradd --create-home --shell /bin/bash ${SANDBOX_USER}`,
    'getent group workspace >/dev/null || sudo groupadd workspace',
    `sudo usermod -aG workspace ${SANDBOX_USER}`,
    `sudo mkdir -p ${WORKSPACE}/agents ${WORKSPACE}/skills ${WORKSPACE}/shared`,
    `sudo chown "$(id -un)":workspace ${WORKSPACE} ${WORKSPACE}/agents ${WORKSPACE}/skills`,
    `sudo chown -R "$(id -un)":workspace ${WORKSPACE}/shared`,
    `sudo chmod -R g+rwX,o-rwx ${WORKSPACE}/shared`,
    `sudo find ${WORKSPACE}/shared -type d -exec chmod g+s {} +`,
    `sudo chmod 2770 ${WORKSPACE}/shared`,
    // 只有 runtime 能在這裡建立項目；各顧問目錄的擁有者與群組由 agenthub-sandbox-adduser 處理（不在這裡遞迴改回去）
    `sudo chmod 0711 ${WORKSPACE}/agents ${WORKSPACE}/skills`,
    `sudo chmod 755 ${WORKSPACE}`,
    // 私人 /tmp 的實體位置：父目錄只有 root 能寫，不能被搶先建立或換成 symlink
    'sudo install -d -m 711 -o root -g root /var/lib/agenthub /var/lib/agenthub/tmp',
    // runtime 透過這兩支腳本以沙盒帳號執行指令、建立顧問帳號（見 packages/runtime/src/sandbox.ts）
    `printf '%s' ${shellQuote(SANDBOX_WRAPPER_SCRIPT)} | sudo tee ${SANDBOX_WRAPPER} >/dev/null`,
    `printf '%s' ${shellQuote(SANDBOX_ADDUSER_SCRIPT)} | sudo tee ${SANDBOX_ADDUSER} >/dev/null`,
    `printf '%s' ${shellQuote(RUNTIME_SUPERVISOR_SCRIPT)} | sudo tee ${RUNTIME_SUPERVISOR} >/dev/null`,
    `sudo chown root:root ${SANDBOX_WRAPPER} ${SANDBOX_ADDUSER} ${RUNTIME_SUPERVISOR}`,
    `sudo chmod 755 ${SANDBOX_WRAPPER} ${SANDBOX_ADDUSER} ${RUNTIME_SUPERVISOR}`,
    // 以下只在 Sprite：E2B 範本已裝好語言工具與 numpy、pandas，也沒有 /.sprite/bin 的包裝腳本
    ...(host === 'sprite' ? [
      // /.sprite/bin 的語言包裝腳本（python3、node、go、java…）第一次執行時，會把各自的 export 行寫進 runtime 帳號的
      // /etc/profile.d/languages_env；沙盒帳號寫不進去，於是每種語言在沙盒裡都會失敗（2026-10-30 正式站 75% 的對話撞到）。
      // 由 runtime 帳號先替所有包裝腳本補齊（讀出它們會寫的那行，不執行語言工具本身）；補不了只警告
      'LANG_ENV=/etc/profile.d/languages_env; { [ -f "$LANG_ENV" ] || sudo install -m 644 -o "$(id -un)" /dev/null "$LANG_ENV"; '
        + 'grep -h \'>> "$LANG_ENV"\' /.sprite/bin/* 2>/dev/null | sed -n \'s/^ *echo .\\(export [A-Za-z_]*=.*\\). >> "\\$LANG_ENV"$/\\1/p\' | sort -u | '
        + 'while IFS= read -r line; do grep -q "^${line%%=*}=" "$LANG_ENV" || echo "$line" >> "$LANG_ENV"; done; } || echo "[setup] 補齊 languages_env 失敗" >&2',
      // 包裝腳本也把自己的路徑（"$PYENV_ROOT/shims" 這類）寫進 languages_paths；寫不進去只印 Permission denied，
      // 但每次執行都會混進顧問看到的輸出。以剛補齊的 languages_env 展開後補上；變數沒定義、展開不完整的跳過
      'LANG_PATHS=/etc/profile.d/languages_paths; { [ -f "$LANG_PATHS" ] || sudo install -m 644 -o "$(id -un)" /dev/null "$LANG_PATHS"; '
        + '( set +u; . "$LANG_ENV"; grep -h \'>> "$LANG_PATHS"\' /.sprite/bin/* 2>/dev/null | sed -n \'s/^ *echo "\\([^"]*\\)" >> "\\$LANG_PATHS".*$/\\1/p\' | sort -u | '
        + 'while IFS= read -r p; do eval "d=\\"$p\\""; case "$d" in /?*/*) ;; *) continue ;; esac; grep -qxF "$d" "$LANG_PATHS" || echo "$d" >> "$LANG_PATHS"; done ); } '
        + '|| echo "[setup] 補齊 languages_paths 失敗" >&2',
      // 顧問最常用的計算套件先裝進 pyenv 的 Python，
      // 不必每次自己建 venv 安裝；裝不起來（例如暫時連不上 PyPI）只警告，顧問仍可自行安裝
      // set -euo pipefail 下沒有 pyenv 時 ls 會失敗，|| true 讓這一步不會中止整個佈建
      'py=$(ls -d /.sprite/languages/python/pyenv/versions/*/bin 2>/dev/null | sort -V | tail -1 || true); '
        + 'if [ -n "$py" ]; then sudo "$py/pip" install --quiet --disable-pip-version-check numpy pandas || echo "[setup] 預先安裝 numpy、pandas 失敗" >&2; fi',
    ] : []),
    // .env 可能由檔案 API 以別的帳號寫入，先改回 runtime 帳號再收緊
    `sudo chown "$(id -un)" ${q(`${base}/.env`)}`,
    `chmod 600 ${q(`${base}/.env`)}`,
    `chmod 700 ${q(base)}`,
  ].join('\n');
}

/** 下載 runtime 與跑佈建腳本可能超過 E2B SDK 預設的 60 秒 */
const PROVISION_EXEC_TIMEOUT_MS = 600_000;

/** runtime 目錄：機器上 runtime 帳號的 $HOME/agenthub（Sprite: /home/sprite；E2B: /home/user） */
async function runtimeBase(host: RuntimeHost, m: Machine): Promise<string> {
  return `${(await host.exec(m, 'printf %s "$HOME"')).trim()}/agenthub`;
}

export async function installRuntime(db: Db, host: RuntimeHost, m: Machine, projectId: string, runtimeObject = RUNTIME_OBJECT): Promise<string> {
  const base = await runtimeBase(host, m);
  const { data, error } = await db.storage.from('runtime').createSignedUrl(runtimeObject, 600);
  if (error) throw new Error(`找不到 runtime 安裝檔：${error.message}`);
  await host.exec(m, `mkdir -p '${base}' && curl -fsSL '${data.signedUrl}' -o '${base}/main.js'`, { timeoutMs: PROVISION_EXEC_TIMEOUT_MS });
  await host.writeFile(m, `${base}/.env`, runtimeEnvFile({
    PROJECT_ID: projectId,
    SUPABASE_URL: env.supabaseUrl,
    // 不放平台金鑰：資料庫用 Vercel 每次附上的 runtime 帳號通行證，模型走平台代理
    SUPABASE_PUBLISHABLE_KEY: env.supabasePublishableKey,
    AGENTS_ROOT: `${WORKSPACE}/agents`,
    SHARED_ROOT: `${WORKSPACE}/shared`,
    SANDBOX_USER,
    PLATFORM_URL: env.platformUrl,
    // runtime 依它決定防休眠找 Sprite Tasks API 還是平台的 keepalive
    RUNTIME_HOST: m.host,
  }));
  await host.exec(m, sandboxSetupScript(base, m.host), { timeoutMs: PROVISION_EXEC_TIMEOUT_MS });
  await startRuntimeService(host, m, base);
  return base;
}

/** 建立或取代 runtime 服務並（重新）啟動，載入剛下載的 main.js 與 .env */
export async function startRuntimeService(host: RuntimeHost, m: Machine, base: string): Promise<void> {
  await host.startService(m, { name: SERVICE, cmd: RUNTIME_SUPERVISOR, args: [base], httpPort: 8080 });
}

async function waitForHealth(host: RuntimeHost, m: Machine, projectId: string): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${m.url}/health`, { headers: host.edgeHeaders(m), signal: AbortSignal.timeout(5000) });
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

/** 機器還在但 runtime 沒在跑（例如冷開機後程序全沒了）：重新啟動服務並等它回應 */
export async function restartRuntime(host: RuntimeHost, m: Machine, projectId: string): Promise<void> {
  await startRuntimeService(host, m, await runtimeBase(host, m));
  await waitForHealth(host, m, projectId);
}

export async function provisionProject(db: Db, projectId: string, hosts: (n: HostName) => RuntimeHost = hostFor): Promise<void> {
  try {
    await setSpriteState(db, projectId, { sprite_status: 'provisioning', sprite_error: null });
    const { data: row, error } = await db.from('projects').select('host, sprite_name, sprite_url, host_token').eq('id', projectId).single();
    if (error) throw error;
    const host = hosts(row.host as HostName);
    // E2B 重建後名稱、網址、通行證都會換，舊沙盒還在（含暫停）就沿用；Sprite 以固定名稱取得或建立
    const existing = row.host === 'e2b' ? projectMachine(row) : null;
    let m = existing && (await host.status(existing)) !== 'gone' ? existing : null;
    if (!m) {
      m = await host.create(spriteName(projectId), 'project');
      // 建好就寫回：之後的步驟失敗時，刪除專案或重新建立都找得到這台
      await setSpriteState(db, projectId, { sprite_name: m.name, sprite_url: m.url, host_token: m.token });
    }
    await installRuntime(db, host, m, projectId);
    await waitForHealth(host, m, projectId);
    await setSpriteState(db, projectId, { sprite_status: 'ready' });
  } catch (e) {
    console.error('[provision]', projectId, e);
    await setSpriteState(db, projectId, { sprite_status: 'error', sprite_error: errorText(e) }).catch(() => undefined);
  }
}

/** m 為 null（還沒寫回機器）時以 spriteName 當 claim，刪掉 host 上可能建到一半的機器；已不在算成功 */
export async function destroyProjectMachine(m: Machine | null, projectId: string, host: HostName | undefined = m?.host): Promise<void> {
  if (!host) throw new Error('刪除機器需要指定執行環境');
  await hostFor(host).destroy(m?.name ?? spriteName(projectId), 'agenthub-');
}

export async function forwardChat(
  m: Machine,
  body: { thread_id: string; text?: string },
  opts: { projectToken?: string; dbToken?: string; fetchImpl?: typeof fetch; retryDelayMs?: number } = {},
): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const delay = opts.retryDelayMs ?? 1000;
  // 邊緣驗證標頭：Sprite 是 Fly token（Fly 驗證後拿掉），E2B 是這台沙盒的通行證
  const edge = hostFor(m.host).edgeHeaders(m);
  let last = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchImpl(`${m.url}/chat`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...edge,
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
