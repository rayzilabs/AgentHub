import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cleanupFailed, parseArgs } from '../scripts/hosted-mcp';
import { createTemplate } from '@/lib/services/templates';
import { parseMcpJson, type HostedSpriteOps } from '@/lib/services/hosted-mcp';
import { seedUser, testDb } from './helpers';

const examples = fileURLToPath(new URL('../../../docs/creator/examples/', import.meta.url));
const read = (p: string) => readFileSync(`${examples}${p}`, 'utf8');

describe('代管 MCP 範本', () => {
  it('兩個範本的 mcp.json 都合格', () => {
    expect(parseMcpJson(read('hosted-python/mcp.json'))).toEqual({ runtime: 'python', start: 'python server.py', install: 'requirements.txt' });
    expect(parseMcpJson(read('hosted-node/mcp.json'))).toEqual({ runtime: 'node', start: 'node server.mjs', install: 'package.json' });
  });

  it('都驗證 X-AgentHub-Token，aud 取自 AGENTHUB_MCP_URL、iss 取自 AGENTHUB_PLATFORM_URL', () => {
    for (const file of ['hosted-python/server.py', 'hosted-node/server.mjs']) {
      const src = read(file);
      expect(src).toMatch(/x-agenthub-token/i);
      expect(src).toContain('AGENTHUB_MCP_URL');
      expect(src).toContain('AGENTHUB_PLATFORM_URL');
      expect(src).toContain('/.well-known/jwks.json');
      expect(src).toContain('ES256');
    }
    expect(read('hosted-python/requirements.txt')).toContain('mcp==2.3.0');
  });
});

describe('營運腳本 hosted-mcp.ts', () => {
  it('參數解析', () => {
    expect(parseArgs(['disable', '123e4567-e89b-12d3-a456-426614174000'])).toEqual({ cmd: 'disable', id: '123e4567-e89b-12d3-a456-426614174000' });
    expect(parseArgs(['cleanup-failed'])).toEqual({ cmd: 'cleanup-failed' });
    expect(() => parseArgs(['disable'])).toThrow('用法');
    expect(() => parseArgs(['disable', 'not-a-uuid'])).toThrow('用法');
    expect(() => parseArgs([])).toThrow('用法');
  });

  it('cleanup-failed：刪掉失敗超過 24 小時（與下架後沒刪成功）的 Sprite，sprite_name 改 null', async () => {
    const db = testDb();
    const creator = await seedUser(db);
    const t = await createTemplate(db, creator.id, {
      name: '代管顧問', description: '', category: '', system_prompt: 'p',
      mcp_servers: [{ name: 'fin', transport: 'remote', hosted: true, required_secrets: [] }],
    });
    const old = new Date(Date.now() - 25 * 3600_000).toISOString();
    const rows = [
      { version: 1, status: 'failed', sprite_name: 'agenthub-mcp-old', deploy_started_at: old },
      { version: 2, status: 'failed', sprite_name: 'agenthub-mcp-new', deploy_started_at: new Date().toISOString() },
      { version: 3, status: 'retired', sprite_name: 'agenthub-mcp-leak', deploy_started_at: old },
      { version: 4, status: 'published', sprite_name: 'agenthub-mcp-live', deploy_started_at: old },
    ];
    const { error } = await db.from('hosted_mcp_versions').insert(rows.map((r) => ({ ...r, template_id: t.id, mcp_name: 'fin', bundle_path: 'x' })));
    if (error) throw error;
    const destroyed: string[] = [];
    const ops = { destroy: async (name: string) => { destroyed.push(name); } } as unknown as HostedSpriteOps;
    // 測試打正式資料庫：只清這個範本，不碰真實版本
    await cleanupFailed(db, ops, { templateId: t.id });
    expect(destroyed.sort()).toEqual(['agenthub-mcp-leak', 'agenthub-mcp-old']);
    const { data } = await db.from('hosted_mcp_versions').select('version, sprite_name').eq('template_id', t.id).order('version');
    expect(data!.map((r) => r.sprite_name)).toEqual([null, 'agenthub-mcp-new', null, 'agenthub-mcp-live']);
  });
});
