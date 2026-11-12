import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { HttpError, readJson, route, upstreamHeaders } from '@/lib/http';
import { MessageTextSchema } from '@/lib/schemas';
import { forwardToRuntime } from '@/lib/services/run-control';
import { getOwnThread } from '@/lib/services/threads';
import { adminDb } from '@/lib/supabase/admin';

export const maxDuration = 300;

export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireUser(req);
  const threadId = (await params).id;
  const { project } = await getOwnThread(adminDb(), user.id, threadId);
  if (project.sprite_status !== 'ready' || !project.sprite_url) throw new HttpError(409, 'agent 環境還在準備中，請稍候再送出');
  const { text } = await readJson(req, z.object({ text: MessageTextSchema }));
  const upstream = await forwardToRuntime(adminDb(), { id: project.id, sprite_url: project.sprite_url }, { thread_id: threadId, text });
  return new Response(upstream.body, { status: upstream.status, headers: upstreamHeaders(upstream.headers) });
});
