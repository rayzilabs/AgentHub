import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { readJson, route } from '@/lib/http';
import { deleteFile, entryName, updateFile } from '@/lib/services/files';
import { adminDb } from '@/lib/supabase/admin';

type Ctx = { params: Promise<{ id: string; fileId: string }> };

const idParam = z.string().uuid('檔案編號格式錯誤');
const patchBody = z
  .object({ name: entryName.optional(), folderId: z.string().uuid().optional() })
  .refine((b) => b.name !== undefined || b.folderId !== undefined, '沒有要修改的內容');

export const PATCH = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser(req);
  const { id, fileId } = await params;
  const input = await readJson(req, patchBody);
  return updateFile(adminDb(), user.id, id, idParam.parse(fileId), input);
});

export const DELETE = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser(req);
  const { id, fileId } = await params;
  await deleteFile(adminDb(), user.id, id, idParam.parse(fileId));
  return { ok: true };
});
