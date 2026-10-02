import type { ToolEvent } from '@/lib/agent-output';

export const TOOL_LABELS: Record<string, string> = {
  bash: '執行指令', read_file: '讀取檔案', write_file: '寫入檔案', remember: '記下重點', recall: '查詢記憶',
};

export function ToolList({ tools }: { tools?: ToolEvent[] }) {
  if (!tools?.length) return null;
  const names = [...new Set(tools.map((t) => TOOL_LABELS[t.tool] ?? t.tool))];
  return <p className="mt-1 text-xs text-muted">用了工具：{names.join('、')}</p>;
}
