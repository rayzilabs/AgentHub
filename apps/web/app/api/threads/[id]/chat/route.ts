import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { env } from '@/lib/env';
import { HttpError, readJson, route } from '@/lib/http';
import { signProjectToken } from '@/lib/platform-tokens';
import { runtimeAccessToken } from '@/lib/runtime-session';
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

  // 專案通行證：runtime 用它呼叫模型（平台代理）與創作者的 MCP；沒有它對話一定失敗，不轉送
  const secret = env.runtimeTokenSecret;
  if (!secret) throw new HttpError(503, '平台尚未設定專案通行證，暫時無法對話');
  const projectToken = signProjectToken(project.id, secret);
  // runtime 用這張專案專用的通行證存取資料庫（權限由 RLS 限定在這個專案）
  const dbToken = await runtimeAccessToken(adminDb(), project.id);
  const upstream = await forwardChat(project.sprite_url, { thread_id: threadId, text }, { projectToken, dbToken });
  const headers = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value);
  });
  return new Response(upstream.body, { status: upstream.status, headers });
});
