import { requireUser } from '@/lib/auth';
import { createHostedSpriteOps } from '@/lib/hosted-sprite';
import { route } from '@/lib/http';
import { getVersion, retireVersion, syncVersion } from '@/lib/services/hosted-mcp';
import { adminDb } from '@/lib/supabase/admin';

export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string; mcp: string; versionId: string }> };

/** 部署中的版本在每次讀取時推進（讀 Sprite 上的狀態、啟動服務、驗證工具清單） */
export const GET = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser(req);
  const { id, mcp, versionId } = await params;
  const db = adminDb();
  const version = await getVersion(db, user.id, id, mcp, versionId);
  return version.status === 'deploying' ? syncVersion(db, version.id, createHostedSpriteOps()) : version;
});

export const DELETE = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser(req);
  const { id, mcp, versionId } = await params;
  const db = adminDb();
  const version = await getVersion(db, user.id, id, mcp, versionId);
  return retireVersion(db, user.id, version.id, createHostedSpriteOps());
});
