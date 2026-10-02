import Link from 'next/link';
import { listPublishedTemplates } from '@/lib/services/templates';
import { adminDb } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export default async function Marketplace() {
  const templates = await listPublishedTemplates(adminDb());
  return (
    <>
      <section className="py-10 sm:py-14">
        <h1 className="max-w-3xl font-display text-2xl leading-tight sm:text-4xl">請專業的人，帶著他們的方法來幫你做事</h1>
        <p className="mt-4 max-w-2xl text-muted sm:text-xl">
          每一位顧問都是律師、會計師、金融從業者把自己的 SOP 做成的 agent。加進你的專案，他們會分工、討論，最後給你一份整合過的建議。
        </p>
        <ol className="mt-8 grid gap-3 sm:grid-cols-3">
          {[
            ['挑顧問', '在名冊裡挑一位，看這位顧問會做什麼、用什麼工具。'],
            ['加進專案', '一鍵加入。你的資料、對話與記憶都留在自己的專案裡。'],
            ['派工與討論', '兩位以上顧問時，主管會分工；需要權衡時召開討論，最後總結。'],
          ].map(([t, d], i) => (
            <li key={t} className="panel p-4">
              <div className="font-display text-xl"><span className="mr-2 text-brand">{i + 1}</span>{t}</div>
              <p className="mt-1 text-sm text-muted">{d}</p>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="roster">
        <div className="mb-4 flex items-baseline justify-between">
          <h2 id="roster" className="font-display text-2xl">顧問名冊</h2>
          <span className="text-sm text-muted">共 {templates.length} 位</span>
        </div>
        {templates.length === 0 ? (
          <div className="panel border-dashed p-6">
            <p className="text-muted">還沒有人上架顧問。你可以把自己的專業做成第一位。</p>
            <Link href="/creator" className="btn btn-secondary mt-3">去上架第一位</Link>
          </div>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {templates.map((t) => (
              <li key={t.id} className="min-w-0">
                <Link href={`/templates/${t.id}`} className="panel flex h-full flex-col p-5 hover:border-brand">
                  <div className="text-sm text-brand">{t.category || '未分類'}</div>
                  <div className="mt-1 font-display text-xl [overflow-wrap:anywhere]">{t.name}</div>
                  <div className="text-sm text-muted">由 {t.creator_name || '匿名創作者'} 製作</div>
                  <p className="mt-3 flex-1 text-muted [overflow-wrap:anywhere]">{t.description || '（創作者還沒寫介紹）'}</p>
                  <div className="mt-4 flex flex-wrap gap-2 text-sm text-muted">
                    {t.skills.slice(0, 3).map((s) => <span key={s.name} className="chip">{s.name}</span>)}
                    {t.skills.length > 3 && <span className="chip">+{t.skills.length - 3}</span>}
                    {t.mcp_servers.length > 0 && <span className="chip">{t.mcp_servers.length} 個外部工具</span>}
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
