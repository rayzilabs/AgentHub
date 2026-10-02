import Link from 'next/link';
import { redirect } from 'next/navigation';
import { NewProjectForm } from '@/components/new-project-form';
import { currentUser } from '@/lib/auth';
import { listProjects } from '@/lib/services/projects';
import { adminDb } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

const STATUS = { provisioning: '準備中', ready: '可以使用', error: '準備失敗' } as const;

export default async function ProjectsPage() {
  const user = await currentUser();
  if (!user) redirect('/login?next=/projects');
  const projects = await listProjects(adminDb(), user.id);
  return (
    <div className="py-10">
      <h1 className="font-display text-[28px]">我的專案</h1>
      <p className="mb-6 text-muted">一個專案就是一張工作桌：放資料、請顧問、開對話。</p>
      <NewProjectForm />
      {projects.length === 0 ? (
        <p className="mt-8 text-muted">還沒有專案。取個名字建立第一個，接著到市集挑顧問。</p>
      ) : (
        <ul className="mt-8 divide-y divide-line border-y border-line bg-surface">
          {projects.map((p) => (
            <li key={p.id}>
              <Link href={`/projects/${p.id}`} className="flex items-center justify-between px-4 py-4 hover:bg-brand-soft">
                <span className="font-display text-xl">{p.name}</span>
                <span className={`text-sm ${p.sprite_status === 'error' ? 'text-seal' : 'text-muted'}`}>{STATUS[p.sprite_status]}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
