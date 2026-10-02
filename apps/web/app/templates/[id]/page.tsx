import Link from 'next/link';
import { notFound } from 'next/navigation';
import { HireForm } from '@/components/hire-form';
import { currentUser } from '@/lib/auth';
import { HttpError } from '@/lib/http';
import { listProjects } from '@/lib/services/projects';
import { getTemplate } from '@/lib/services/templates';
import { adminDb } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export default async function TemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await currentUser();
  const template = await getTemplate(adminDb(), id, user?.id ?? null).catch((e) => {
    if (e instanceof HttpError && e.status === 404) notFound();
    throw e;
  });
  const projects = user ? await listProjects(adminDb(), user.id) : [];

  return (
    <div className="grid gap-8 py-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:grid-rows-[auto_1fr] lg:gap-x-12 lg:py-10">
      <header className="min-w-0">
        <p className="text-sm text-brand">{template.category || '未分類'}<span className="text-muted">，由 {template.creator_name || '匿名創作者'} 製作</span></p>
        <h1 className="mt-1 font-display text-2xl leading-tight sm:text-4xl">{template.name}</h1>
        <p className="mt-4 max-w-2xl whitespace-pre-line">{template.description || '（創作者還沒寫介紹）'}</p>
      </header>

      <aside className="panel h-fit p-5 lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto lg:col-start-2 lg:row-span-2 lg:row-start-1">
        <h2 className="mb-3 font-display text-xl">加入你的專案</h2>
        {template.status !== 'published' ? (
          <p className="text-muted">這是你的草稿，上架後才能加入專案。<Link href={`/creator/${template.id}`} className="link">回去編輯</Link></p>
        ) : user ? (
          <HireForm templateId={template.id} mcpServers={template.mcp_servers.map((s) => ({ name: s.name, required_secrets: s.required_secrets }))} projects={projects.map((p) => ({ id: p.id, name: p.name }))} />
        ) : (
          <p className="text-muted"><Link href={`/login?next=/templates/${template.id}`} className="link">登入</Link>後就能加入專案。</p>
        )}
      </aside>

      <section className="min-w-0 lg:col-start-1">
        <h2 className="font-display text-xl">這位顧問會的事</h2>
        {template.skills.length === 0 && <p className="hint">沒有額外的 skill，只靠創作者寫的工作方法。</p>}
        {template.skills.length > 0 && (
          <ul className="mt-3 grid gap-3 sm:grid-cols-2">
            {template.skills.map((s) => (
              <li key={s.name} className="panel min-w-0 p-4 [overflow-wrap:anywhere]">
                <div className="font-medium">{s.name}</div>
                <div className="mt-1 text-sm text-muted">{s.description}</div>
              </li>
            ))}
          </ul>
        )}

        {template.mcp_servers.length > 0 && (
          <>
            <h2 className="mt-8 font-display text-xl">會用到的工具</h2>
            <ul className="mt-3 flex flex-wrap gap-2">
              {template.mcp_servers.map((s) => <li key={s.name} className="chip">{s.name}</li>)}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
