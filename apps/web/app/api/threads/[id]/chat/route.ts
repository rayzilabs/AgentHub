import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { HttpError, readJson, route } from '@/lib/http';
import { getOwnThread } from '@/lib/services/threads';
import { forwardChat } from '@/lib/sprites';
import { adminDb } from '@/lib/supabase/admin';

export const maxDuration = 300;

const HOP_BY_HOP = new Set(['connection', 'content-length', 'transfer-encoding', 'keep-alive', 'content-encoding']);

export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireUser(req);
  const threadId = (await params).id;
  const { project } = await getOwnThread(adminDb(), user.id, threadId);
  if (project.sprite_status !== 'ready' || !project.sprite_url) throw new HttpError(409, 'agent 環境還在準備中，請稍候再送出');
  const { text } = await readJson(req, z.object({ text: z.string().trim().min(1, '請輸入訊息') }));

  const upstream = await forwardChat(project.sprite_url, { thread_id: threadId, text });
  const headers = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value);
  });
  return new Response(upstream.body, { status: upstream.status, headers });
});
