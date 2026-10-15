import { after } from 'next/server';
import { requireUser } from '@/lib/auth';
import { createHostedSpriteOps } from '@/lib/hosted-sprite';
import { route } from '@/lib/http';
import { getVersion, startDeploy, syncVersion } from '@/lib/services/hosted-mcp';
import { adminDb } from '@/lib/supabase/admin';

export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string; mcp: string; versionId: string }> };

export const POST = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser(req);
  const { id, mcp, versionId } = await params;
  const db = adminDb();
  await getVersion(db, user.id, id, mcp, versionId);
  const version = await startDeploy(db, user.id, versionId);
  // 建立 Sprite、啟動部署腳本後就返回；之後由讀取版本的請求推進
  after(() => syncVersion(adminDb(), version.id, createHostedSpriteOps()).catch((e) => console.error('[hosted-deploy]', version.id, e)));
  return version;
});
