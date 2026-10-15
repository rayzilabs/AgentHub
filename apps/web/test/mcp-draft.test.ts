import { describe, expect, it } from 'vitest';
import { emptyDraft, fromDraft, isSavedHosted, toDraft } from '@/lib/mcp-draft';
import type { McpServer } from '@/lib/schemas';

describe('MCP 表單草稿', () => {
  it('平台代管往返後仍是 hosted，不帶網址與金鑰', () => {
    const hosted: McpServer = { name: 'fin', transport: 'remote', hosted: true, required_secrets: [] };
    expect(toDraft(hosted).transport).toBe('hosted');
    expect(fromDraft(toDraft(hosted))).toEqual({ name: 'fin', transport: 'remote', hosted: true, required_secrets: [] });
    expect(fromDraft({ ...emptyDraft, name: ' fin ', transport: 'hosted', url: 'https://x', secrets: 'A' }))
      .toEqual({ name: 'fin', transport: 'remote', hosted: true, required_secrets: [] });
  });

  it('自己架的 remote、stdio、http 照舊', () => {
    const remote: McpServer = { name: 'r', transport: 'remote', url: 'https://c.example/mcp', required_secrets: [] };
    expect(fromDraft(toDraft(remote))).toEqual(remote);
    const stdio: McpServer = { name: 's', transport: 'stdio', command: 'npx', args: ['-y', 'x'], required_secrets: [{ key: 'K' }] };
    expect(fromDraft(toDraft(stdio))).toEqual(stdio);
    const http: McpServer = { name: 'h', transport: 'http', url: 'https://h', headers: { Authorization: 'Bearer ${K}' }, required_secrets: [{ key: 'K' }] };
    expect(fromDraft(toDraft(http))).toEqual(http);
  });

  it('isSavedHosted：只有已儲存且為平台代管的名稱', () => {
    const saved: McpServer[] = [
      { name: 'fin', transport: 'remote', hosted: true, required_secrets: [] },
      { name: 'web', transport: 'remote', url: 'https://w', required_secrets: [] },
    ];
    expect(isSavedHosted(saved, 'fin')).toBe(true);
    expect(isSavedHosted(saved, 'web')).toBe(false);
    expect(isSavedHosted(saved, 'new')).toBe(false);
  });
});
