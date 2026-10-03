'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/** 導覽連結：目前所在的頁面用實心字與底色標出來，讓人一眼知道自己在哪裡。 */
export function NavLinks({ links }: { links: { href: string; label: string }[] }) {
  const pathname = usePathname();
  const active = (href: string) => (href === '/' ? pathname === '/' || pathname.startsWith('/templates') : pathname.startsWith(href));
  return (
    <>
      {links.map((l) => (
        <Link key={l.href} href={l.href} aria-current={active(l.href) ? 'page' : undefined}
          className="rounded-full px-3 py-1 text-sm text-muted transition-colors duration-150 hover:text-ink aria-[current=page]:bg-sunken aria-[current=page]:font-medium aria-[current=page]:text-ink">
          {l.label}
        </Link>
      ))}
    </>
  );
}
