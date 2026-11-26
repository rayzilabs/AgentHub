import { fileURLToPath } from 'node:url';
import type { MachineKind } from '@/lib/hosts/types';

process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));

const { Sandbox, Template } = await import('e2b');
const { env } = await import('@/lib/env');
const { E2B_TEMPLATES, createE2bHost } = await import('@/lib/hosts/e2b');

const apiKey = env.e2bApiKey;

// 基底映像的 node 在 /usr/local（sudo 的 secure_path 也含此處），直接以官方 v22 LTS 覆蓋
const INSTALL_NODE22 = `set -euo pipefail
base=https://nodejs.org/dist/latest-v22.x
cd /tmp
curl -fsSL "$base/SHASUMS256.txt" -o SHASUMS256.txt
line=$(grep -E ' node-v22[0-9.]*-linux-x64[.]tar[.]gz$' SHASUMS256.txt | head -1)
test -n "$line"
curl -fsSL "$base/\${line##* }" -o node.tar.gz
echo "\${line%% *}  node.tar.gz" | sha256sum -c -
# 先移除基底的舊 npm／corepack：直接覆蓋會留下舊版的檔案，新舊混在一起時 npm install 一律失敗
rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
tar -xzf node.tar.gz -C /usr/local --strip-components=1 --exclude='*.md' --exclude=LICENSE
rm -f node.tar.gz SHASUMS256.txt
node -v | grep -q '^v22[.]'`;

/**
 * 基底映像的 root 與 user 是空密碼，sshd 又允許空密碼與 root 登入：沙盒帳號不用密碼就能 su／ssh 成 root。
 * 這裡鎖住 root 與 user、整個移除 sshd（本平台不用）。但 user 的空密碼與 /usr/local 其他帳號可寫，會在範本建置最後一步
 * 被改回去（2026-11-27 實測：root 維持鎖住、sshd 不在），所以每台建立後還要再鎖一次（lib/hosts/e2b.ts 的 E2B_LOCKDOWN_SCRIPT）。
 */
const HARDEN = `set -euo pipefail
usermod -p '*' root
usermod -p '*' user
systemctl disable --now ssh.service ssh.socket 2>/dev/null || true
DEBIAN_FRONTEND=noninteractive apt-get purge -y openssh-server openssh-sftp-server`;

const base = () => Template().fromBaseImage().setUser('root').runCmd(INSTALL_NODE22);

const runtime = base()
  .aptInstall(['golang-go', 'default-jre-headless', 'ruby'], { noInstallRecommends: true })
  // 基底的 python3 在 /usr/local，以它的 pip 全域安裝，所有帳號都 import 得到
  .runCmd('python3 -m pip install numpy pandas')
  .runCmd(HARDEN)
  .setUser('user');
const mcp = base().runCmd(HARDEN).setUser('user');

/** plain <指令…>：以沒有 sudo 的一般帳號執行（沙盒帳號的角度） */
const PLAIN = 'plain() { id -u agenthub-check >/dev/null 2>&1 || sudo -n useradd -m agenthub-check; sudo -n -u agenthub-check -H -- "$@"; };';
/** 系統目錄裡其他帳號可寫、又沒有 sticky bit 的項目 */
const WORLD_WRITABLE = 'find /usr /etc /opt /bin /sbin /lib /code \\( -perm -0002 ! -type l ! -perm -1000 \\) -print 2>/dev/null | head -5';
const SECURITY_CHECKS: [string, string][] = [
  ['沒有空密碼的帳號', `sudo -n test -s /etc/shadow && ! sudo -n awk -F: '$2 == ""' /etc/shadow | grep -q .`],
  // 先確認一般帳號真的跑得起來，免得 sudo -u 本身失敗被當成 su 失敗
  ['一般帳號 su root／user 不用密碼會失敗', `${PLAIN} test "$(plain id -un)" = agenthub-check && ! plain su root -c true </dev/null && ! plain su user -c true </dev/null`],
  ['沒有程序聽 22 埠', `out=$(ss -ltnH) || exit 1; ! printf '%s\\n' "$out" | awk '{print $4}' | grep -qE ':22$'`],
  ['系統目錄沒有其他帳號可寫的項目', `test -z "$(${WORLD_WRITABLE})"`],
  ['user 仍可 sudo -n', 'sudo -n true'],
  ['一般帳號能 npm install', `${PLAIN} plain sh -c 'cd "$(mktemp -d)" && npm init -y >/dev/null && npm install --no-audit --no-fund is-number@7 && node -e "require(\\"is-number\\")"'`],
];

type Spec = { name: string; kind: MachineKind; template: ReturnType<typeof base>; cpuCount: number; memoryMB: number; checks: [string, string][] };

const specs: Spec[] = [
  {
    name: E2B_TEMPLATES.project,
    kind: 'project',
    template: runtime,
    cpuCount: 2,
    memoryMB: 8192,
    checks: [
      ['node 22', 'node -v | grep -q "^v22[.]"'],
      ['node 22（sudo -u user）', 'sudo -n -u user -H -- node -v | grep -q "^v22[.]"'],
      ['npm', 'npm --version'],
      ['python3', 'python3 --version'],
      ['pip', 'pip --version || pip3 --version'],
      ['numpy、pandas', 'python3 -c "import numpy, pandas"'],
      ['numpy、pandas（sudo -u user）', 'sudo -n -u user -H -- python3 -c "import numpy, pandas"'],
      ['go', 'go version'],
      ['java', 'java -version'],
      ['ruby', 'ruby --version'],
      ['git', 'git --version'],
      ['curl', 'curl --version | head -1'],
      ...SECURITY_CHECKS,
    ],
  },
  {
    name: E2B_TEMPLATES.mcp,
    kind: 'mcp',
    template: mcp,
    cpuCount: 1,
    memoryMB: 2048,
    checks: [
      ['node 22', 'node -v | grep -q "^v22[.]"'],
      ['python3', 'python3 --version'],
      ['pip', 'pip --version || pip3 --version'],
      ...SECURITY_CHECKS,
    ],
  },
];

let failed = 0;

// 以平台建立機器的方式（含建立後的權限鎖定）開一台來檢查：檢查的是平台實際拿到的沙盒
async function verify(spec: Spec): Promise<void> {
  const host = createE2bHost();
  const m = await host.create('agenthub-eval-check', spec.kind);
  try {
    const sbx = await Sandbox.connect(m.name, { apiKey });
    for (const [label, cmd] of spec.checks) {
      try {
        const r = await sbx.commands.run(cmd);
        console.log(`  通過 ${label}：${r.stdout.trim().split('\n')[0]}`);
      } catch (e) {
        failed++;
        console.error(`  失敗 ${label}：${e instanceof Error ? e.message : e}`);
      }
    }
    // 平台以 envd 用 root 執行指令（服務看守），鎖住 root 密碼後要照常
    const root = await sbx.commands.run('id -u', { user: 'root' }).then((r) => r.stdout.trim(), (e: Error) => e.message);
    if (root !== '0') failed++;
    console.log(`  ${root === '0' ? '通過' : '失敗'} envd 以 root 執行：${root}`);
  } finally {
    await host.destroy(m.name, 'agenthub-').catch(() => Sandbox.kill(m.name, { apiKey }));
  }
}

// 服務監督迴圈要靠同一個程序群組才停得掉：確認 sudo 沒有另開 session，且子程序以 user 執行
async function verifySupervisor(): Promise<void> {
  const host = createE2bHost();
  const m = await host.create('agenthub-eval-check', 'project');
  try {
    console.log(`  ${(await host.exec(m, 'sudo -V | head -1')).trim()}`);
    console.log(`  ${(await host.exec(m, 'sudo -n -l -U user')).trim().replace(/\n/g, ' | ')}`);
    await host.startService(m, { name: 'evalsvc', cmd: 'node', args: ['-e', 'setInterval(()=>{},1e3)'] });
    await new Promise((r) => setTimeout(r, 3000));
    const ps = await host.exec(m, 'ps -eo pid,pgid,sid,user,args | grep -E "agenthub-svc|setInterval" | grep -v grep');
    console.log(ps.trimEnd().split('\n').map((l) => `  ${l}`).join('\n'));
    const rows = ps.trim().split('\n').map((l) => l.trim().split(/\s+/));
    const loop = rows.find((r) => r.slice(4).join(' ').includes('agenthub-svc'));
    const child = rows.find((r) => r[3] === 'user' && r.slice(4).join(' ').includes('setInterval'));
    const ok = !!loop && !!child && loop[1] === child[1];
    if (!ok) failed++;
    console.log(`  ${ok ? '通過' : '失敗'} 監督迴圈與子程序同一個程序群組且以 user 執行`);
    const v = await host.exec(m, 'sudo -n -u user -H -- node -v');
    console.log(`  sudo 下的 node：${v.trim()}`);
    await host.exec(m, 'sudo -n agenthub-svc --stop evalsvc');
    const left = await host.exec(m, 'pgrep -u user node || echo none');
    const stopped = left.trim() === 'none';
    if (!stopped) failed++;
    console.log(`  ${stopped ? '通過' : '失敗'} --stop 後子程序已結束`);
  } finally {
    await host.destroy(m.name, 'agenthub-').catch(() => Sandbox.kill(m.name, { apiKey }));
  }
}

for (const spec of specs) {
  console.log(`建立範本 ${spec.name}（${spec.cpuCount} vCPU、${spec.memoryMB} MB）…`);
  await Template.build(spec.template, spec.name, { cpuCount: spec.cpuCount, memoryMB: spec.memoryMB, apiKey });
  console.log(`檢查範本 ${spec.name}`);
  await verify(spec);
}

console.log('檢查服務監督迴圈（sudo／程序群組）');
await verifySupervisor();

if (failed > 0) {
  console.error(`${failed} 項檢查失敗`);
  process.exit(1);
}
console.log('全部檢查通過');
