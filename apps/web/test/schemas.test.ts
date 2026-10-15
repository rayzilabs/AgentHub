import { describe, expect, it } from 'vitest';
import { McpServerSchema, TemplateInputSchema, TemplatePatchSchema } from '@/lib/schemas';

describe('McpServerSchema', () => {
  it('remote 型：需要網址，不接受 headers 與金鑰', () => {
    expect(McpServerSchema.safeParse({ name: 'fin', transport: 'remote', url: 'https://c.example/mcp' }).success).toBe(true);
    expect(McpServerSchema.safeParse({ name: 'fin', transport: 'remote' }).error?.issues[0].message).toBe('MCP「fin」需要網址');
    expect(McpServerSchema.safeParse({ name: 'fin', transport: 'remote', url: 'http://c.example/mcp' }).error?.issues[0].message)
      .toBe('MCP「fin」的網址必須是 https');
    const withHeaders = McpServerSchema.safeParse({ name: 'fin', transport: 'remote', url: 'https://c.example/mcp', headers: { A: 'b' } });
    expect(withHeaders.error?.issues[0].message).toBe('MCP「fin」由平台通行證驗證，不能設定標頭或金鑰');
    expect(McpServerSchema.safeParse({
      name: 'fin', transport: 'remote', url: 'https://c.example/mcp', required_secrets: [{ key: 'K' }],
    }).success).toBe(false);
  });

  it('平台代管：不需要也不能給網址', () => {
    expect(McpServerSchema.safeParse({ name: 'fin', transport: 'remote', hosted: true }).success).toBe(true);
    expect(McpServerSchema.safeParse({ name: 'fin', transport: 'remote', hosted: true, url: 'https://c.example/mcp' })
      .error?.issues[0].message).toBe('MCP「fin」由平台代管，不需要網址');
    expect(McpServerSchema.safeParse({ name: 'fin', transport: 'remote', hosted: false }).error?.issues[0].message)
      .toBe('MCP「fin」需要網址');
  });

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
