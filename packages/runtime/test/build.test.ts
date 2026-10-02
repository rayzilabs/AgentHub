import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readUIMessageStream } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { buildConsultant } from '../src/agents/build';
import type { Db } from '../src/db';
import { buildConsultantInstructions } from '../src/agents/prompts';
import { usageRow } from '../src/usage';
import type { AgentInstance } from '../src/types';
import { seedConsultant, seedProject, seedUser, testDb, tmpRoots } from './helpers';
import { mockModel, promptText, textTurn } from './mock-model';

// 包一層 connectMcpServers，記錄 MCP 連線有沒有被關閉
const mcpCloses = vi.hoisted(() => ({ count: 0 }));
vi.mock('../src/mcp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/mcp')>();
  return {
    ...actual,
    connectMcpServers: async (...args: Parameters<typeof actual.connectMcpServers>) => {
      const handle = await actual.connectMcpServers(...args);
      return { ...handle, close: async () => { mcpCloses.count++; await handle.close(); } };
    },
  };
});

const db = testDb();
const fixture = fileURLToPath(new URL('./fixtures/echo-mcp.mjs', import.meta.url));

function instance(fields: Partial<AgentInstance> = {}): AgentInstance {
  return {
    id: randomUUID(), project_id: randomUUID(), template_id: randomUUID(), creator_id: randomUUID(),
    role: 'consultant', name: '法務顧問', system_prompt: '你是法務顧問。',
    skills_zip_path: null, skills: [], mcp_servers: [], ...fields,
  };
}

describe('buildConsultantInstructions', () => {
  it('包含創作者 prompt、工作目錄、專案檔案、skill 路徑、記憶與 MCP 警告', () => {
    const text = buildConsultantInstructions({
      instance: instance({ skills: [{ name: '審合約', description: '檢查合約風險', path: 'contract' }] }),
      workDir: '/agents/x',
      skillsDir: '/agents/x/skills',
      sharedRoot: '/shared',
      sharedFiles: ['財報.pdf'],
      memories: [{ id: '1', instance_id: null, content: '客戶偏好保守', created_at: '' }],
      mcpWarnings: ['MCP「finmind」目前無法使用：timeout'],
    });
    expect(text).toContain('你是法務顧問。');
    expect(text).toContain('/agents/x');
    expect(text).toContain('/shared/財報.pdf');
    expect(text).toContain('審合約：檢查合約風險（完整說明：/agents/x/skills/contract/SKILL.md）');
    expect(text).toContain('- [專案] 客戶偏好保守');
    expect(text).toContain('MCP「finmind」目前無法使用');
  });

  it('沒有檔案、skill、記憶時顯示空狀態', () => {
    const text = buildConsultantInstructions({
      instance: instance(), workDir: '/w', skillsDir: '/w/skills', sharedRoot: '/shared',
      sharedFiles: [], memories: [], mcpWarnings: [],
    });
    expect(text).toContain('（目前沒有專案檔案）');
    expect(text).toContain('（沒有 skill）');
    expect(text).toContain('（目前沒有記憶）');
    expect(text).not.toContain('目前無法使用的工具');
  });
});

describe('usageRow', () => {
  it('把 AI SDK 的 usage 轉成 usage_events 欄位', () => {
    const inst = instance();
    const row = usageRow(
      { db, projectId: 'p', runId: 'r', instance: inst },
      {
        model: { modelId: 'gemini-3.8-flash' },
        usage: {
          inputTokens: 100, outputTokens: 20, totalTokens: 120,
          inputTokenDetails: { noCacheTokens: 70, cacheReadTokens: 30, cacheWriteTokens: 0 },
          outputTokenDetails: { textTokens: 15, reasoningTokens: 5 },
        },
      },
    );
    expect(row).toEqual({
      run_id: 'r', project_id: 'p', instance_id: inst.id, template_id: inst.template_id, creator_id: inst.creator_id,
      model: 'gemini-3.8-flash', prompt_tokens: 100, output_tokens: 20, cached_tokens: 30, thought_tokens: 5,
    });
  });
});

describe('buildConsultant', () => {
  it('組出可串流的 agent，帶齊內建工具與 MCP 工具', async () => {
    const projectId = await seedProject(db, await seedUser(db));
    const id = await seedConsultant(db, projectId);
    const roots = await tmpRoots();
    const model = mockModel(textTurn('收到'));
    const built = await buildConsultant({
      db, model,
      config: { PROJECT_ID: projectId, AGENTS_ROOT: roots.agentsRoot, SHARED_ROOT: roots.sharedRoot },
      instance: instance({ id, project_id: projectId, mcp_servers: [{ name: 'echo', transport: 'stdio', command: process.execPath, args: [fixture] }] }),
      sharedFiles: [],
      secrets: {},
    });
    try {
      let last;
      for await (const m of readUIMessageStream({ stream: await built.streamUI({ messages: [{ role: 'user', content: '你好' }] }) })) {
        last = m;
      }
      expect(last?.parts.some((p) => p.type === 'text' && p.text === '收到')).toBe(true);
      const toolNames = model.doStreamCalls[0].tools?.map((t) => t.name).sort();
      expect(toolNames).toEqual(['bash', 'echo__echo', 'read_file', 'recall', 'remember', 'write_file']);
      expect(promptText(model)).toContain('你是法務顧問。');
    } finally {
      await built.close();
    }
  });

  it('MCP 連上之後組裝失敗：先關掉 MCP 連線再丟出錯誤', async () => {
    const roots = await tmpRoots();
    const brokenDb = { from: () => { throw new Error('資料庫掛了'); } } as unknown as Db;
    const before = mcpCloses.count;
    await expect(buildConsultant({
      db: brokenDb, model: mockModel(),
      config: { PROJECT_ID: randomUUID(), AGENTS_ROOT: roots.agentsRoot, SHARED_ROOT: roots.sharedRoot },
      instance: instance({ mcp_servers: [{ name: 'echo', transport: 'stdio', command: process.execPath, args: [fixture] }] }),
      sharedFiles: [],
      secrets: {},
    })).rejects.toThrow('資料庫掛了');
    expect(mcpCloses.count).toBe(before + 1);
  });
});
