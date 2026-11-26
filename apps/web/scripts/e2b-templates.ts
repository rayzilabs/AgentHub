import { fileURLToPath } from 'node:url';

process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));

const { Sandbox, Template } = await import('e2b');
const { env } = await import('@/lib/env');
const { E2B_TEMPLATES, createE2bHost } = await import('@/lib/hosts/e2b');

const apiKey = env.e2bApiKey;

// 基底映像的 node 在 /usr/local（sudo 的 secure_path 也含此處），直接以官方 v22 LTS 覆蓋
const INSTALL_NODE22 = `set -e
v=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | grep -o 'node-v22[0-9.]*-linux-x64.tar.gz' | head -1)
curl -fsSL "https://nodejs.org/dist/latest-v22.x/$v" | tar -xz -C /usr/local --strip-components=1 --exclude='*.md' --exclude=LICENSE
node -v | grep -q '^v22\.'`;

const base = () => Template().fromBaseImage().setUser('root').runCmd(INSTALL_NODE22);

const runtime = base()
  .aptInstall(['golang-go', 'default-jre-headless', 'ruby'], { noInstallRecommends: true })
  // 基底的 python3 在 /usr/local，以它的 pip 全域安裝，所有帳號都 import 得到
  .runCmd('python3 -m pip install numpy pandas')
  .setUser('user');
const mcp = base().setUser('user');

type Spec = { name: string; template: ReturnType<typeof base>; cpuCount: number; memoryMB: number; checks: [string, string][] };

const specs: Spec[] = [
  {
    name: E2B_TEMPLATES.project,
    template: runtime,
    cpuCount: 2,
    memoryMB: 8192,
    checks: [
      ['node 22', 'node -v | grep -q "^v22\."'],
      ['node 22（sudo -u user）', 'sudo -n -u user -H -- node -v | grep -q "^v22\."'],
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
    ],
  },
  {
    name: E2B_TEMPLATES.mcp,
    template: mcp,
    cpuCount: 1,
    memoryMB: 2048,
    checks: [
      ['node 22', 'node -v | grep -q "^v22\."'],
      ['python3', 'python3 --version'],
      ['pip', 'pip --version || pip3 --version'],
    ],
  },
];

let failed = 0;

async function verify(spec: Spec): Promise<void> {
  const sbx = await Sandbox.create(spec.name, { apiKey, timeoutMs: 300_000 });
  try {
    for (const [label, cmd] of spec.checks) {
      try {
        const r = await sbx.commands.run(cmd);
        console.log(`  通過 ${label}：${r.stdout.trim().split('\n')[0]}`);
      } catch (e) {
        failed++;
        console.error(`  失敗 ${label}：${e instanceof Error ? e.message : e}`);
      }
    }
  } finally {
    await sbx.kill();
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
