import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';

/** 佈建時安裝的沙盒腳本（內容在 apps/web/lib/sprites.ts 的 SANDBOX_WRAPPER_SCRIPT） */
export const SANDBOX_WRAPPER = '/usr/local/bin/agenthub-sandbox';

/** 以沙盒執行時保留的環境變數；其他（含平台金鑰）一律不帶 */
const ENV_ALLOWLIST = ['PATH', 'LANG', 'TZ'];
/** Windows 本機開發時，少了這些 bash 等程式會起不來 */
const WINDOWS_ENV = ['SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE'];

export type Sandbox = {
  /** 以沙盒帳號執行；子行程是新的程序群組領頭（pid 即 pgid） */
  spawn(argv: string[], opts: { cwd: string; extraEnv?: Record<string, string> }): ChildProcessWithoutNullStreams;
  /** 終止 spawn 產生的整個程序群組 */
  kill(child: ChildProcess): void;
  /** 給 stdio MCP 用：把指令改寫成以沙盒帳號執行 */
  command(argv: string[], extraEnv?: Record<string, string>): { command: string; args: string[]; env: Record<string, string> };
};

/** pathPrefix：顧問自己的套件環境（.agenthub-venv/bin），排在 PATH 最前面 */
export function sandboxEnv(user: string | undefined, extraEnv: Record<string, string> = {}, pathPrefix?: string): Record<string, string> {
  const keys = process.platform === 'win32' ? [...ENV_ALLOWLIST, ...WINDOWS_ENV] : ENV_ALLOWLIST;
  const env: Record<string, string> = {};
  for (const k of keys) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  env.HOME = user ? `/home/${user}` : process.env.HOME ?? process.env.USERPROFILE ?? '/tmp';
  // sudo 會把 PATH 重設成系統預設；另外帶一份給沙盒腳本還原（node、python 裝在 /.sprite/languages 底下）
  if (user && env.PATH) env.SANDBOX_PATH = pathPrefix ? `${pathPrefix}:${env.PATH}` : env.PATH;
  else if (pathPrefix) env.PATH = env.PATH ? `${pathPrefix}${path.delimiter}${env.PATH}` : pathPrefix;
  return { ...env, ...safeExtraEnv(extraEnv) };
}

/** extraEnv 的名稱來自創作者的 MCP 設定，不可信：不能蓋掉沙盒自己的變數，也不能注入會被載入或改變執行方式的變數 */
const RESERVED_ENV = new Set(['PATH', 'HOME', 'SANDBOX_PATH', 'BASH_ENV', 'ENV', 'IFS', 'SHELLOPTS', 'BASHOPTS', 'CDPATH', 'GLOBIGNORE', 'PS4']);

function safeExtraEnv(extraEnv: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(extraEnv).filter(([k]) => !RESERVED_ENV.has(k) && !k.startsWith('LD_') && !k.startsWith('BASH_FUNC_')),
  );
}

/**
 * 以 user 執行 argv：以 root 開一個獨立的掛載命名空間，由沙盒腳本蓋掉 Sprite 內部 API 的 socket
 * （它能建立以 runtime 帳號執行的服務，且 socket 在唯讀掛載上、改不了權限），再降權成 user。
 * 環境變數由 spawn 的 env 決定（-E 原樣帶過去），祕密不會出現在指令參數。
 */
export function sudoArgv(user: string, argv: string[]): string[] {
  return ['sudo', '-n', '-E', '--', 'unshare', '--mount', '--propagation', 'private', '--', SANDBOX_WRAPPER, user, ...argv];
}

/** runtime 與沙盒是不同帳號，不能直接對沙盒的程序送訊號；改以沙盒帳號送出 */
export function killArgv(user: string, pgid: number): string[] {
  return ['sudo', '-n', '-u', user, '--', 'kill', '-KILL', '--', `-${pgid}`];
}

export function createSandbox(user?: string, opts: { pathPrefix?: string } = {}): Sandbox {
  const wrap = (argv: string[]) => (user ? sudoArgv(user, argv) : argv);
  return {
    spawn(argv, { cwd, extraEnv }) {
      const [cmd, ...args] = wrap(argv);
      // detached：成為獨立的程序群組，逾時或中止時能連同子行程一起終止
      return spawn(cmd, args, { cwd, env: sandboxEnv(user, extraEnv, opts.pathPrefix), detached: true });
    },
    kill(child) {
      if (child.pid === undefined) return;
      if (!user) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
        return;
      }
      const [cmd, ...args] = killArgv(user, child.pid);
      spawn(cmd, args, { stdio: 'ignore', env: sandboxEnv(user) }).on('error', () => undefined);
    },
    command(argv, extraEnv = {}) {
      const [command, ...args] = wrap(argv);
      return { command, args, env: sandboxEnv(user, extraEnv, opts.pathPrefix) };
    },
  };
}

/** 執行到結束並收集輸出；給檔案工具這類短指令用（bash 工具有自己的逾時與截斷） */
export function runInSandbox(
  sandbox: Sandbox,
  argv: string[],
  opts: { cwd: string; input?: string },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = sandbox.spawn(argv, { cwd: opts.cwd });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on('data', (c: Buffer) => out.push(c));
    child.stderr?.on('data', (c: Buffer) => err.push(c));
    child.on('error', (e) => resolve({ code: null, stdout: '', stderr: e.message }));
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }));
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(opts.input ?? '');
  });
}

/** 啟動時確認沙盒帳號真的能用，避免在沒有隔離的狀態下以為已隔離 */
export async function checkSandboxUser(user: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await runInSandbox(createSandbox(user), ['true'], { cwd: '/' });
  return r.code === 0 ? { ok: true } : { ok: false, error: r.stderr.trim() || `結束碼 ${r.code}` };
}

/** 佈建時安裝的顧問帳號腳本（內容在 apps/web/lib/sprites.ts 的 SANDBOX_ADDUSER_SCRIPT） */
export const SANDBOX_ADDUSER = '/usr/local/bin/agenthub-sandbox-adduser';

/** 每位顧問一個 Linux 帳號，以 uid 隔開彼此的 skill 與工作目錄 */
export function consultantUser(instanceId: string): string {
  return `agent-${instanceId.replace(/-/g, '').slice(0, 12).toLowerCase()}`;
}

/** 顧問以自己的帳號執行；主管與本機開發用 config.SANDBOX_USER（本機為 undefined） */
export function sandboxUserFor(config: { SANDBOX_USER?: string }, instanceId: string): string | undefined {
  return config.SANDBOX_USER ? consultantUser(instanceId) : undefined;
}

export type CommandRunner = (argv: string[]) => Promise<{ code: number | null; stderr: string }>;

const runCommand: CommandRunner = (argv) =>
  new Promise((resolve) => {
    const [cmd, ...args] = argv;
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('error', (e) => resolve({ code: null, stderr: e.message }));
    child.on('close', (code) => resolve({ code, stderr }));
  });

/** 已在這個 runtime 程序確認過的顧問；帳號與目錄建立後不會消失，不用每次 run 都呼叫 sudo */
const ensured = new Set<string>();

/** 確保每位顧問的沙盒帳號與目錄存在且權限正確；本機開發（沒有 SANDBOX_USER）不處理 */
export async function ensureConsultantSandboxes(
  sandboxUser: string | undefined,
  agentsRoot: string,
  instanceIds: string[],
  run: CommandRunner = runCommand,
): Promise<void> {
  if (!sandboxUser) return;
  for (const id of instanceIds) {
    if (ensured.has(id)) continue;
    const r = await run(['sudo', '-n', SANDBOX_ADDUSER, consultantUser(id), path.posix.join(agentsRoot, id)]);
    if (r.code !== 0) throw new Error(`無法建立顧問的沙盒帳號：${r.stderr.trim() || `結束碼 ${r.code}`}`);
    ensured.add(id);
  }
}
