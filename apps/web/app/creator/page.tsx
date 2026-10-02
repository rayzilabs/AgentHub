import Link from 'next/link';
import { redirect } from 'next/navigation';
import { NewTemplateButton } from '@/components/new-template-button';
import { currentUser } from '@/lib/auth';
import { listMyTemplates } from '@/lib/services/templates';
import { adminDb } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export default async function CreatorPage() {
  const user = await currentUser();
  if (!user) redirect('/login?next=/creator');
  const templates = await listMyTemplates(adminDb(), user.id);
  return (
    <div className="py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl">我上架的 agent</h1>
          <p className="text-muted">把你的 SOP、skill 和工具包成一位顧問，上架後別人就能加進他們的專案。</p>
        </div>
        <NewTemplateButton />
      </div>
      {templates.length === 0 ? (
        <div className="panel mt-8 border-dashed p-6">
          <p className="font-display text-xl">你還沒做任何顧問</p>
          <p className="mt-1 text-muted">按「做一位新顧問」開始。</p>
        </div>
      ) : (
        <ul className="mt-8 divide-y divide-line border-y border-line bg-surface">
          {templates.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-4 px-4 py-4">
              <div className="min-w-0">
                <div className="font-display text-xl">{t.name}</div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
                  <span className={`chip ${t.status === 'published' ? 'chip-brand' : ''}`}>{t.status === 'published' ? '已上架' : '草稿'}</span>
                  <span>{t.skills.length} 個 skill</span>
                </div>
              </div>
              <Link href={`/creator/${t.id}`} aria-label={`編輯「${t.name}」`} className="btn btn-secondary btn-sm shrink-0">編輯</Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
