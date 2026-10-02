export type SkillMeta = { name: string; description: string; path: string };

export type McpServerConfig = {
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  required_secrets?: { key: string; description?: string }[];
};

export type AgentInstance = {
  id: string;
  project_id: string;
  template_id: string | null;
  creator_id: string | null;
  role: 'consultant' | 'manager';
  name: string;
  system_prompt: string;
  skills_zip_path: string | null;
  skills: SkillMeta[];
  mcp_servers: McpServerConfig[];
};

export type SecretRow = { instance_id: string; mcp_name: string; key: string; value: string };

export type MessageKind = 'user' | 'final' | 'delegation' | 'discussion';
