import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { route } from '@/lib/http';
import { fileDownloadUrl } from '@/lib/services/files';
import { adminDb } from '@/lib/supabase/admin';

export const GET = route(async (req: Request, { params }: { params: Promise<{ fileId: string }> }) => {
  const user = await requireUser(req);
  const fileId = z.string().uuid('檔案編號格式錯誤').parse((await params).fileId);
  return fileDownloadUrl(adminDb(), user.id, fileId);
});
