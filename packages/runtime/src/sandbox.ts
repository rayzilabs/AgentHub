import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';

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

export function sandboxEnv(user: string | undefined, extraEnv: Record<string, string> = {}): Record<string, string> {
  const keys = process.platform === 'win32' ? [...ENV_ALLOWLIST, ...WINDOWS_ENV] : ENV_ALLOWLIST;
  const env: Record<string, string> = {};
  for (const k of keys) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  env.HOME = user ? `/home/${user}` : process.env.HOME ?? process.env.USERPROFILE ?? '/tmp';
  return { ...env, ...extraEnv };
}

/**
 * 以 user 執行 argv。環境變數由 spawn 的 env 決定（-E 原樣帶過去），祕密不會出現在指令參數；
 * umask 002 讓 runtime 也能整理 agent 建立的檔案。
 */
export function sudoArgv(user: string, argv: string[]): string[] {
  return ['sudo', '-n', '-E', '-u', user, '--', 'sh', '-c', 'umask 002; exec "$@"', 'sandbox', ...argv];
}

/** runtime 與沙盒是不同帳號，不能直接對沙盒的程序送訊號；改以沙盒帳號送出 */
export function killArgv(user: string, pgid: number): string[] {
  return ['sudo', '-n', '-u', user, '--', 'kill', '-KILL', '--', `-${pgid}`];
}

export function createSandbox(user?: string): Sandbox {
  const wrap = (argv: string[]) => (user ? sudoArgv(user, argv) : argv);
  return {
    spawn(argv, { cwd, extraEnv }) {
      const [cmd, ...args] = wrap(argv);
      // detached：成為獨立的程序群組，逾時或中止時能連同子行程一起終止
      return spawn(cmd, args, { cwd, env: sandboxEnv(user, extraEnv), detached: true });
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
      return { command, args, env: sandboxEnv(user, extraEnv) };
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
