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
    <div className="grid gap-10 py-10 lg:grid-cols-[2fr_1fr]">
      <article>
        <p className="text-sm text-muted">{template.category || '未分類'}，由 {template.creator_name || '匿名創作者'} 製作</p>
        <h1 className="mt-1 font-display text-[40px] leading-tight">{template.name}</h1>
        <p className="mt-4 max-w-2xl whitespace-pre-line">{template.description || '（創作者還沒寫介紹）'}</p>

        <h2 className="mt-10 font-display text-xl">這位顧問會的事</h2>
        {template.skills.length === 0 ? (
          <p className="mt-2 text-muted">沒有額外的 skill，只靠創作者寫的工作方法。</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {template.skills.map((s) => (
              <li key={s.name} className="border-l-2 border-brand pl-3">
                <div className="font-medium">{s.name}</div>
                <div className="text-sm text-muted">{s.description}</div>
              </li>
            ))}
          </ul>
        )}

        {template.mcp_servers.length > 0 && (
          <>
            <h2 className="mt-8 font-display text-xl">會用到的工具</h2>
            <ul className="mt-2 list-disc pl-5 text-muted">
              {template.mcp_servers.map((s) => <li key={s.name}>{s.name}</li>)}
            </ul>
          </>
        )}
      </article>

      <aside className="h-fit rounded border border-line bg-surface p-5">
        <h2 className="mb-3 font-display text-xl">加入你的專案</h2>
        {template.status !== 'published' ? (
          <p className="text-muted">這是你的草稿，上架後才能加入專案。<Link href={`/creator/${template.id}`} className="text-brand underline">回去編輯</Link></p>
        ) : user ? (
          <HireForm templateId={template.id} mcpServers={template.mcp_servers.map((s) => ({ name: s.name, required_secrets: s.required_secrets }))} projects={projects.map((p) => ({ id: p.id, name: p.name }))} />
        ) : (
          <p className="text-muted"><Link href={`/login?next=/templates/${template.id}`} className="text-brand underline">登入</Link>後就能加入專案。</p>
        )}
      </aside>
    </div>
  );
}
