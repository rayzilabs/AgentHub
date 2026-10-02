import Link from 'next/link';
import type { AgentSummary } from '@/lib/services/projects';

export function AgentRoster({ agents, colorOf }: { agents: AgentSummary[]; colorOf: (id: string) => string }) {
  const consultants = agents.filter((a) => a.role === 'consultant');
  const manager = agents.find((a) => a.role === 'manager');
  return (
    <section aria-labelledby="roster-title">
      <h2 id="roster-title" className="font-display text-xl">顧問</h2>
      {consultants.length === 0 ? (
        <p className="mt-2 text-sm text-muted">還沒有顧問。<Link href="/" className="text-brand underline">到市集挑選</Link></p>
      ) : (
        <ul className="mt-2 space-y-2">
          {consultants.map((a) => (
            <li key={a.id} className="flex items-start gap-2">
              <span aria-hidden className="mt-2 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: colorOf(a.id) }} />
              <div>
                <div className="font-medium">{a.name}</div>
                {a.description && <div className="text-sm text-muted">{a.description}</div>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {manager && <p className="mt-3 text-sm text-muted">有兩位以上顧問，所以由主管負責分工與整合。</p>}
      {consultants.length > 0 && <Link href="/" className="mt-3 inline-block text-sm text-brand underline">再加一位顧問</Link>}
    </section>
  );
}
