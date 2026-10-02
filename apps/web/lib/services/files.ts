import type { Db } from '@/lib/supabase/admin';
import { getOwnProject } from './projects';

export function storageFileName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? '').trim();
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot).replace(/[^A-Za-z0-9.]/g, '') : '';
  const cleaned = base.replace(/\s+/g, '_').replace(/[^A-Za-z0-9._()-]/g, '_').replace(/^\.+/, '');
  const stem = dot > 0 ? cleaned.slice(0, cleaned.length - ext.length) : cleaned;
  if (!/[A-Za-z0-9]/.test(stem)) return `file_${Date.now()}${ext}`;
  return cleaned;
}

export async function createFileUploadUrl(
  db: Db,
  userId: string,
  projectId: string,
  filename: string,
): Promise<{ signedUrl: string; name: string }> {
  await getOwnProject(db, userId, projectId);
  const name = storageFileName(filename);
  const { data, error } = await db.storage.from('project-files').createSignedUploadUrl(`${projectId}/${name}`, { upsert: true });
  if (error) throw error;
  return { signedUrl: data.signedUrl, name };
}

export async function listFiles(db: Db, userId: string, projectId: string): Promise<{ name: string; size: number; updated_at: string | null }[]> {
  await getOwnProject(db, userId, projectId);
  const { data, error } = await db.storage.from('project-files').list(projectId, { limit: 1000, sortBy: { column: 'name', order: 'asc' } });
  if (error) throw error;
  return data
    .filter((o) => o.id !== null)
    .map((o) => ({ name: o.name, size: (o.metadata as { size?: number } | null)?.size ?? 0, updated_at: o.updated_at ?? null }));
}
