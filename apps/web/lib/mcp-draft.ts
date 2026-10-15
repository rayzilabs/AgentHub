import type { McpServer } from '@/lib/schemas';

/** 範本編輯頁「工具（MCP）」表單的一列；hosted 存成 { transport: 'remote', hosted: true } */
export type McpDraft = {
  name: string;
  transport: 'stdio' | 'http' | 'remote' | 'hosted';
  command: string;
  args: string;
  url: string;
  headers: string;
  secrets: string;
};

export function toDraft(s: McpServer): McpDraft {
  return {
    name: s.name,
    transport: s.transport === 'remote' && s.hosted ? 'hosted' : s.transport,
    command: s.command ?? '',
    args: (s.args ?? []).join(' '),
    url: s.url ?? '',
    headers: Object.entries(s.headers ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n'),
    secrets: (s.required_secrets ?? []).map((r) => r.key).join(', '),
  };
}

export function fromDraft(d: McpDraft): McpServer {
  const required_secrets = d.secrets.split(',').map((k) => k.trim()).filter(Boolean).map((key) => ({ key }));
  if (d.transport === 'stdio') {
    return { name: d.name.trim(), transport: 'stdio', command: d.command.trim(), args: d.args.split(/\s+/).filter(Boolean), required_secrets };
  }
  // 平台代管：金鑰在代管區塊設定，不放在範本設定裡
  if (d.transport === 'hosted') return { name: d.name.trim(), transport: 'remote', hosted: true, required_secrets: [] };
  if (d.transport === 'remote') return { name: d.name.trim(), transport: 'remote', url: d.url.trim(), required_secrets: [] };
  const headers = Object.fromEntries(
    d.headers.split('\n').map((line) => line.split(/:([\s\S]*)/).map((x) => x.trim())).filter(([k, v]) => k && v),
  );
  return { name: d.name.trim(), transport: 'http', url: d.url.trim(), headers, required_secrets };
}

export const emptyDraft: McpDraft = { name: '', transport: 'stdio', command: '', args: '', url: '', headers: '', secrets: '' };

/** 這個名稱在已儲存的設定裡是平台代管（才能呼叫代管 API） */
export function isSavedHosted(saved: McpServer[], name: string): boolean {
  return saved.some((s) => s.name === name && s.transport === 'remote' && s.hosted === true);
}
