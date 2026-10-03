import Link from 'next/link';
import { listPublishedTemplates } from '@/lib/services/templates';
import { adminDb } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

const STEPS = [
  ['挑顧問', '在名冊裡挑一位，看這位顧問會做什麼、用什麼工具。'],
  ['加進專案', '一鍵加入。你的資料、對話與記憶都留在自己的專案裡。'],
  ['派工與討論', '兩位以上顧問時，主管會分工；需要權衡時召開討論，最後總結。'],
];

export default async function Marketplace() {
  const templates = await listPublishedTemplates(adminDb());
  return (
    <>
      <section className="pb-12 pt-12 sm:pb-16 sm:pt-20">
        <h1 className="max-w-3xl font-display text-2xl font-bold sm:text-4xl">請專業的人，帶著他們的方法來幫你做事</h1>
        <p className="mt-5 max-w-2xl text-muted sm:text-xl">
          每一位顧問都是律師、會計師、金融從業者把自己的 SOP 做成的 agent。加進你的專案，他們會分工、討論，最後給你一份整合過的建議。
        </p>
        {/* 三個步驟是真的有先後順序，所以用編號；放在同一個群組裡，用細線分隔 */}
        <ol className="panel mt-10 grid divide-y divide-line/70 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          {STEPS.map(([t, d], i) => (
            <li key={t} className="flex gap-3 p-5">
              <span aria-hidden className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-soft text-sm font-medium text-link">{i + 1}</span>
              <div className="min-w-0">
                <div className="font-medium">{t}</div>
                <p className="mt-0.5 text-sm text-muted">{d}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="roster">
        <div className="mb-4 flex items-baseline justify-between gap-4">
          <h2 id="roster" className="font-display text-2xl font-bold">顧問名冊</h2>
          <span className="text-sm text-muted">共 {templates.length} 位</span>
        </div>
        {templates.length === 0 ? (
          <div className="panel p-6">
            <p className="text-muted">還沒有人上架顧問。你可以把自己的專業做成第一位。</p>
            <Link href="/creator" className="btn btn-primary mt-4">去上架第一位</Link>
          </div>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {templates.map((t) => (
              <li key={t.id} className="min-w-0">
                <Link href={`/templates/${t.id}`}
                  className="panel group flex h-full flex-col p-6 transition-transform duration-150 ease-out active:scale-[0.98]">
                  <div className="text-sm font-medium text-link">{t.category || '未分類'}</div>
                  <div className="mt-1.5 font-display text-xl font-bold [overflow-wrap:anywhere] group-hover:text-link">{t.name}</div>
                  <div className="text-sm text-muted">由 {t.creator_name || '匿名創作者'} 製作</div>
                  <p className="mt-3 flex-1 text-muted [overflow-wrap:anywhere]">{t.description || '（創作者還沒寫介紹）'}</p>
                  <div className="mt-5 flex flex-wrap gap-1.5">
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
