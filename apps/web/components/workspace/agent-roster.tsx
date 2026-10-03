import Link from 'next/link';
import { Avatar, MANAGER_COLOR } from '@/components/ui/avatar';
import type { AgentSummary } from '@/lib/services/projects';

export function AgentRoster({ agents, colorOf }: { agents: AgentSummary[]; colorOf: (id: string) => string }) {
  const consultants = agents.filter((a) => a.role === 'consultant');
  const manager = agents.find((a) => a.role === 'manager');
  return (
    <section aria-labelledby="roster-title">
      <h2 id="roster-title" className="group-title">顧問</h2>
      {consultants.length === 0 ? (
        <p className="panel p-4 text-sm text-muted">還沒有顧問。<Link href="/" className="link">到市集挑選</Link></p>
      ) : (
        <ul className="panel space-y-4 p-4">
          {manager && (
            <li className="flex items-start gap-3">
              <Avatar name="主管" color={MANAGER_COLOR} />
              <div className="min-w-0">
                <div className="font-medium">主管</div>
                <div className="text-sm text-muted">分工、召集討論、整理總結</div>
              </div>
            </li>
          )}
          {consultants.map((a) => (
            <li key={a.id} className="flex items-start gap-3">
              <Avatar name={a.name} color={colorOf(a.id)} />
              <div className="min-w-0">
                <div className="font-medium">{a.name}</div>
                {a.description && <div className="line-clamp-2 text-sm text-muted" title={a.description}>{a.description}</div>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {consultants.length > 0 && <Link href="/" className="btn btn-plain btn-sm mt-2">＋ 再加一位顧問</Link>}
    </section>
  );
}
