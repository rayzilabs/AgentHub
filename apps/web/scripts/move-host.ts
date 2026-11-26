// 用法：cd apps/web && pnpm exec tsx scripts/move-host.ts --to <sprite|e2b> (--project <id> | --version <id> | --all)
//   --project <id>   搬一個專案的機器
//   --version <id>   搬一個代管 MCP 版本（只搬 published、ready）
//   --all            先搬全部專案，再搬全部代管 MCP 版本；一次一台，搬好的 E2B 沙盒 15 秒後暫停（E2B Hobby 同時最多 10 台執行中）
// 每台印一行結果，最後列出跳過與失敗的；有失敗時 exit 1
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { HostName } from '@/lib/hosts/types';

const USAGE = '用法：move-host.ts --to <sprite|e2b> (--project <id> | --version <id> | --all)';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type MoveArgs = {
  to: HostName;
  target: { kind: 'project'; id: string } | { kind: 'version'; id: string } | { kind: 'all' };
};

export function parseArgs(argv: string[]): MoveArgs {
  let to: string | undefined;
  const targets: MoveArgs['target'][] = [];
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--to' && i + 1 < argv.length) to = argv[++i];
    else if ((flag === '--project' || flag === '--version') && UUID.test(argv[i + 1] ?? '')) {
      targets.push({ kind: flag === '--project' ? 'project' : 'version', id: argv[++i] });
    } else if (flag === '--all') targets.push({ kind: 'all' });
    else throw new Error(USAGE);
  }
  if ((to !== 'sprite' && to !== 'e2b') || targets.length !== 1) throw new Error(USAGE);
  return { to, target: targets[0] };
}

export type MoveOutcome = 'moved' | 'already-there' | 'skipped' | 'skipped-running';
export type MoveItem = { label: string; run: () => Promise<MoveOutcome> };
export type MoveSummary = { moved: string[]; alreadyThere: string[]; skipped: string[]; failed: string[] };

const OUTCOME_TEXT: Record<MoveOutcome, string> = {
  moved: '已搬遷',
  'already-there': '已在目標執行環境',
  skipped: '跳過（狀態不需要搬）',
  'skipped-running': '跳過（有進行中的對話）',
};

/** 依序一台一台搬（不並行），每台印一行，最後印摘要 */
export async function moveEach(items: MoveItem[], print: (line: string) => void = console.log): Promise<MoveSummary> {
  const summary: MoveSummary = { moved: [], alreadyThere: [], skipped: [], failed: [] };
  for (const item of items) {
    try {
      const outcome = await item.run();
      print(`${item.label}：${OUTCOME_TEXT[outcome]}`);
      if (outcome === 'moved') summary.moved.push(item.label);
      else if (outcome === 'already-there') summary.alreadyThere.push(item.label);
      else summary.skipped.push(item.label);
    } catch (e) {
      print(`${item.label}：失敗（${e instanceof Error ? e.message : String(e)}）`);
      summary.failed.push(item.label);
    }
  }
  print(`完成：搬遷 ${summary.moved.length}、已在目標 ${summary.alreadyThere.length}、跳過 ${summary.skipped.length}、失敗 ${summary.failed.length}`);
  if (summary.skipped.length) print(`跳過：${summary.skipped.join('、')}`);
  if (summary.failed.length) print(`失敗：${summary.failed.join('、')}`);
  return summary;
}

async function main(): Promise<void> {
  process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
  const { to, target } = parseArgs(process.argv.slice(2));
  const { adminDb } = await import('@/lib/supabase/admin');
  const { moveHostedVersion, moveProject, MOVABLE_VERSION_STATUSES } = await import('@/lib/services/move-host');
  const db = adminDb();
  const project = (id: string): MoveItem => ({ label: `專案 ${id}`, run: () => moveProject(db, id, to) });
  const version = (id: string): MoveItem => ({ label: `代管版本 ${id}`, run: () => moveHostedVersion(db, id, to) });

  let items: MoveItem[];
  if (target.kind === 'project') items = [project(target.id)];
  else if (target.kind === 'version') items = [version(target.id)];
  else {
    const { data: projects, error } = await db.from('projects').select('id').order('created_at');
    if (error) throw error;
    const { data: versions, error: versionError } = await db.from('hosted_mcp_versions').select('id')
      .in('status', MOVABLE_VERSION_STATUSES).order('created_at');
    if (versionError) throw versionError;
    items = [...projects.map((p) => project(p.id as string)), ...versions.map((v) => version(v.id as string))];
  }
  const summary = await moveEach(items);
  // SDK 的連線可能讓程序不結束；結果印完就離開
  process.exit(summary.failed.length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
