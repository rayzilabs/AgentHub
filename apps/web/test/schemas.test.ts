import { describe, expect, it } from 'vitest';
import { McpServerSchema, TemplateInputSchema, TemplatePatchSchema } from '@/lib/schemas';

describe('McpServerSchema', () => {
  it('stdio 需要 command；http 需要 url', () => {
    expect(McpServerSchema.safeParse({ name: 'a', transport: 'stdio' }).error?.issues[0].message).toBe('MCP「a」需要啟動指令');
    expect(McpServerSchema.safeParse({ name: 'b', transport: 'http' }).error?.issues[0].message).toBe('MCP「b」需要網址');
    expect(McpServerSchema.parse({ name: 'c', transport: 'stdio', command: 'npx', args: ['x'] }).required_secrets).toEqual([]);
  });

  it('名稱與金鑰名稱格式', () => {
    expect(McpServerSchema.safeParse({ name: '台股', transport: 'http', url: 'https://x.dev' }).success).toBe(false);
    expect(McpServerSchema.safeParse({
      name: 'fin', transport: 'http', url: 'https://x.dev', required_secrets: [{ key: 'lower' }],
    }).success).toBe(false);
  });
});

describe('TemplateInputSchema', () => {
  it('補上預設值並修剪空白', () => {
    expect(TemplateInputSchema.parse({ name: '  法務顧問 ' })).toEqual({
      name: '法務顧問', description: '', category: '', system_prompt: '', mcp_servers: [],
    });
  });

  it('MCP 名稱不可重複', () => {
    const r = TemplateInputSchema.safeParse({
      name: 'x',
      mcp_servers: [
        { name: 'a', transport: 'http', url: 'https://a.dev' },
        { name: 'a', transport: 'http', url: 'https://b.dev' },
      ],
    });
    expect(r.error?.issues[0].message).toBe('MCP 名稱「a」重複');
  });

  it('patch 全部欄位可省略', () => {
    expect(TemplatePatchSchema.parse({ process_upload: true })).toEqual({ process_upload: true });
  });
});
