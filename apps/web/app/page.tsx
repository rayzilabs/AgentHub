import Link from 'next/link';
import { listPublishedTemplates } from '@/lib/services/templates';
import { adminDb } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export default async function Marketplace() {
  const templates = await listPublishedTemplates(adminDb());
  return (
    <>
      <section className="py-12">
        <h1 className="max-w-3xl font-display text-4xl leading-tight">請專業的人，帶著他們的方法來幫你做事</h1>
        <p className="mt-4 max-w-2xl text-muted">
          這裡的每一位顧問，都是律師、會計師、行銷人把自己的 SOP 做成的 agent。把他們加進你的專案，他們會分工、討論，最後給你一份整合過的建議。
        </p>
      </section>

      <section aria-labelledby="roster">
        <h2 id="roster" className="mb-4 font-display text-2xl">顧問名冊</h2>
        {templates.length === 0 ? (
          <p className="rounded border border-dashed border-line bg-surface p-6 text-muted">
            還沒有人上架顧問。你可以在「我上架的 agent」把自己的專業做成第一位。
          </p>
        ) : (
          <ul className="divide-y divide-line border-y border-line bg-surface">
            {templates.map((t) => (
              <li key={t.id}>
                <Link href={`/templates/${t.id}`} className="grid gap-2 px-4 py-5 hover:bg-brand-soft sm:grid-cols-[1fr_2fr_auto] sm:items-baseline sm:gap-6">
                  <div>
                    <div className="font-display text-xl">{t.name}</div>
                    <div className="text-sm text-muted">{t.category || '未分類'}，由 {t.creator_name || '匿名創作者'} 製作</div>
                  </div>
                  <p className="line-clamp-2 text-muted">{t.description || '（創作者還沒寫介紹）'}</p>
                  <div className="text-sm text-muted sm:text-right">
                    {t.skills.length} 個 skill
                    {t.mcp_servers.length > 0 && <>，{t.mcp_servers.length} 個工具</>}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
