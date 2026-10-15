// 用法：cd apps/web && pnpm exec tsx scripts/hosted-mcp.ts <指令>
//   disable <版本 id>   停用代管 MCP 版本：停掉程式、狀態改 disabled，閘道回 503（濫用或費用異常時）
//   cleanup-failed      刪除失敗超過 24 小時的代管 Sprite，以及下架後沒刪成功的 Sprite
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Db } from '@/lib/supabase/admin';

const USAGE = '用法：hosted-mcp.ts disable <版本 id> | cleanup-failed';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseArgs(argv: string[]): { cmd: 'disable'; id: string } | { cmd: 'cleanup-failed' } {
  if (argv[0] === 'disable' && argv.length === 2 && UUID.test(argv[1])) return { cmd: 'disable', id: argv[1] };
  if (argv[0] === 'cleanup-failed' && argv.length === 1) return { cmd: 'cleanup-failed' };
  throw new Error(USAGE);
}

async function disable(db: Db, id: string): Promise<void> {
  const { SpritesClient } = await import('@fly/sprites');
  const { env } = await import('@/lib/env');
  const { data: v, error } = await db.from('hosted_mcp_versions').update({ status: 'disabled' }).eq('id', id)
    .select('sprite_name').maybeSingle();
  if (error) throw error;
  if (!v) throw new Error(`找不到版本 ${id}`);
  console.log(`已停用 ${id}，閘道之後回 503`);
  if (v.sprite_name) {
    const sprite = await new SpritesClient(env.spritesToken).getSprite(v.sprite_name);
    const logs = await sprite.stopService('mcp');
    await logs.processAll(() => {});
    console.log(`已停止 ${v.sprite_name} 的 mcp 服務`);
  }
}

async function main(): Promise<void> {
  process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
  const args = parseArgs(process.argv.slice(2));
  const { adminDb } = await import('@/lib/supabase/admin');
  const db = adminDb();
  if (args.cmd === 'disable') {
    await disable(db, args.id);
  } else {
    const { createHostedSpriteOps } = await import('@/lib/hosted-sprite');
    const { cleanupFailed } = await import('@/lib/services/hosted-mcp');
    const done = await cleanupFailed(db, createHostedSpriteOps());
    console.log(done.length ? `已刪除：${done.join(', ')}` : '沒有需要清理的 Sprite');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
