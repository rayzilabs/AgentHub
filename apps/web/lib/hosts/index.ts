import { env } from '@/lib/env';
import type { HostedVersion } from '@/lib/services/hosted-mcp';
import type { Db } from '@/lib/supabase/admin';
import { createE2bHost } from './e2b';
import { createSpriteHost } from './sprite';
import type { HostName, Machine, RuntimeHost } from './types';

export function defaultHost(): HostName {
  return env.defaultRuntimeHost;
}

export function hostFor(name: HostName): RuntimeHost {
  if (name === 'sprite') return createSpriteHost();
  return createE2bHost();
}

type MachineRow = { host: HostName; sprite_name: string | null; sprite_url: string | null; host_token: string | null };

/** 缺名稱或網址（還沒佈建好）回 null */
export function projectMachine(p: MachineRow): Machine | null {
  if (!p.sprite_name || !p.sprite_url) return null;
  return { host: p.host, name: p.sprite_name, url: p.sprite_url, token: p.host_token };
}

export function versionMachine(v: HostedVersion): Machine | null {
  return projectMachine(v);
}

export async function loadProjectMachine(db: Db, projectId: string): Promise<Machine | null> {
  const { data, error } = await db.from('projects').select('host, sprite_name, sprite_url, host_token').eq('id', projectId).single();
  if (error) throw error;
  return projectMachine(data as MachineRow);
}
