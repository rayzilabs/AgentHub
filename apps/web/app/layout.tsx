import type { Metadata, Viewport } from 'next';
import { LXGW_WenKai_TC, Noto_Sans_TC } from 'next/font/google';
import { Nav } from '@/components/nav';
import { Providers } from '@/components/providers';
import 'katex/dist/katex.min.css';
import './globals.css';

const wenkai = LXGW_WenKai_TC({ weight: ['400', '700'], variable: '--font-wenkai', preload: false, display: 'swap' });
const noto = Noto_Sans_TC({ weight: ['400', '500', '700'], variable: '--font-noto', preload: false, display: 'swap' });

export const metadata: Metadata = {
  title: 'AgentHub',
  description: '雇用專業人士做好的 agent，讓他們在你的專案裡一起工作',
};

export const viewport: Viewport = {
  themeColor: '#f5f5f7',
};

const themeScript = `try{if(localStorage.getItem('theme')==='dark')document.documentElement.dataset.theme='dark'}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // data-theme 由下面的 script 在 hydration 前設定，伺服器端不知道，所以忽略這個差異
    <html lang="zh-Hant-TW" className={`${wenkai.variable} ${noto.variable}`} suppressHydrationWarning>
      <head>
        {/* 在畫面出來前套用上次選的模式，避免重新整理時先閃一下淺色 */}
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-screen">
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-full focus:bg-surface focus:shadow-float focus:px-3 focus:py-2 focus:text-link">跳到主要內容</a>
        <Providers>
          <Nav />
          <main id="main" className="scroll-mt-[var(--nav-h,57px)] mx-auto w-full min-w-0 max-w-6xl px-4 pb-16 sm:px-6">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
