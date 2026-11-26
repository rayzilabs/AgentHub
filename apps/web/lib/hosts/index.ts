import { env } from '@/lib/env';
import type { HostedVersion } from '@/lib/services/hosted-mcp';
import type { Db } from '@/lib/supabase/admin';
import { createE2bHost } from './e2b';
import { createSpriteHost, errorText } from './sprite';
import type { HostName, Machine, RuntimeHost } from './types';

export function defaultHost(): HostName {
  return env.defaultRuntimeHost;
}

export function hostFor(name: HostName): RuntimeHost {
  if (name === 'sprite') return createSpriteHost();
  return createE2bHost();
}

/** sleepSoon 之後再過多久暫停 */
export const SLEEP_SOON_MS = 15_000;

/**
 * 讓機器很快暫停（E2B 有請求時自動喚醒；Sprite 不需要，extend 什麼都不做）。建立與每次連線都會把 E2B 的逾時拉到 5～15 分鐘，
 * 營運腳本逐台處理時會同時醒著很多台，撞到 Hobby 同時 10 台的上限：連已搬好的專案都叫不醒。
 * 只能在這台確定沒人在用時呼叫（例如換資料列之前）；失敗只警告，頂多多醒幾分鐘。
 */
export async function sleepSoon(host: Pick<RuntimeHost, 'extend'>, m: Machine): Promise<void> {
  try {
    await host.extend(m, SLEEP_SOON_MS);
  } catch (e) {
    console.warn(`[sleep-soon] 縮短 ${m.host} ${m.name} 的存活時間失敗，它會多醒幾分鐘：${errorText(e)}`);
  }
}

type MachineRow = { host: HostName; sprite_name: string | null; sprite_url: string | null; host_token: string | null };

/** 缺名稱或網址（還沒佈建好）回 null */
export function projectMachine(p: MachineRow): Machine | null {
  if (!p.sprite_name || !p.sprite_url) return null;
  return { host: p.host, name: p.sprite_name, url: p.sprite_url, token: p.host_token };
}

export function versionMachine(v: Pick<HostedVersion, 'host' | 'sprite_name' | 'sprite_url' | 'host_token'>): Machine | null {
  return projectMachine(v);
}

export async function loadProjectMachine(db: Db, projectId: string): Promise<Machine | null> {
  const { data, error } = await db.from('projects').select('host, sprite_name, sprite_url, host_token').eq('id', projectId).single();
  if (error) throw error;
  return projectMachine(data as MachineRow);
}
