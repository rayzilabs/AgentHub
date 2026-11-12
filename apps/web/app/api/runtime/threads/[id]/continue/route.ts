import { HttpError, route } from '@/lib/http';
import { bearerToken, requireProjectToken } from '@/lib/platform-tokens';
import { startQueuedRun } from '@/lib/services/run-control';
import { adminDb } from '@/lib/supabase/admin';

export const maxDuration = 300;

/** runtime 結束一輪時發現還有排隊訊息：驗證專案通行證後，由平台重新簽發並開下一輪 */
export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const projectId = requireProjectToken(bearerToken(req));

  const threadId = (await params).id;
  const db = adminDb();
  const { data: thread, error } = await db.from('threads').select('project_id').eq('id', threadId).maybeSingle();
  if (error) throw error;
  if (thread?.project_id !== projectId) throw new HttpError(404, '找不到這串對話');
  const { data: project, error: projectError } = await db.from('projects').select('id, sprite_url').eq('id', projectId).single();
  if (projectError) throw projectError;
  await startQueuedRun(db, project, threadId);
});
