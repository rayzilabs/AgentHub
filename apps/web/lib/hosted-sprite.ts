import { SpritesClient, type Sprite } from '@fly/sprites';
import { env } from '@/lib/env';
import { hostedSpriteName, type DeployState, type HostedSpriteOps, type HostedVersion } from '@/lib/services/hosted-mcp';
import { isNotFound, retryTransient, shellQuote } from '@/lib/sprites';

const ROOT = '/srv/agenthub-mcp';
const APP = `${ROOT}/app`;
const DEPLOY = `${ROOT}/deploy`;
const DEPLOY_SCRIPT = `${DEPLOY}/deploy.sh`;
const LOG_MARK = '---agenthub-log---';
export const HOSTED_RUN = '/usr/local/bin/agenthub-mcp-run';
/** 創作者的檔案與程式一律經過這裡：獨立掛載命名空間 + 降權成 mcp */
const SANDBOXED = `sudo -n unshare --mount --propagation private -- ${HOSTED_RUN}`;

export { hostedSpriteName };

/**
 * 以 root 在獨立掛載命名空間執行：遮住 Sprite 內部 API 的 socket，降權成 mcp，清空環境後才載入金鑰。
 * env.sh 在降權之後才讀：以 root 載入任何 mcp 能影響的檔案都會變成提權。
 */
export const HOSTED_RUN_SCRIPT = [
  '#!/bin/sh',
  'set -eu',
  'PATH=/usr/sbin:/usr/bin:/sbin:/bin; export PATH',
  'unset LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT BASH_ENV ENV IFS SHELLOPTS',
  '[ "$(/usr/bin/readlink /proc/self/ns/mnt)" != "$(/usr/bin/readlink /proc/1/ns/mnt)" ] || { echo "必須在獨立的掛載命名空間執行" >&2; exit 2; }',
  '[ ! -S /.sprite/api.sock ] || /usr/bin/mount --bind /dev/null /.sprite/api.sock',
  `tools="$(/usr/bin/cat ${ROOT}/path)"`,
  'exec /usr/bin/setpriv --reuid=mcp --regid=mcp --init-groups --inh-caps=-all -- \\',
  `  /usr/bin/env -i HOME=/home/mcp LANG=C.UTF-8 PATH="${APP}/.venv/bin:${APP}/node_modules/.bin:$tools" \\`,
  // 呼叫端的工作目錄（Sprite 帳號的家目錄）mcp 進不去，pyenv 的 shim 會失敗；先切到程式目錄
  `  /bin/sh -c 'cd ${APP} || cd /; set -a; . ${ROOT}/env.sh; set +a; exec "$@"' mcp-run "$@"`,
  '',
].join('\n');

/** 以 Sprite 帳號執行（有 sudo）；可重複執行 */
export const HOSTED_SETUP_SCRIPT = [
  'set -euo pipefail',
  'id -u mcp >/dev/null 2>&1 || sudo useradd --create-home --shell /bin/bash mcp',
  `sudo install -d -m 755 -o root -g root ${ROOT}`,
  `sudo install -d -m 700 -o "$(id -un)" -g "$(id -gn)" ${DEPLOY}`,
  `sudo install -d -m 700 -o mcp -g mcp ${APP}`,
  // sudo 會重設 PATH；記下 Sprite 帳號的 PATH 給沙盒用。/.sprite/bin 的 node／npm 包裝腳本會寫
  // /etc/profile.d/languages_env，mcp 沒有權限而失敗；所以把 node、python 的真實目錄放最前面，不經過包裝
  `langs="$(dirname "$(node -e 'process.stdout.write(process.execPath)')"):$(dirname "$(python3 -c 'import sys; print(sys.executable, end="")')")"`,
  `printf '%s' "$langs:$PATH" | sudo tee ${ROOT}/path >/dev/null`,
  `sudo chmod 644 ${ROOT}/path`,
  `printf '%s' ${shellQuote(HOSTED_RUN_SCRIPT)} | sudo tee ${HOSTED_RUN} >/dev/null`,
  `sudo chown root:root ${HOSTED_RUN}`,
  `sudo chmod 755 ${HOSTED_RUN}`,
].join('\n');

export function envScript(vars: Record<string, string>): string {
  return Object.entries(vars).map(([k, v]) => `${k}=${shellQuote(v)}\n`).join('');
}

/** 以 root 擁有、mcp 群組唯讀：mcp 讀得到自己的金鑰，但改不了（改得了就能影響下次啟動） */
function writeEnvCommand(vars: Record<string, string>): string {
  const b64 = Buffer.from(envScript(vars)).toString('base64');
  return [
    'set -eu',
    `printf '%s' '${b64}' | base64 -d | sudo tee ${ROOT}/env.sh.new >/dev/null`,
    `sudo chown root:mcp ${ROOT}/env.sh.new`,
    `sudo chmod 440 ${ROOT}/env.sh.new`,
    `sudo mv -f ${ROOT}/env.sh.new ${ROOT}/env.sh`,
  ].join('\n');
}

const PARSE_MCP_JSON = [
  'import json, sys',
  'try:',
  `    c = json.load(open("${APP}/mcp.json", encoding="utf-8"))`,
  'except Exception as e:',
  '    sys.exit("mcp.json 讀取失敗：%s" % e)',
  'if not isinstance(c, dict): sys.exit("mcp.json 必須是物件")',
  'r, s, i = c.get("runtime"), c.get("start"), c.get("install")',
  'if r not in ("python", "node"): sys.exit("mcp.json 的 runtime 必須是 python 或 node")',
  'if not isinstance(s, str) or not s.strip(): sys.exit("mcp.json 需要 start（啟動指令）")',
  'if i is not None and (not isinstance(i, str) or not i.strip()): sys.exit("mcp.json 的 install 必須是檔名")',
  'print(json.dumps({"runtime": r, "start": s, "install": i or ""}))',
].join('\n');

const TO_SHELL_VARS = [
  'import json, shlex, sys',
  'c = json.load(sys.stdin)',
  'for k in ("runtime", "start", "install"): print("%s=%s" % (k, shlex.quote(str(c.get(k) or ""))))',
].join('\n');

const PUT_STATE = 'import json, sys; print(json.dumps(dict(zip(sys.argv[1::2], sys.argv[2::2])), ensure_ascii=False))';

/**
 * 由服務 deploy 以 Sprite 帳號執行。下載網址只寫在 deploy/（700，mcp 進不去）；
 * 解壓、讀 mcp.json、安裝相依套件都經過沙盒，以 mcp 執行。
 */
export function deployScript(bundleUrl: string): string {
  return [
    '#!/bin/bash',
    'set -uo pipefail',
    `export PATH="$(cat ${ROOT}/path):$PATH"`,
    `put_state() { python3 -c ${shellQuote(PUT_STATE)} "$@" > "${DEPLOY}/state.json.tmp" && mv -f "${DEPLOY}/state.json.tmp" "${DEPLOY}/state.json"; }`,
    'fail() { echo "部署失敗：$1"; put_state phase failed error "$1"; exit 1; }',
    'if [ "${1:-}" != --steps ]; then',
    // 服務結束會被重啟：跑完就停在這裡，不要重新部署
    `  if [ -f "${DEPLOY}/state.json" ] && ! grep -q '"installing"' "${DEPLOY}/state.json"; then exec sleep infinity; fi`,
    `  exec >>"${DEPLOY}/log.txt" 2>&1`,
    '  put_state phase installing',
    '  timeout 540 /bin/bash "$0" --steps',
    '  rc=$?',
    '  if [ "$rc" = 124 ]; then put_state phase failed error "部署逾時（超過 9 分鐘）"',
    `  elif grep -q '"installing"' "${DEPLOY}/state.json"; then put_state phase failed error "部署失敗（結束碼 $rc）"; fi`,
    '  exec sleep infinity',
    'fi',
    'echo "== 下載套件"',
    `curl -fsSL -o "${DEPLOY}/bundle.zip" ${shellQuote(bundleUrl)} || fail "下載套件失敗"`,
    'echo "== 解壓縮"',
    `sudo rm -rf ${APP} && sudo install -d -m 700 -o mcp -g mcp ${APP} || fail "建立程式目錄失敗"`,
    `sudo install -m 400 -o mcp -g mcp "${DEPLOY}/bundle.zip" ${APP}/.bundle.zip && rm -f "${DEPLOY}/bundle.zip" || fail "搬移套件失敗"`,
    `${SANDBOXED} /bin/sh -c 'cd ${APP} && python3 -m zipfile -e .bundle.zip . && rm -f .bundle.zip' || fail "解壓縮失敗（需要 zip 檔）"`,
    'echo "== 讀取 mcp.json"',
    `conf="$(${SANDBOXED} python3 -c ${shellQuote(PARSE_MCP_JSON)})" || fail "mcp.json 缺少或格式錯誤（見日誌）"`,
    `eval "$(printf '%s' "$conf" | python3 -c ${shellQuote(TO_SHELL_VARS)})" || fail "mcp.json 格式錯誤"`,
    'case "$runtime" in python|node) ;; *) fail "mcp.json 的 runtime 必須是 python 或 node" ;; esac',
    'echo "== 安裝相依套件（$runtime）"',
    'if [ "$runtime" = python ] && [ -n "$install" ]; then',
    `  ${SANDBOXED} /bin/sh -c 'cd ${APP} && python3 -m venv .venv && .venv/bin/pip install -r "$1"' sh "$install" || fail "安裝相依套件失敗"`,
    'elif [ "$runtime" = python ]; then',
    `  ${SANDBOXED} /bin/sh -c 'cd ${APP} && python3 -m venv .venv' || fail "建立 Python 環境失敗"`,
    'elif [ -n "$install" ]; then',
    `  ${SANDBOXED} /bin/sh -c 'cd ${APP} && { npm ci || npm install; }' || fail "安裝相依套件失敗"`,
    'fi',
    'put_state phase installed start "$start"',
    'echo "== 安裝完成"',
    '',
  ].join('\n');
}

/** 先寫暫存檔再 mv（換新的 inode）：不改寫部署服務的 bash 正在逐段讀取的那個檔 */
function writeDeployCommand(script: string): string {
  const b64 = Buffer.from(script).toString('base64');
  return [
    'set -eu',
    `printf '%s' '${b64}' | base64 -d > ${DEPLOY_SCRIPT}.tmp`,
    `chmod 700 ${DEPLOY_SCRIPT}.tmp`,
    `mv -f ${DEPLOY_SCRIPT}.tmp ${DEPLOY_SCRIPT}`,
  ].join('\n');
}

function parseState(stdout: string): DeployState {
  const at = stdout.indexOf(LOG_MARK);
  const head = (at < 0 ? stdout : stdout.slice(0, at)).trim();
  const log = (at < 0 ? '' : stdout.slice(at + LOG_MARK.length)).trim();
  let state: Record<string, unknown> = {};
  try {
    if (head) state = JSON.parse(head);
  } catch {
    // 部署腳本以 mv 原子寫入；讀不懂就當作還在安裝
  }
  if (state.phase === 'installed' && typeof state.start === 'string') return { phase: 'installed', start: state.start, log };
  if (state.phase === 'failed') return { phase: 'failed', error: String(state.error ?? '部署失敗'), log };
  return { phase: 'installing', log };
}

type JsonRpcMessage = { id?: number; result?: Record<string, unknown>; error?: { message?: string } };

async function readRpc(res: Response, id: number): Promise<Record<string, unknown>> {
  const text = await res.text();
  const messages: JsonRpcMessage[] = (res.headers.get('content-type') ?? '').includes('text/event-stream')
    ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5).trim()))
    : [JSON.parse(text)].flat();
  const msg = messages.find((m) => m.id === id);
  if (!msg) throw new Error('MCP 沒有回應這個請求');
  if (msg.error) throw new Error(`MCP 錯誤：${msg.error.message ?? '未知'}`);
  return msg.result ?? {};
}

/** 以 MCP streamable HTTP 走完 initialize → initialized → tools/list */
export async function listToolsOver(
  fetchImpl: typeof fetch, url: string, headers: Record<string, string>,
): Promise<{ name: string; description?: string }[]> {
  let session: string | null = null;
  const post = async (body: object) => {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(session ? { 'mcp-session-id': session } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
      // 請求帶著平台的 Sprites token：不跟去別的網址
      redirect: 'error',
    });
    if (!res.ok) throw new Error(`MCP 回應 ${res.status}：${(await res.text()).slice(0, 200)}`);
    return res;
  };
  const init = await post({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agenthub-deploy-check', version: '1' } },
  });
  session = init.headers.get('mcp-session-id');
  await readRpc(init, 1);
  await (await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).text();
  const result = await readRpc(await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }), 2);
  const tools = Array.isArray(result.tools) ? (result.tools as { name: string; description?: string }[]) : [];
  return tools.map((t) => (t.description === undefined ? { name: t.name } : { name: t.name, description: t.description }));
}

type SpritesLike = Pick<SpritesClient, 'getSprite' | 'createSprite' | 'deleteSprite'>;

export function createHostedSpriteOps(
  deps: { client?: SpritesLike; spritesToken?: string; fetchImpl?: typeof fetch } = {},
): HostedSpriteOps {
  const client = () => deps.client ?? new SpritesClient(env.spritesToken);
  const token = () => deps.spritesToken ?? env.spritesToken;
  const sprite = (name: string): Promise<Sprite> => retryTransient(() => client().getSprite(name));

  return {
    async provision(version: HostedVersion, vars: Record<string, string>, bundleUrl: string) {
      const name = hostedSpriteName(version.id);
      const s = await retryTransient(async () => {
        try {
          return await client().getSprite(name);
        } catch (e) {
          if (!isNotFound(e)) throw e;
        }
        return client().createSprite(name, { urlSettings: { auth: 'sprite' } });
      });
      if (!s.url) throw new Error('代管 Sprite 沒有對外網址');
      await s.execFile('bash', ['-lc', HOSTED_SETUP_SCRIPT]);
      await s.execFile('bash', ['-lc', writeEnvCommand({ ...vars, AGENTHUB_MCP_URL: `${s.url}/mcp` })]);
      await s.execFile('bash', ['-lc', writeDeployCommand(deployScript(bundleUrl))]);
      const logs = await s.createService('deploy', { cmd: 'bash', args: [DEPLOY_SCRIPT] }, '1s');
      await logs.processAll(() => {});
      return { spriteName: name, spriteUrl: s.url };
    },

    async readState(name: string) {
      const s = await sprite(name);
      const { stdout } = await s.execFile('bash', ['-lc',
        `cat ${DEPLOY}/state.json 2>/dev/null; printf '\\n${LOG_MARK}\\n'; tail -n 100 ${DEPLOY}/log.txt 2>/dev/null; true`]);
      return parseState(String(stdout));
    },

    /** 可重複呼叫：服務已存在就不重建（重建會重啟正在啟動的程式） */
    async startService(name: string, start: string) {
      const s = await sprite(name);
      try {
        await s.getService('mcp');
        return;
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
      const logs = await s.createService('mcp', {
        cmd: 'sudo',
        args: ['-n', 'unshare', '--mount', '--propagation', 'private', '--', HOSTED_RUN, '/bin/bash', '-c', `cd ${APP} && exec ${start}`],
        httpPort: 8080,
      }, '5s');
      await logs.processAll(() => {});
    },

    async listTools(spriteUrl: string, creatorToken: string) {
      return listToolsOver(deps.fetchImpl ?? fetch, `${spriteUrl}/mcp`, {
        'x-agenthub-token': creatorToken,
        // Fly 驗證後就拿掉，不會到達創作者的程式
        authorization: `Bearer ${token()}`,
      });
    },

    async serviceLog(name: string) {
      const s = await sprite(name);
      const logs = await s.getServiceLogs('mcp', { lines: 100, duration: '1s' });
      const out: string[] = [];
      await logs.processAll((e) => {
        if ((e.type === 'stdout' || e.type === 'stderr') && e.data) out.push(e.data);
      });
      return out.join('').trimEnd();
    },

    async applyEnv(name: string, vars: Record<string, string>) {
      const s = await sprite(name);
      await s.execFile('bash', ['-lc', writeEnvCommand(vars)]);
      // 部署中還沒有 mcp 服務：寫好 env.sh 就夠了，啟動時會讀到
      try {
        await s.getService('mcp');
      } catch (e) {
        if (isNotFound(e)) return;
        throw e;
      }
      const logs = await s.restartService('mcp', '5s');
      await logs.processAll(() => {});
    },

    async destroy(name: string) {
      if (!name.startsWith('agenthub-mcp-')) throw new Error(`拒絕刪除非代管 MCP 的 Sprite：${name}`);
      await client().deleteSprite(name).catch((e) => {
        if (!isNotFound(e)) throw e;
      });
    },
  };
}
