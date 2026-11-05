import { env } from '@/lib/env';
import { HttpError, route } from '@/lib/http';
import { verifyProjectToken } from '@/lib/platform-tokens';
import { startQueuedRun } from '@/lib/services/run-control';
import { adminDb } from '@/lib/supabase/admin';

export const maxDuration = 300;

/** runtime 結束一輪時發現還有排隊訊息：驗證專案通行證後，由平台重新簽發並開下一輪 */
export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const secret = env.runtimeTokenSecret;
  if (!secret) throw new HttpError(503, '平台尚未設定專案通行證');
  const token = req.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
  if (!token) throw new HttpError(401, '缺少專案通行證');
  const projectId = verifyProjectToken(token, secret);

  const threadId = (await params).id;
  const db = adminDb();
  const { data: thread, error } = await db.from('threads').select('project_id').eq('id', threadId).maybeSingle();
  if (error) throw error;
  if (thread?.project_id !== projectId) throw new HttpError(404, '找不到這串對話');
  const { data: project, error: projectError } = await db.from('projects').select('id, sprite_url').eq('id', projectId).single();
  if (projectError) throw projectError;
  await startQueuedRun(db, project, threadId);
});
