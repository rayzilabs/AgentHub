import type { Metadata } from 'next';
import { LXGW_WenKai_TC, Noto_Sans_TC } from 'next/font/google';
import { Nav } from '@/components/nav';
import './globals.css';

const wenkai = LXGW_WenKai_TC({ weight: ['400', '700'], variable: '--font-wenkai', preload: false, display: 'swap' });
const noto = Noto_Sans_TC({ weight: ['400', '500', '700'], variable: '--font-noto', preload: false, display: 'swap' });

export const metadata: Metadata = {
  title: 'AgentHub',
  description: '雇用專業人士做好的 agent，讓他們在你的專案裡一起工作',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant-TW" className={`${wenkai.variable} ${noto.variable}`}>
      <body className="min-h-screen">
        <Nav />
        <main className="mx-auto w-full max-w-6xl px-4 pb-16 sm:px-6">{children}</main>
      </body>
    </html>
  );
}
