import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Chevron } from '@/components/chevron';
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
    <div className="mx-auto max-w-3xl py-10 sm:py-14">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold sm:text-4xl">我上架的 agent</h1>
          <p className="mt-2 text-muted">把你的 SOP、skill 和工具包成一位顧問，上架後別人就能加進他們的專案。</p>
        </div>
        <NewTemplateButton />
      </div>
      {templates.length === 0 ? (
        <div className="panel mt-8 p-6">
          <p className="font-medium">你還沒做任何顧問</p>
          <p className="mt-1 text-muted">按「做一位新顧問」開始。</p>
        </div>
      ) : (
        <ul className="panel mt-8 overflow-hidden">
          {templates.map((t) => (
            <li key={t.id} className="group/row">
              <Link href={`/creator/${t.id}`} aria-label={`編輯「${t.name}」`}
                className="flex items-center gap-4 pl-5 transition-colors duration-100 hover:bg-sunken/60 active:bg-sunken">
                <span className="flex min-w-0 flex-1 items-center gap-4 border-b border-line/70 py-4 pr-5 group-last/row:border-b-0">
                  <span className="min-w-0 flex-1">
                    <span className="block text-xl font-medium [overflow-wrap:anywhere]">{t.name}</span>
                    <span className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
                      <span className={`chip ${t.status === 'published' ? 'chip-sage' : ''}`}>{t.status === 'published' ? '已上架' : '草稿'}</span>
                      <span>{t.skills.length} 個 skill</span>
                    </span>
                  </span>
                  <span className="text-sm text-muted">編輯</span>
                  <Chevron />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
