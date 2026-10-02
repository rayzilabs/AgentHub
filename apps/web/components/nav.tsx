import Link from 'next/link';
import { signOut } from '@/app/login/actions';
import { currentUser } from '@/lib/auth';

export async function Nav() {
  const user = await currentUser();
  return (
    <header className="border-b border-line bg-surface">
      <nav className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-1 px-4 py-2 sm:px-6 sm:py-3">
        <Link href="/" className="font-display text-xl font-bold text-ink">AgentHub</Link>

        {/* 帳號區在手機排第一行右側，桌面排最右 */}
        <div className="ml-auto flex items-center gap-3 text-sm sm:order-last">
          {user ? (
            <>
              <span className="hidden text-muted md:inline">{user.email}</span>
              <form action={signOut}>
                <button className="btn btn-secondary btn-sm">登出</button>
              </form>
            </>
          ) : (
            <Link href="/login" className="btn btn-primary btn-sm">登入</Link>
          )}
        </div>

        {/* 頁面連結：手機獨占第二行、可橫向捲；桌面接在品牌後面 */}
        <div className="-mx-4 flex w-[calc(100%+2rem)] gap-x-5 overflow-x-auto whitespace-nowrap px-4 py-1 sm:mx-0 sm:w-auto sm:gap-x-6 sm:overflow-visible sm:px-0 sm:py-0">
          <Link href="/" className="text-muted hover:text-ink">市集</Link>
          {user && <Link href="/projects" className="text-muted hover:text-ink">我的專案</Link>}
          {user && <Link href="/creator" className="text-muted hover:text-ink">我上架的 agent</Link>}
        </div>
      </nav>
    </header>
  );
}
