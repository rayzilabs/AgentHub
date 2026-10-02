import { describe, expect, it } from 'vitest';
import { groupSecrets, loadInstances, loadSecrets } from '../src/project-store';
import { seedProject, seedTemplate, seedUser, testDb } from './helpers';

const db = testDb();

describe('project-store', () => {
  it('loadInstances 帶出範本創作者；loadSecrets 讀回 Vault 金鑰', async () => {
    const creatorId = await seedUser(db);
    const renterId = await seedUser(db);
    const templateId = await seedTemplate(db, creatorId, {
      name: '財務顧問',
      skills: [{ name: 'dcf', description: '估值', path: 'dcf' }],
      mcp_servers: [{ name: 'finmind', transport: 'stdio', command: 'npx', args: ['finmind-mcp'], required_secrets: [{ key: 'TOKEN' }] }],
    });
    const projectId = await seedProject(db, renterId);
    const { data: instanceId, error } = await db.rpc('hire_agent', {
      p_project_id: projectId,
      p_template_id: templateId,
      p_secrets: { finmind: { TOKEN: 't-1' } },
    });
    expect(error).toBeNull();

    const instances = await loadInstances(db, projectId);
    expect(instances).toHaveLength(1);
    expect(instances[0]).toMatchObject({
      id: instanceId,
      role: 'consultant',
      name: '財務顧問',
      template_id: templateId,
      creator_id: creatorId,
      skills: [{ name: 'dcf', description: '估值', path: 'dcf' }],
    });

    const secrets = await loadSecrets(db, projectId);
    expect(secrets).toEqual([{ instance_id: instanceId, mcp_name: 'finmind', key: 'TOKEN', value: 't-1' }]);
  });

  it('groupSecrets 只取指定 agent 的金鑰，依 MCP 名稱分組', () => {
    const rows = [
      { instance_id: 'a', mcp_name: 'm1', key: 'K1', value: 'v1' },
      { instance_id: 'a', mcp_name: 'm1', key: 'K2', value: 'v2' },
      { instance_id: 'a', mcp_name: 'm2', key: 'K3', value: 'v3' },
      { instance_id: 'b', mcp_name: 'm1', key: 'K1', value: 'other' },
    ];
    expect(groupSecrets(rows, 'a')).toEqual({ m1: { K1: 'v1', K2: 'v2' }, m2: { K3: 'v3' } });
  });
});
