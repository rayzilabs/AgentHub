import type { Metadata, Viewport } from 'next';
import { LXGW_WenKai_TC, Noto_Sans_TC } from 'next/font/google';
import { Nav } from '@/components/nav';
import { Providers } from '@/components/providers';
import './globals.css';

const wenkai = LXGW_WenKai_TC({ weight: ['400', '700'], variable: '--font-wenkai', preload: false, display: 'swap' });
const noto = Noto_Sans_TC({ weight: ['400', '500', '700'], variable: '--font-noto', preload: false, display: 'swap' });

export const metadata: Metadata = {
  title: 'AgentHub',
  description: '雇用專業人士做好的 agent，讓他們在你的專案裡一起工作',
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f5f5f7' },
    { media: '(prefers-color-scheme: dark)', color: '#000000' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant-TW" className={`${wenkai.variable} ${noto.variable}`}>
      <body className="min-h-screen">
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-full focus:bg-surface focus:shadow-float focus:px-3 focus:py-2 focus:text-link">跳到主要內容</a>
        <Providers>
          <Nav />
          <main id="main" className="mx-auto w-full min-w-0 max-w-6xl px-4 pb-16 sm:px-6">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
