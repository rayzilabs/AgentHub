import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { createMCPClient } from '@ai-sdk/mcp';
import { describe, expect, it } from 'vitest';
import { connectMcpServers, sanitizeToolName, substituteSecrets } from '../src/mcp';
import { createSandbox } from '../src/sandbox';
import { tmpRoots } from './helpers';

const fixture = fileURLToPath(new URL('./fixtures/echo-mcp.mjs', import.meta.url));
// 工具執行選項：測試只用得到這兩個欄位
const opts = { toolCallId: 't', messages: [] } as never;

describe('substituteSecrets / sanitizeToolName', () => {
  it('把 ${KEY} 換成金鑰，找不到的保留原樣', () => {
    expect(substituteSecrets('Bearer ${TOKEN} ${OTHER}', { TOKEN: 'abc' })).toBe('Bearer abc ${OTHER}');
  });

  it('工具名稱只留英數與底線，最長 64 字元', () => {
    expect(sanitizeToolName('台股-data__get price')).toBe('___data__get_price');
    expect(sanitizeToolName('x'.repeat(80))).toHaveLength(64);
  });
});

describe('connectMcpServers', () => {
  it('stdio：啟動 MCP、金鑰放進環境變數、工具加上 server 前綴', async () => {
    const { agentsRoot } = await tmpRoots();
    await mkdir(agentsRoot, { recursive: true }); // tmpRoots 只回傳路徑，spawn 的 cwd 必須已存在
    const handle = await connectMcpServers(
      [{ name: 'echo-server', transport: 'stdio', command: process.execPath, args: [fixture] }],
      { 'echo-server': { ECHO_PREFIX: 'P:' } },
      agentsRoot,
      createSandbox(),
    );
    try {
      expect(handle.warnings).toEqual([]);
      expect(Object.keys(handle.tools)).toEqual(['echo_server__echo']);
      const result = await handle.tools.echo_server__echo.execute!({ text: 'hi' }, opts);
      expect(JSON.stringify(result)).toContain('P:hi');
    } finally {
      await handle.close();
    }
  });

  it('http：headers 裡的 ${KEY} 會換成金鑰', async () => {
    const seen: unknown[] = [];
    const fakeConnect = (async (config: { transport: unknown }) => {
      seen.push(config.transport);
      return { tools: async () => ({}), close: async () => {} };
    }) as unknown as typeof createMCPClient;
    await connectMcpServers(
      [{ name: 'remote', transport: 'http', url: 'https://mcp.example.com', headers: { Authorization: 'Bearer ${API_KEY}' } }],
      { remote: { API_KEY: 'secret-1' } },
      '/tmp',
      createSandbox(),
      fakeConnect,
    );
    expect(seen[0]).toEqual({ type: 'http', url: 'https://mcp.example.com', headers: { Authorization: 'Bearer secret-1' } });
  });

  it('remote：連平台閘道，網址帶顧問 id 與 MCP 名稱，標頭帶專案通行證', async () => {
    const seen: unknown[] = [];
    const fakeConnect = (async (config: { transport: unknown }) => {
      seen.push(config.transport);
      return { tools: async () => ({}), close: async () => {} };
    }) as unknown as typeof createMCPClient;
    await connectMcpServers(
      [{ name: 'fin/x', transport: 'remote' }],
      {},
      '/tmp',
      createSandbox(),
      fakeConnect,
      undefined,
      { baseUrl: 'https://p.example', token: 'tok', instanceId: 'i1' },
    );
    expect(seen[0]).toEqual({ type: 'http', url: 'https://p.example/api/mcp/i1/fin%2Fx', headers: { Authorization: 'Bearer tok' } });
  });

  it('remote：沒有平台閘道時列為無法使用', async () => {
    const handle = await connectMcpServers([{ name: 'fin', transport: 'remote' }], {}, '/tmp', createSandbox());
    expect(handle.warnings).toEqual(['MCP「fin」目前無法使用：平台閘道未設定']);
  });

  it('stdio：指定沙盒帳號時以 sudo 啟動，金鑰放在環境變數而不是指令參數', async () => {
    const seen: unknown[] = [];
    const fakeConnect = (async (config: { transport: unknown }) => {
      seen.push(config.transport);
      return { tools: async () => ({}), close: async () => {} };
    }) as unknown as typeof createMCPClient;
    await connectMcpServers(
      [{ name: 'local', transport: 'stdio', command: 'node', args: ['server.js'] }],
      { local: { API_KEY: 'secret-1' } },
      '/tmp',
      createSandbox('agent'),
      fakeConnect,
    );
    const params = (seen[0] as { serverParams: { command: string; args: string[]; env: Record<string, string> } }).serverParams;
    expect(params.command).toBe('sudo');
    expect(params.args.slice(-2)).toEqual(['node', 'server.js']);
    expect(params.args.join(' ')).not.toContain('secret-1');
    expect(params.env.API_KEY).toBe('secret-1');
  });

  it('啟動失敗不丟例外，改寫進 warnings，其他 MCP 照常可用', async () => {
    const { agentsRoot } = await tmpRoots();
    await mkdir(agentsRoot, { recursive: true }); // tmpRoots 只回傳路徑，spawn 的 cwd 必須已存在
    const handle = await connectMcpServers(
      [
        { name: 'broken', transport: 'stdio', command: '/nonexistent/command' },
        { name: 'echo', transport: 'stdio', command: process.execPath, args: [fixture] },
      ],
      {},
      agentsRoot,
      createSandbox(),
    );
    try {
      expect(handle.warnings).toHaveLength(1);
      expect(handle.warnings[0]).toContain('broken');
      expect(handle.warnings[0]).toContain('目前無法使用');
      expect(Object.keys(handle.tools)).toEqual(['echo__echo']);
    } finally {
      await handle.close();
    }
  });

  it('連線逾時後才連上的 client 會被關掉，不會外洩', async () => {
    let closed = false;
    const slowConnect = (async () => {
      await new Promise((r) => setTimeout(r, 100));
      return { tools: async () => ({}), close: async () => { closed = true; } };
    }) as unknown as typeof createMCPClient;
    const handle = await connectMcpServers(
      [{ name: 'slow', transport: 'http', url: 'https://mcp.example.com' }], {}, '/tmp', createSandbox(), slowConnect, 20,
    );
    expect(handle.warnings[0]).toContain('MCP「slow」目前無法使用');
    expect(handle.warnings[0]).toContain('沒有回應');
    await new Promise((r) => setTimeout(r, 200));
    expect(closed).toBe(true);
  });
});
