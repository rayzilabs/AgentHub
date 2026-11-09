import Link from 'next/link';
import type { PublicTemplate } from '@/lib/services/templates';

export function TemplateCard({ t }: { t: PublicTemplate }) {
  return (
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
  );
}
