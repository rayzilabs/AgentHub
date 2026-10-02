import Link from 'next/link';
import { signOut } from '@/app/login/actions';
import { currentUser } from '@/lib/auth';

export async function Nav() {
  const user = await currentUser();
  return (
    <header className="border-b border-line bg-surface">
      <nav className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
        <Link href="/" className="font-display text-xl font-bold text-ink">AgentHub</Link>
        <Link href="/" className="text-muted hover:text-ink">市集</Link>
        {user && <Link href="/projects" className="text-muted hover:text-ink">我的專案</Link>}
        {user && <Link href="/creator" className="text-muted hover:text-ink">我上架的 agent</Link>}
        <div className="ml-auto flex items-center gap-3 text-sm">
          {user ? (
            <>
              <span className="text-muted">{user.email}</span>
              <form action={signOut}>
                <button className="rounded border border-line px-3 py-1 hover:border-ink">登出</button>
              </form>
            </>
          ) : (
            <Link href="/login" className="rounded bg-brand px-3 py-1 text-white">登入</Link>
          )}
        </div>
      </nav>
    </header>
  );
}
