import { createMCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import type { ToolSet } from 'ai';
import { errorText } from './errors';
import type { Sandbox } from './sandbox';
import type { McpServerConfig } from './types';

export const MCP_CONNECT_TIMEOUT_MS = 60_000;

export type McpHandle = { tools: ToolSet; warnings: string[]; close: () => Promise<void> };

/** remote 型 MCP 一律經平台閘道；token 是這次對話的專案通行證 */
export type McpGateway = { baseUrl: string; token: string; instanceId: string };

type McpClient = Awaited<ReturnType<typeof createMCPClient>>;

export function substituteSecrets(template: string, secrets: Record<string, string>): string {
  return template.replace(/\$\{([A-Za-z0-9_]+)\}/g, (match, key: string) => secrets[key] ?? match);
}

export function sanitizeToolName(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 64);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超過 ${ms / 1000} 秒沒有回應`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

function transportFor(server: McpServerConfig, secrets: Record<string, string>, cwd: string, sandbox: Sandbox, gateway?: McpGateway) {
  if (server.transport === 'remote') {
    if (!gateway) throw new Error('平台閘道未設定');
    return {
      type: 'http' as const,
      url: `${gateway.baseUrl}/api/mcp/${gateway.instanceId}/${encodeURIComponent(server.name)}`,
      headers: { Authorization: `Bearer ${gateway.token}` },
    };
  }
  if (server.transport === 'http') {
    if (!server.url) throw new Error('缺少 url');
    const headers = Object.fromEntries(
      Object.entries(server.headers ?? {}).map(([k, v]) => [k, substituteSecrets(v, secrets)]),
    );
    return { type: 'http' as const, url: server.url, headers };
  }
  if (!server.command) throw new Error('缺少 command');
  // 以沙盒帳號啟動：創作者的 MCP 程式讀不到 runtime 的檔案與平台金鑰
  const { command, args, env } = sandbox.command([server.command, ...(server.args ?? [])], secrets);
  return new Experimental_StdioMCPTransport({ command, args, env, cwd });
}

export async function connectMcpServers(
  servers: McpServerConfig[],
  secretsByServer: Record<string, Record<string, string>>,
  cwd: string,
  sandbox: Sandbox,
  connect: typeof createMCPClient = createMCPClient,
  timeoutMs = MCP_CONNECT_TIMEOUT_MS,
  gateway?: McpGateway,
): Promise<McpHandle> {
  const clients: McpClient[] = [];
  const warnings: string[] = [];
  const tools: ToolSet = {};

  for (const server of servers) {
    try {
      const transport = transportFor(server, secretsByServer[server.name] ?? {}, cwd, sandbox, gateway);
      const pending = connect({ transport });
      const client = await withTimeout(pending, timeoutMs, `MCP「${server.name}」`).catch((e: unknown) => {
        // 逾時後才連上的 client 已經沒人管，連上時直接關掉
        pending.then((c) => c.close()).catch(() => undefined);
        throw e;
      });
      clients.push(client);
      const serverTools = await withTimeout(client.tools(), timeoutMs, `MCP「${server.name}」`);
      for (const [name, definition] of Object.entries(serverTools)) {
        tools[sanitizeToolName(`${server.name}__${name}`)] = definition as ToolSet[string];
      }
    } catch (e) {
      warnings.push(`MCP「${server.name}」目前無法使用：${errorText(e)}`);
    }
  }

  return {
    tools,
    warnings,
    close: async () => {
      await Promise.allSettled(clients.map((c) => c.close()));
    },
  };
}
