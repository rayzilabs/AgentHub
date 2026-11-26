import { CommandExitError, NotFoundError, Sandbox, type SandboxConnectOpts, type SandboxOpts } from 'e2b';
import { env } from '@/lib/env';
import type { Liveness, Machine, MachineKind, RuntimeHost, ServiceSpec } from './types';

export const E2B_TEMPLATES: Record<MachineKind, string> = { project: 'agenthub-runtime', mcp: 'agenthub-mcp' };
export const E2B_TIMEOUT_MS: Record<MachineKind, number> = { project: 300_000, mcp: 900_000 };

const SVC_PATH = '/usr/local/bin/agenthub-svc';

/**
 * E2B 沒有服務管理員：以迴圈執行指令，結束後等 2 秒重啟。
 * 用法：agenthub-svc <名稱> <指令> [參數…]；輸出附加到 /var/log/agenthub/<名稱>.log（每次重啟只留最後 1000 行）。
 */
export const E2B_SERVICE_SCRIPT = `#!/bin/bash
name="$1"; shift
mkdir -p /var/log/agenthub /run/agenthub /var/lib/agenthub/svc
log="/var/log/agenthub/$name.log"
echo $$ > "/run/agenthub/$name.pid"
args="/var/lib/agenthub/svc/$name.args"
printf '%s\\0' "$@" > "$args.tmp" && mv "$args.tmp" "$args"
while true; do
  if [ -f "$log" ]; then tail -n 1000 "$log" > "$log.tmp" && mv "$log.tmp" "$log"; fi
  "$@" >> "$log" 2>&1
  sleep 2
done
`;

// create／connect 在 SDK 裡是帶 this 泛型的靜態方法，改成一般簽章才能注入假物件
type SandboxSdk = Pick<typeof Sandbox, 'kill' | 'setTimeout' | 'getInfo' | 'list'> & {
  create(template: string, opts: SandboxOpts): Promise<Sandbox>;
  connect(sandboxId: string, opts?: SandboxConnectOpts): Promise<Sandbox>;
};

const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

function checkServiceName(name: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error(`服務名稱不合法：${name}`);
}

const isNotFound = (e: unknown): boolean => e instanceof NotFoundError;

export function createE2bHost(sdk: SandboxSdk = Sandbox): RuntimeHost {
  const api = () => ({ apiKey: env.e2bApiKey });

  async function connect(m: Machine) {
    return sdk.connect(m.name, api());
  }

  /** 非 0 結束時錯誤訊息帶 stderr */
  async function run(m: Machine, cmd: string, opts: { user?: 'root'; background?: boolean; timeoutMs?: number } = {}): Promise<string> {
    const sbx = await connect(m);
    try {
      const r = await sbx.commands.run(cmd, opts as never);
      return (r as { stdout: string }).stdout;
    } catch (e) {
      if (e instanceof CommandExitError) {
        throw new Error(`指令失敗（結束碼 ${e.exitCode}）：${(e.stderr || e.stdout || e.message).trim()}`);
      }
      throw e;
    }
  }

  async function stopService(m: Machine, name: string): Promise<void> {
    const pid = `/run/agenthub/${name}.pid`;
    await run(m, `if [ -f ${pid} ]; then sudo -n kill -TERM -- -"$(cat ${pid})" 2>/dev/null; sudo -n rm -f ${pid}; fi; true`);
  }

  async function ensureServiceScript(m: Machine): Promise<void> {
    try {
      await run(m, `test -x ${SVC_PATH}`);
    } catch {
      await run(m, `cat > ${SVC_PATH} <<'AGENTHUB_SVC_EOF'\n${E2B_SERVICE_SCRIPT}AGENTHUB_SVC_EOF\nchown root:root ${SVC_PATH} && chmod 755 ${SVC_PATH}`, { user: 'root' });
    }
  }

  async function infoState(id: string): Promise<Liveness> {
    try {
      const info = await sdk.getInfo(id, api());
      return info.state === 'paused' ? 'paused' : 'running';
    } catch (e) {
      if (isNotFound(e)) return 'gone';
      throw e;
    }
  }

  return {
    name: 'e2b',

    async create(claim, kind) {
      const sbx = await sdk.create(E2B_TEMPLATES[kind], {
        ...api(),
        timeoutMs: E2B_TIMEOUT_MS[kind],
        lifecycle: { onTimeout: 'pause', autoResume: true },
        network: { allowPublicTraffic: false },
        metadata: { app: 'agenthub', kind, claim },
      });
      return { host: 'e2b', name: sbx.sandboxId, url: `https://${sbx.getHost(8080)}`, token: sbx.trafficAccessToken ?? null };
    },

    async destroy(name, prefix) {
      const kill = async (id: string) => {
        try {
          await sdk.kill(id, api());
        } catch (e) {
          if (!isNotFound(e)) throw e;
        }
      };
      if (name.startsWith(prefix)) {
        // 傳入的是 claim：找出本平台、claim 相符的全部沙盒
        const pager = sdk.list({ ...api(), query: { metadata: { app: 'agenthub', claim: name } } });
        while (pager.hasNext) {
          for (const s of await pager.nextItems()) {
            if (s.metadata?.app === 'agenthub' && s.metadata.claim === name) await kill(s.sandboxId);
          }
        }
        return;
      }
      let info;
      try {
        info = await sdk.getInfo(name, api());
      } catch (e) {
        if (isNotFound(e)) return;
        throw e;
      }
      if (info.metadata?.app !== 'agenthub' || !info.metadata.claim?.startsWith(prefix)) {
        throw new Error(`拒絕刪除不屬於本平台或不是 ${prefix} 開頭的沙盒：${name}`);
      }
      await kill(name);
    },

    async exec(m, script) {
      return run(m, `bash -lc ${quote(script)}`);
    },

    async writeFile(m, path, content) {
      await (await connect(m)).files.write(path, content);
    },

    async startService(m, spec: ServiceSpec) {
      checkServiceName(spec.name);
      await ensureServiceScript(m);
      await stopService(m, spec.name);
      const cmd = ['sudo -n setsid agenthub-svc', spec.name, spec.cmd, ...spec.args].map((s, i) => (i === 0 ? s : quote(s))).join(' ');
      await run(m, cmd, { background: true, timeoutMs: 0 });
    },

    async hasService(m, name) {
      checkServiceName(name);
      const pid = `/run/agenthub/${name}.pid`;
      try {
        await run(m, `test -f ${pid} && sudo -n kill -0 "$(cat ${pid})"`);
        return true;
      } catch {
        return false;
      }
    },

    async restartService(m, name) {
      checkServiceName(name);
      const args = `/var/lib/agenthub/svc/${name}.args`;
      try {
        await run(m, `test -f ${args}`);
      } catch {
        throw new Error(`服務 ${name} 尚未啟動過，無法重啟`);
      }
      await stopService(m, name);
      await run(m, `sudo -n setsid xargs -0 -a ${args} agenthub-svc ${quote(name)}`, { background: true, timeoutMs: 0 });
    },

    async serviceLog(m, name, lines) {
      checkServiceName(name);
      const out = await run(m, `tail -n ${Math.max(1, Math.floor(lines))} /var/log/agenthub/${name}.log 2>/dev/null || true`);
      return out.trimEnd();
    },

    async extend(m, ms) {
      try {
        await sdk.setTimeout(m.name, ms, api());
        return 'running';
      } catch (e) {
        // 暫停中的沙盒 setTimeout 也會丟 NotFound，要用 getInfo 區分「暫停」與「真的不見」
        if (!isNotFound(e)) throw e;
        return infoState(m.name);
      }
    },

    async status(m) {
      return infoState(m.name);
    },

    edgeHeaders(m) {
      if (!m.token) throw new Error('E2B 沙盒缺少通行證（host_token）');
      return { 'e2b-traffic-access-token': m.token };
    },
  };
}
