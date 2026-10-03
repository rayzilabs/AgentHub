import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Chevron } from '@/components/chevron';
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
    <div className="mx-auto max-w-3xl py-10 sm:py-14">
      <h1 className="font-display text-2xl font-bold sm:text-4xl">我的專案</h1>
      <p className="mb-8 mt-2 text-muted">一個專案就是一張工作桌：放資料、請顧問、開對話。</p>
      <NewProjectForm />
      {projects.length === 0 ? (
        <div className="panel mt-8 p-6">
          <p className="font-medium">還沒有專案</p>
          <p className="mt-1 text-muted">取個名字建立第一個，接著到市集挑顧問。建立時會替專案準備一台 agent 的工作電腦，約需一分鐘。</p>
        </div>
      ) : (
        <ul className="panel mt-8 overflow-hidden">
          {projects.map((p) => (
            <li key={p.id} className="group/row">
              <Link href={`/projects/${p.id}`} className="flex items-center gap-4 pl-5 transition-colors duration-100 hover:bg-sunken/60 active:bg-sunken">
                {/* 分隔線從文字開始，不貫穿左邊留白 */}
                <span className="flex min-w-0 flex-1 items-center gap-4 border-b border-line/70 py-4 pr-5 group-last/row:border-b-0">
                  <span className="min-w-0 flex-1 text-xl font-medium [overflow-wrap:anywhere]">{p.name}</span>
                  <span className={`chip shrink-0 ${p.sprite_status === 'error' ? 'chip-seal' : p.sprite_status === 'provisioning' ? 'chip-brand' : 'chip-sage'}`}>
                    {p.sprite_status === 'provisioning' && <span className="dot-busy" aria-hidden />}
                    {STATUS[p.sprite_status]}
                  </span>
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
