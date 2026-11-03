import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { readJson, route } from '@/lib/http';
import { deleteFolder, entryName, updateFolder } from '@/lib/services/files';
import { adminDb } from '@/lib/supabase/admin';

type Ctx = { params: Promise<{ id: string; folderId: string }> };

const idParam = z.string().uuid('資料夾編號格式錯誤');
// parentId 為 null 代表搬到最上層，與「沒給」不同，所以用 undefined 判斷
const patchBody = z
  .object({ name: entryName.optional(), parentId: z.string().uuid().nullable().optional() })
  .refine((b) => b.name !== undefined || b.parentId !== undefined, '沒有要修改的內容');

export const PATCH = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser(req);
  const { id, folderId } = await params;
  const input = await readJson(req, patchBody);
  return updateFolder(adminDb(), user.id, id, idParam.parse(folderId), input);
});

export const DELETE = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser(req);
  const { id, folderId } = await params;
  await deleteFolder(adminDb(), user.id, id, idParam.parse(folderId));
  return { ok: true };
});
