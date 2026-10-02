import { z } from 'zod';

export const McpServerSchema = z
  .object({
    name: z.string().trim().min(1, 'MCP 需要名稱').regex(/^[A-Za-z0-9_-]+$/, 'MCP 名稱只能用英數字、- 和 _'),
    transport: z.enum(['stdio', 'http']),
    command: z.string().trim().optional(),
    args: z.array(z.string()).optional(),
    url: z.url('MCP 網址格式不正確').optional(),
    headers: z.record(z.string(), z.string()).optional(),
    required_secrets: z
      .array(z.object({
        key: z.string().regex(/^[A-Z][A-Z0-9_]*$/, '金鑰名稱只能用大寫英文、數字和底線，且以英文開頭'),
        description: z.string().optional(),
      }))
      .default([]),
  })
  .superRefine((s, ctx) => {
    if (s.transport === 'stdio' && !s.command) {
      ctx.addIssue({ code: 'custom', message: `MCP「${s.name}」需要啟動指令`, path: ['command'] });
    }
    if (s.transport === 'http' && !s.url) {
      ctx.addIssue({ code: 'custom', message: `MCP「${s.name}」需要網址`, path: ['url'] });
    }
  });

export type McpServer = z.infer<typeof McpServerSchema>;

const McpServerList = z.array(McpServerSchema).superRefine((list, ctx) => {
  const seen = new Set<string>();
  for (const s of list) {
    if (seen.has(s.name)) ctx.addIssue({ code: 'custom', message: `MCP 名稱「${s.name}」重複` });
    seen.add(s.name);
  }
});

const TemplateFields = {
  name: z.string().trim().min(1, '請填寫名稱').max(60, '名稱最多 60 個字'),
  description: z.string().trim().max(500, '介紹最多 500 個字'),
  category: z.string().trim().max(30, '分類最多 30 個字'),
  system_prompt: z.string(),
  mcp_servers: McpServerList,
};

export const TemplateInputSchema = z.object({
  name: TemplateFields.name,
  description: TemplateFields.description.default(''),
  category: TemplateFields.category.default(''),
  system_prompt: TemplateFields.system_prompt.default(''),
  mcp_servers: TemplateFields.mcp_servers.default([]),
});
export type TemplateInput = z.infer<typeof TemplateInputSchema>;

export const TemplatePatchSchema = z.object({
  name: TemplateFields.name.optional(),
  description: TemplateFields.description.optional(),
  category: TemplateFields.category.optional(),
  system_prompt: TemplateFields.system_prompt.optional(),
  mcp_servers: TemplateFields.mcp_servers.optional(),
  process_upload: z.boolean().optional(),
});
export type TemplatePatch = z.infer<typeof TemplatePatchSchema>;
