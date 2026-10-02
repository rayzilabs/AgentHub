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
          <h1 className="font-display text-[28px]">我上架的 agent</h1>
          <p className="text-muted">把你的 SOP、skill 和工具包成一位顧問，上架後別人就能加進他們的專案。</p>
        </div>
        <NewTemplateButton />
      </div>
      {templates.length === 0 ? (
        <p className="mt-8 rounded border border-dashed border-line bg-surface p-6 text-muted">你還沒做任何顧問。按「做一位新顧問」開始。</p>
      ) : (
        <ul className="mt-8 divide-y divide-line border-y border-line bg-surface">
          {templates.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-4 px-4 py-4">
              <div>
                <div className="font-display text-xl">{t.name}</div>
                <div className="text-sm text-muted">{t.status === 'published' ? '已上架' : '草稿'}，{t.skills.length} 個 skill</div>
              </div>
              <Link href={`/creator/${t.id}`} className="rounded border border-line px-3 py-1 hover:border-ink">編輯</Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
