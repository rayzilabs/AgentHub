# AgentHub 網站 UI/UX 優化方案

> 給工程師直接實作用。只動 `apps/web` 的呈現層：JSX 結構、className、文案、狀態的呈現方式。功能、資料流、API 一律不變。
> 依據：截圖 `scratchpad/before/01–09`（桌面 1440、手機 390）、`apps/web/app/**`、`apps/web/components/**`、`globals.css`、`lib/colors.ts`，以及 plan3-web 的設計 token（paper／ink／brand／seal／ochre，字級 14／16／20／28／40）。

## 1. 目標與原則

目標只有三個：

1. **手機能用。** 390px 寬不能水平捲動，工作區打開第一眼要看到對話，不是一千多像素的側欄。
2. **長內容讀得下去。** 顧問回覆、派工卡片、討論發言是產品的核心畫面，字級、間距、收合預覽都要讓人在展場投影和手機上都能看。
3. **狀態說人話。** 準備中、處理中、輪詢中、失敗、空狀態，每一種都要有固定的呈現方式，不是一行紅字或灰字。

原則：

- 沿用 plan3-web 的 token 與「安靜」的視覺語言：白底、細線、沒有陰影與漸層；唯一大膽的元素仍是討論裡的印章。
- 動態只用在回應使用者的操作（送出後的「處理中」指示、展開收合）。沒有進場 fade-in、沒有 hover 位移。
- 先補共用的 token 與元件配方，再逐頁套用，讓按鈕、輸入框、提示訊息在全站只有一種長相。
- 字級只用五階：14／16／20／28／40。

## 2. 不改的範圍

**完全不碰的檔案與目錄**

- `apps/web/app/api/**`、`apps/web/lib/**`（含 `lib/colors.ts`，顧問識別色不改）、`apps/web/proxy.ts`、`next.config.ts`、`vercel.json`
- `packages/runtime/**`、`supabase/**`
- 字體：維持霞鶩文楷 TC（標題、顧問名）＋ Noto Sans TC（內文），`layout.tsx` 的字體載入不改。
- 不新增任何依賴。`react-markdown` 的 `components` prop 是既有依賴的既有功能，可以用。

**只能改呈現的客戶端元件**

`chat.tsx`、`workspace.tsx`、`template-editor.tsx`、`hire-form.tsx` 的 state、effect、`api()` 呼叫、`useChat` 設定、輪詢邏輯、錯誤處理分支都不能動。允許的只有：JSX 結構與 className、文案、同一個狀態改用別的方式呈現（例如字串改成含圖示的區塊）。唯一新增的 state 是 `workspace.tsx` 的手機側欄收合開關 `panelOpen`（純呈現用，見任務 2，已標註）。

**必須保留的選擇器（截圖回歸腳本 `scratchpad/shoot.cjs` 依賴）**

| 選擇器 | 位置 | 本方案的處理 |
|---|---|---|
| `a[href^="/templates/"]` | 市集卡片連結 | 卡片改版後整張卡仍是這個 `<Link>` |
| `a[href^="/projects/"]` | 專案列表連結 | 保留；列表前面不插入其他 `/projects/` 開頭的連結 |
| `a[href^="/creator/"]` | 「我上架的 agent」列表的編輯連結 | 保留；導覽列的 `/creator` 沒有尾斜線，不會被撈到 |
| `section[aria-label="對話"] > div:first-child > button` | 對話分頁列，第一顆是第一個對話 | 分頁列仍是 section 的第一個 `div`，裡面只放對話按鈕與「開新對話」；手機側欄開關放在 `aside`，不放這裡 |
| `input[name=email]`、`input[name=password]`、登入表單第一顆 button 是「登入」 | 登入頁 | 保留順序 |

**品質底線**：每頁 390px 不水平捲動；`:focus-visible` 外框維持 brand 色 2px；文字對比 ≥ 4.5:1（大字 ≥ 3:1）；尊重 `prefers-reduced-motion`。

## 3. 問題清單（依嚴重度）

對比數據是用 WCAG 相對亮度公式算的（paper `#f4f6f9`、surface `#fff`）。

### P0：違反硬性限制或 Demo 會出事

| # | 問題 | 證據 | 根因 |
|---|---|---|---|
| 1 | **討論對話在 390px 水平捲動到 590px。** 整頁被撐寬，側欄、導覽列全部跑版。 | 截圖 07 手機（檔案寬度 590px）；用 puppeteer 量測：`section[aria-label="對話"]` 寬 574px，裡面有 20 個 `<table>`（3～9 欄，各 508px）與 2 個 `<pre>`，全部在收合的發言區塊裡 | `workspace.tsx` 的 grid 子項沒有 `min-w-0`，`1fr` 欄不會縮到比最寬的表格窄；`markdown.tsx` 沒有讓表格可以橫向捲動 |
| 2 | **工作區在手機上側欄壓在對話上方。** 顧問名單（三段完整介紹）＋專案資料＋記憶＋刪除專案，約 1,000px 之後才看到對話分頁。 | 截圖 06、07 手機 | `workspace.tsx` 單欄堆疊，`aside` 在 DOM 前面 |
| 3 | **收合預覽沒有內容。** 192px 的預覽被「以下為一般性分析…」聲明、`<hr>` 上下 margin、標題 margin 吃光，看到的是一行字加「展開全文」。派工卡片同樣。 | 截圖 07 桌面與手機每一個發言區塊；06 的派工卡片 | `collapsible.tsx` 的 `max-h-48` 配上 `prose` 預設間距（`hr` 上下 3em、`h2` 上 2em） |
| 4 | **顧問識別色 `#B5651D` 在白底對比 4.34:1，20px 一般字重不算大字，不符 AA。** 其他識別色 4.93～8.66 都過。 | `delegation-card.tsx`、`discussion-view.tsx` 的顧問名 `font-display text-lg` 配 `style={{ color }}` | 不能改 `lib/colors.ts`，要在呈現層處理 |

### P1：可讀性、資訊層級、狀態回饋

| # | 問題 | 證據 |
|---|---|---|
| 5 | **字級 token 自相矛盾。** `--text-xs: 0.875rem` 讓 `text-xs` 跟 `text-sm` 都是 14px；`--text-lg: 1.25rem` 讓 `text-lg` 跟 `text-xl` 都是 20px；28 與 40 用 `text-[28px]`／`text-[40px]` 硬寫。全站同一個字級有兩個名字。 | `globals.css` 第 14–17 行；`grep text-xs` 有 18 處、`text-lg` 有 8 處 |
| 6 | **長回覆用 `prose-sm`（14px 內文）**，投影或手機上太小；而回覆裡的 `##` 標題用 prose 預設 1.5em = 24px，比 UI 的 h2（20px）還大，層級倒置。`hr` 間距 3em 把一份回覆切得很鬆。 | 截圖 06 桌面主回覆、07 總結 |
| 7 | **派工卡片把「主管交辦」整段 prompt 倒出來**（四行以上），狀態「完成」是 14px 灰字靠右，比名字還不顯眼；處理中沒有任何動態指示。 | 截圖 06；`delegation-card.tsx` 第 13–17 行 |
| 8 | **工具使用紀錄一行一段**：主管回覆上方「用了工具：記下重點」「用了工具：讀取檔案」各占一行；每個發言區塊重複一行「用了工具：讀取檔案」。 | 截圖 06、07；`message-view.tsx` 第 43–46 行、`tool-list.tsx` |
| 9 | **狀態回饋全是裸文字**：「顧問正在處理…」「回覆還在進行中…」是一行灰字，沒有動態指示；「正在準備 agent 的工作電腦」「準備失敗」是側欄裡的小字；所有錯誤都是 `text-sm text-seal`，警告、錯誤、資訊沒有區別。 | `chat.tsx` 第 168–169 行；`workspace.tsx` 第 88–104 行 |
| 10 | **導覽列在 390px 折成三行**：「我上架的 agent」掉到第二行，email＋登出掉到第三行。 | 截圖 04、05、08、09 手機 |
| 11 | **顧問介紹頁的「加入專案」在手機要捲到最底**，桌面在右欄沒問題。 | 截圖 02、05 手機 |
| 12 | **市集首頁第一印象偏弱**：名冊是三行表格式列表，第三欄「2 個 skill」對參觀者沒有意義；沒有告訴人「加進專案後會發生什麼」。手機版卡片反而比桌面好讀。 | 截圖 01 |
| 13 | **按鈕與輸入框沒有統一配方**：`px-3 py-1`（登出、編輯、分頁）與 `px-4 py-2`（送出、建立）並存；`disabled:opacity-60` 複製了 9 次；連結有的底線有的沒有；`FileButton` 是 brand 外框，其他次要按鈕是 line 外框。 | 全部 tsx |
| 14 | **空狀態只有一句灰字**：「還沒有專案。」「先到市集加入至少一位顧問，才能開始對話。」「還沒有資料。」沒有可按的下一步。 | `projects/page.tsx`、`workspace.tsx`、`file-panel.tsx`、`memory-panel.tsx`、`agent-roster.tsx` |
| 15 | **討論沒有進度感**：看不出現在第幾輪、最多幾輪、是否結束；輪次標題是 14px 灰字；結束訊息「討論結束，共進行 3 輪。」也是灰字。 | 截圖 07 |
| 16 | **顧問編輯器是一張 191 行的長表單**，沒有分區，label 全是灰字，skill 清單是純文字；上傳 zip 的驗證錯誤（多行）與成功訊息只在最底部出現。 | 截圖 09 |
| 17 | **側欄顧問介紹每位三行**，桌面側欄 260px 被文字塞滿，手機更長。 | 截圖 06 桌面 |
| 18 | **`data-warning` 用 `text-xs text-ochre` 直接放在 paper 底上**：對比 4.52:1，剛好過線，而且只有 14px 灰黃字，容易被當成裝飾。 | `message-view.tsx` 第 26 行 |

### P2：一致性與細節

| # | 問題 |
|---|---|
| 19 | `Seal` 用 `aria-label` 放在沒有 role 的 `<span>` 上，部分讀屏會忽略。 |
| 20 | 專案列表、創作者列表的狀態（可以使用／準備失敗／已上架／草稿）是純文字，沒有視覺差異。 |
| 21 | 登入頁沒有容器，表單浮在 paper 上；兩顆按鈕一樣寬度看起來同等重要。 |
| 22 | 記憶與檔案面板用 `text-xs`（實際 14px）小字按鈕「修改」「刪除」，點擊目標太小。檔案列表沒有大小。 |
| 23 | 使用者訊息氣泡 `rounded`（4px）與其他卡片一致，但 `max-w-[85%]` 在桌面寬欄太寬，一行字拉到 700px。 |

## 4. 實作任務

四個任務，**依序**執行。每個任務做完都要 `pnpm -F @agenthub/web lint && pnpm -F @agenthub/web typecheck` 過。

---

### 任務 1：token、共用配方與共用元件

**檔案**：`app/globals.css`、`components/markdown.tsx`、`components/seal.tsx`、`components/file-button.tsx`、`components/nav.tsx`、`app/layout.tsx`

#### 1.1 `globals.css`：字級收斂、補 token、加元件配方

把 `@theme` 改成：

```css
@theme {
  --color-paper: #f4f6f9;
  --color-surface: #ffffff;
  --color-ink: #172033;
  --color-muted: #5b6578;
  --color-line: #dce1e8;
  --color-brand: #1f4e79;
  --color-brand-strong: #163a5b;   /* 新增：主要按鈕 hover、連結 hover */
  --color-brand-soft: #e3ecf5;
  --color-seal: #b8322a;
  --color-ochre: #8a6d1f;

  /* 字級只有五階：14 / 16 / 20 / 28 / 40。拿掉 xs 與 lg，避免同一字級兩個名字 */
  --text-xs: initial;
  --text-lg: initial;
  --text-sm: 0.875rem;   --text-sm--line-height: 1.5;
  --text-base: 1rem;     --text-base--line-height: 1.7;
  --text-xl: 1.25rem;    --text-xl--line-height: 1.5;
  --text-2xl: 1.75rem;   --text-2xl--line-height: 1.25;
  --text-4xl: 2.5rem;    --text-4xl--line-height: 1.15;

  --font-display: var(--font-wenkai), "Noto Sans TC", serif;
  --font-sans: var(--font-noto), system-ui, sans-serif;
}
```

對應的全站替換（用 grep 確認，後面的任務直接用新名字）：

- `text-xs` → `text-sm`（18 處）
- `text-lg` → `text-xl`（8 處）
- `text-[28px]` → `text-2xl`（6 處：projects、creator、creator/[id]、login、workspace h1、market h2）
- `text-[40px]` → `text-4xl`（2 處：market h1、template h1）

在 `html { … }` 之後加元件配方。**不要巢狀 `@apply` 自訂類別**（v4 不支援），每個類別寫完整的 utilities：

```css
@layer components {
  /* 按鈕：全站只有 primary / secondary 兩種，外加 btn-sm 尺寸 */
  .btn { @apply inline-flex min-h-10 items-center justify-center gap-2 whitespace-nowrap rounded px-4 text-base font-medium disabled:cursor-not-allowed disabled:opacity-60; }
  .btn-primary { @apply bg-brand text-white hover:bg-brand-strong; }
  .btn-secondary { @apply border border-line bg-surface text-ink hover:border-ink; }
  .btn-sm { @apply min-h-8 px-3 text-sm; }

  /* 表單欄位 */
  .field { @apply mt-1 block w-full rounded border border-line bg-surface px-3 py-2 text-base text-ink placeholder:text-muted/80 focus:border-brand disabled:opacity-60; }
  .label { @apply block text-sm font-medium text-ink; }
  .hint { @apply mt-1 text-sm text-muted; }

  /* 面板與連結 */
  .panel { @apply rounded border border-line bg-surface; }
  .link { @apply text-brand underline underline-offset-2 hover:text-brand-strong; }

  /* 小標籤（狀態、工具）*/
  .chip { @apply inline-flex items-center gap-1 rounded-full border border-line bg-surface px-2 py-0.5 text-sm leading-5 text-muted; }
  .chip-brand { @apply border-brand-soft bg-brand-soft text-brand; }
  .chip-seal { @apply border-seal/40 text-seal; }

  /* 提示訊息：左邊一條色線，白底，不用淡色背景（ochre 在淡底對比不足） */
  .notice { @apply rounded border-l-2 bg-surface px-3 py-2 text-sm text-ink; }
  .notice-error { @apply border-seal text-seal; }
  .notice-warn { @apply border-ochre; }
  .notice-info { @apply border-brand text-muted; }

  /* 「處理中」的小圓點：只在使用者送出後出現，屬於回應操作的動態 */
  .dot-busy { @apply inline-block h-2 w-2 rounded-full bg-brand motion-safe:animate-pulse; }
}
```

另外在 `body` 加 `overflow-wrap: break-word;`，防長英文字串撐寬。

對比檢查（都過 AA）：ink/paper 15.0、muted/paper 5.4、brand/paper 8.0、白/brand 8.7、seal/surface 6.0、ochre/surface 4.9、brand/brand-soft 7.3。`.notice-warn` 的正文用 ink，只有左線用 ochre，所以不受 ochre 對比限制。

#### 1.2 `markdown.tsx`：字級、間距、表格可捲動

改前：`prose prose-sm max-w-none …`，表格直接輸出。

改後：

```tsx
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const components: Components = {
  // 表格只在自己的框裡橫向捲動，不撐寬版面（P0 #1）。
  // 一定要把 node 從 props 拿掉，否則 React 會對 <table> 警告未知屬性；
  // 專案的 eslint（eslint-config-next/typescript）把 no-unused-vars 設為 warn 且沒有 _ 前綴豁免，用 void 標記已讀。
  table: ({ node, ...props }) => {
    void node;
    return <div className="my-3 overflow-x-auto"><table className="my-0" {...props} /></div>;
  },
};

export function Markdown({ text, compact = false }: { text: string; compact?: boolean }) {
  return (
    <div className={[
      'prose max-w-none break-words',
      'prose-headings:font-display prose-headings:text-ink prose-headings:font-bold',
      'prose-h1:text-xl prose-h2:text-xl prose-h3:text-base prose-h4:text-base',
      'prose-a:text-brand prose-strong:text-ink prose-th:text-sm prose-td:text-sm prose-pre:text-sm',
      compact
        ? 'prose-sm prose-p:my-2 prose-li:my-0.5 prose-headings:mt-4 prose-headings:mb-1 prose-hr:my-3'
        : 'prose-p:my-3 prose-li:my-1 prose-headings:mt-6 prose-headings:mb-2 prose-hr:my-5',
    ].join(' ')}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{text}</ReactMarkdown>
    </div>
  );
}
```

- 主回覆（`message-view.tsx`）用預設（16px）；派工卡片與討論發言用 `compact`（14px、緊間距），這是收合預覽看得到內容的關鍵（P0 #3）。
- `compact` 是純呈現的 prop，不是 state。

#### 1.3 `seal.tsx`

加 `role="img"`，保留 `aria-label`；加 `shrink-0` 與 `select-none`。其餘不動。

#### 1.4 `file-button.tsx`

label 的 className 改成 `btn btn-secondary btn-sm cursor-pointer peer-focus-visible:outline …`（原本的 `peer-*` 與 `peer-disabled:*` 保留）。這樣「上傳檔案」「上傳 skill zip」跟其他次要按鈕同一個長相，不再是獨立的 brand 外框。

#### 1.5 `nav.tsx`：手機兩行，桌面一行

改前：所有東西一個 `flex-wrap`，390px 折三行。

改後結構：

```tsx
<header className="border-b border-line bg-surface">
  <nav className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-1 px-4 py-2 sm:px-6 sm:py-3">
    <Link href="/" className="font-display text-xl font-bold text-ink">AgentHub</Link>

    {/* 帳號區在手機排第一行右側，桌面排最右 */}
    <div className="ml-auto flex items-center gap-3 text-sm sm:order-last">
      {user ? (<>
        <span className="hidden text-muted md:inline">{user.email}</span>
        <form action={signOut}><button className="btn btn-secondary btn-sm">登出</button></form>
      </>) : (
        <Link href="/login" className="btn btn-primary btn-sm">登入</Link>
      )}
    </div>

    {/* 頁面連結：手機獨占第二行、可橫向捲；桌面接在品牌後面 */}
    <div className="-mx-4 flex w-[calc(100%+2rem)] gap-x-5 overflow-x-auto whitespace-nowrap px-4 pb-1 sm:mx-0 sm:w-auto sm:gap-x-6 sm:px-0 sm:pb-0">
      <Link href="/" className="text-muted hover:text-ink">市集</Link>
      {user && <Link href="/projects" className="text-muted hover:text-ink">我的專案</Link>}
      {user && <Link href="/creator" className="text-muted hover:text-ink">我上架的 agent</Link>}
    </div>
  </nav>
</header>
```

`nav.tsx` 是 server component，沒有 pathname，不做 active 樣式。

#### 1.6 `layout.tsx`

`<main>` 加 `id="main"` 與 `min-w-0`；`pb-16` 保留。在 `<body>` 開頭加一個跳到內容的連結：

```tsx
<a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2 focus:text-brand">跳到主要內容</a>
```

#### 驗收（任務 1）

- `grep -rnE 'text-xs|text-lg|text-\[' apps/web/app apps/web/components` 回傳 0 行。
- `grep -rnE '(^|[^-])disabled:opacity-60' apps/web/app apps/web/components` 回傳 0 行（元件裡全部改用 `.btn`／`.field`；`file-button.tsx` 的 `peer-disabled:opacity-60` 保留，所以用這個排除前綴的 pattern）。
- 導覽列 390px 截圖：兩行（品牌＋登出／連結列），無 email；1440px 一行。
- `next build` 過。

---

### 任務 2：工作區（對話、派工、討論、側欄）

**檔案**：`components/workspace/workspace.tsx`、`chat.tsx`、`message-view.tsx`、`delegation-card.tsx`、`discussion-view.tsx`、`tool-list.tsx`、`collapsible.tsx`、`agent-roster.tsx`、`file-panel.tsx`、`memory-panel.tsx`

#### 2.1 `workspace.tsx`：版面、手機側欄收合、狀態區

**允許新增的呈現用 state**：`const [panelOpen, setPanelOpen] = useState(false);` 只控制 `<lg` 寬度下側欄三個面板的顯示，不影響任何資料流。

外層 grid 改前：`grid gap-8 py-8 lg:grid-cols-[260px_1fr]`
改後：`grid gap-6 py-6 lg:grid-cols-[280px_minmax(0,1fr)] lg:gap-10 lg:py-8`

`aside` 改前：`space-y-8`
改後：`min-w-0 lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)] lg:self-start lg:overflow-y-auto lg:pr-1`，內部結構：

```tsx
<aside className="…">
  {/* 標題與環境狀態：手機也永遠看得到 */}
  <div>
    <h1 className="font-display text-2xl leading-tight">{project.name}</h1>
    {project.sprite_status === 'provisioning' && (
      <div role="status" className="notice notice-info mt-3">
        <p className="flex items-center gap-2 text-ink"><span className="dot-busy" aria-hidden />正在準備 agent 的工作電腦，約需一分鐘</p>
        <p className="mt-1">準備好之後就能送出訊息，這段時間可以先上傳資料。</p>
        {stalled && (<>
          <p className="mt-2">準備時間比平常久，可以重新準備。</p>
          <button onClick={retry} className="btn btn-secondary btn-sm mt-2">重新準備</button>
        </>)}
      </div>
    )}
    {project.sprite_status === 'error' && (
      <div role="alert" className="notice notice-error mt-3">
        <p className="font-medium">工作電腦準備失敗</p>
        <p className="mt-1 text-ink">{project.sprite_error}</p>
        <button onClick={retry} className="btn btn-secondary btn-sm mt-2">重新準備</button>
      </div>
    )}
  </div>

  {/* 手機：一顆開關；桌面：隱藏 */}
  <button type="button" onClick={() => setPanelOpen((o) => !o)} aria-expanded={panelOpen} aria-controls="workspace-panels"
    className="btn btn-secondary mt-4 w-full justify-between lg:hidden">
    <span>顧問、資料與記憶</span>
    <span className="text-muted">{panelOpen ? '收起' : '展開'}</span>
  </button>

  <div id="workspace-panels" className={`${panelOpen ? 'mt-6 block' : 'hidden'} space-y-8 lg:mt-8 lg:block`}>
    <AgentRoster … />
    <FilePanel … />
    <MemoryPanel … />
    <div className="border-t border-line pt-4">
      <button onClick={remove} className="link text-sm text-seal hover:text-seal">刪除專案</button>
    </div>
  </div>
</aside>
```

這顆開關在 `aside` 裡，不會干擾 `section[aria-label="對話"] > div:first-child > button`。

對話分頁的 `max-w-full truncate` 不能省：`.btn` 有 `whitespace-nowrap`，而 `threads[].title` 是 API 可以任意寫入的字串，沒有截斷的話一個長標題就會把 390px 的頁面再次撐寬。

`section` 改前：`<section aria-label="對話">`
改後：`<section aria-label="對話" className="min-w-0">`（P0 #1 的另一半：grid 子項允許縮到比表格窄）

對話分頁列（仍是 section 的第一個 `div`，裡面只有 button 與錯誤 `<p>`）：

```tsx
<div className="sticky top-0 z-10 -mx-4 mb-4 flex flex-wrap items-center gap-2 border-b border-line bg-paper px-4 py-3 sm:mx-0 sm:px-0">
  {threads.map((t, i) => (
    <button key={t.id} onClick={() => setThreadId(t.id)} aria-current={t.id === threadId ? 'true' : undefined} title={t.title}
      className={`btn btn-sm max-w-full truncate ${t.id === threadId ? 'btn-primary' : 'btn-secondary'}`}>
      {t.title === '新對話' ? `對話 ${threads.length - i}` : t.title}
    </button>
  ))}
  <button onClick={newThread} className="btn btn-sm border border-dashed border-line text-muted hover:border-ink hover:text-ink">開新對話</button>
  {error && <p role="alert" className="notice notice-error w-full">{error}</p>}
</div>
```

空狀態：

- 沒有顧問：
  ```tsx
  <div className="panel p-6">
    <p className="font-display text-xl">這張工作桌還沒有顧問</p>
    <p className="mt-1 text-muted">到市集挑一位加進來就能開始對話；加到第二位時會自動多一位主管幫你分工。</p>
    <Link href="/" className="btn btn-primary mt-4">到市集挑顧問</Link>
  </div>
  ```
- 有顧問、沒有對話：同樣的 panel，標題「開始第一個對話」，說明一句，按鈕保留 `onClick={newThread}`，className `btn btn-primary mt-4`。

#### 2.2 `chat.tsx`：訊息區、狀態列、輸入框

- 外層：`flex min-h-[60vh] flex-col` → `flex min-h-[calc(100vh-14rem)] flex-col`。訊息列表 `space-y-6 pb-4` → `space-y-7 pb-6`。
- 空對話（`messages.length === 0`）改前是一句灰字；改後：
  ```tsx
  <div className="panel p-5 text-muted">
    <p className="font-display text-xl text-ink">{hasManager ? '跟主管說你想完成的事' : `跟${speaker}說你想完成的事`}</p>
    <p className="mt-2">{hasManager ? '主管會分派給合適的顧問；需要跨專業權衡時，會召集大家討論，最後整理成一份建議。' : `${speaker}會直接處理，需要時會讀你上傳的專案資料。`}</p>
    <p className="mt-2 text-sm">說過的事實與偏好會記在左側「記憶」，之後的對話都會沿用。</p>
  </div>
  ```
  （手機上「左側」改成「上方面板」不好判斷，統一寫「記憶面板」。）
- 處理中（`busy`）：
  ```tsx
  {busy && (
    <p role="status" className="flex items-center gap-2 text-sm text-muted">
      <span className="dot-busy" aria-hidden />
      {waiting ? '回覆還在進行中，完成後會自動顯示' : `${speaker}正在處理`}
    </p>
  )}
  ```
- `notice`：`<p role="alert" className="notice notice-error">{notice}</p>`。
- 輸入框區：
  ```tsx
  <form onSubmit={submit} className="sticky bottom-0 -mx-4 border-t border-line bg-paper px-4 py-3 sm:mx-0 sm:px-0">
    <div className="flex items-end gap-2">
      <label className="min-w-0 flex-1">
        <span className="sr-only">訊息</span>
        <textarea rows={2} … className="field mt-0 resize-none" placeholder={ready ? '輸入訊息給' + speaker : '工作電腦準備好之後才能送出'} />
      </label>
      <button disabled={…} className="btn btn-primary">送出</button>
    </div>
    <p className="mt-1 hidden text-sm text-muted sm:block">Enter 送出，Shift+Enter 換行</p>
  </form>
  ```
  placeholder 不再塞快捷鍵說明，手機上才放得下。

#### 2.3 `message-view.tsx`

- 使用者訊息：`max-w-[85%] whitespace-pre-wrap rounded bg-brand px-4 py-2 text-white` → `max-w-[85%] whitespace-pre-wrap rounded-lg bg-brand px-4 py-2.5 text-white sm:max-w-[70%]`。
- 說話者標籤：`mb-1 font-display text-sm text-muted` → `mb-2 font-display text-base font-bold text-ink`。
- 一般工具紀錄從 `<p>` 改成 inline chip，連續的會自動排成一行，碰到 Markdown 區塊才換行：
  ```tsx
  <span key={i} className={`chip mb-2 mr-2 ${failed ? 'chip-seal' : ''}`}>
    {failed ? '工具失敗' : done ? '用了' : '正在用'}{TOOL_LABELS[name] ?? name}
  </span>
  ```
- `data-warning`：
  ```tsx
  <p key={i} role="status" className="notice notice-warn my-2"><span className="font-medium text-ochre">提醒</span>　{text}</p>
  ```

#### 2.4 `delegation-card.tsx`

改前：左邊 4px 色條、名字 20px 一般字重上色、狀態小灰字、整段 task 直接印出、結果 Collapsible。

改後：

```tsx
<div className="my-4 overflow-hidden rounded border border-line border-l-4 bg-surface" style={{ borderLeftColor: color }}>
  <div className="flex items-center justify-between gap-3 px-4 pt-3">
    <span className="font-display text-xl font-bold" style={{ color }}>{name}</span>
    {failedText !== undefined || output?.status === 'failed'
      ? <span className="chip chip-seal">失敗</span>
      : !output || output.status === 'working'
        ? <span className="chip chip-brand"><span className="dot-busy" aria-hidden />處理中</span>
        : <span className="chip">完成</span>}
  </div>
  <div className="px-4 pb-4">
    {task && (
      <details className="group mt-2 text-sm">
        {/* 收合時顯示兩行預覽，展場不用點就看得到主管交辦了什麼；展開後預覽消失、全文出現 */}
        <summary className="cursor-pointer list-none select-none [&::-webkit-details-marker]:hidden">
          <span className="text-muted">主管交辦</span>
          <span className="mt-0.5 block line-clamp-2 text-ink group-open:hidden">{task}</span>
        </summary>
        <p className="mt-1 whitespace-pre-wrap text-ink">{task}</p>
      </details>
    )}
    <ToolList tools={output?.tools} />
    {failedText !== undefined && <p className="notice notice-error mt-3">{failedText}</p>}
    {output?.status === 'failed' && <p className="notice notice-error mt-3">{output.error}</p>}
    {output?.message && <div className="mt-3">
      {output.status === 'done'
        ? <Collapsible><Markdown compact text={textOf(output.message)} /></Collapsible>
        : <Markdown compact text={textOf(output.message)} />}
    </div>}
  </div>
</div>
```

名字用 `font-bold`：20px 粗體屬 WCAG 大字（≥ 18.66px 粗體），門檻 3:1，`#B5651D` 4.34 通過（P0 #4）。`<details>` 是原生元素，不需要 state。

#### 2.5 `discussion-view.tsx`

容器：

```tsx
<section className="my-4 rounded border border-line bg-paper p-3 sm:p-4" aria-label="顧問討論">
  <div className="flex flex-wrap items-baseline justify-between gap-2">
    <h3 className="font-display text-xl">顧問討論</h3>
    <span className={`chip ${state.finished ? '' : 'chip-brand'}`}>
      {state.finished ? `已結束，共 ${state.round} 輪` : <><span className="dot-busy" aria-hidden />第 {state.round} 輪，最多 3 輪</>}
    </span>
  </div>
  <p className="mt-1 text-sm text-muted">{state.topic}</p>
  {rounds.map((round) => (
    <div key={round} className="mt-5">
      <h4 className="mb-2 flex items-center gap-3 text-sm font-medium text-muted">
        <span>{round === 1 ? '第 1 輪：各自提出意見' : `第 ${round} 輪：互相回應`}</span>
        <span aria-hidden className="h-px flex-1 bg-line" />
      </h4>
      <div className="space-y-3">…SpeechBlock…</div>
    </div>
  ))}
  {state.finished
    ? (state.error
        ? <p className="notice notice-error mt-4">討論提前結束：{state.error}</p>
        : <p className="mt-4 text-sm text-muted">討論結束。主管的總結在下方。</p>)
    : failedText !== undefined && <p className="notice notice-error mt-4">討論提前結束：{failedText}</p>}
</section>
```

`SpeechBlock`：與派工卡片同一套外框（`rounded border border-line border-l-4 bg-surface`，`borderLeftColor`），名字 `font-display text-xl font-bold`，右側 `發言中…` 改成 `<span className="chip chip-brand"><span className="dot-busy" />發言中</span>`，完成且有立場時放 `<Seal>`。`未發言：{error}` 改成 `notice notice-error`。正文 `Markdown compact`，完成後包 `Collapsible`。

還沒開始（`!state`）：`<p className="flex items-center gap-2 text-sm text-muted"><span className="dot-busy" />主管正在召集顧問</p>`。沒開始就失敗：`notice notice-error`「討論沒有開始：{failedText}」。

每個發言開頭重複的「以下為一般性分析，不構成…」是顧問 system prompt 的內容，不在本方案範圍，不要在前端過濾。

#### 2.6 `tool-list.tsx`

輸出改成 chip 列：

```tsx
<p className="mt-2 flex flex-wrap gap-x-2 gap-y-1 text-sm text-muted">
  <span>用了</span>{names.map((n) => <span key={n} className="chip">{n}</span>)}
</p>
```

#### 2.7 `collapsible.tsx`

- `max-h-48` → `max-h-56`（配合 compact prose，預覽大約 10 行）。
- 淡出層 `h-10` → `h-12`。
- 按鈕 className → `link mt-2 text-sm no-underline hover:underline`。

#### 2.8 `agent-roster.tsx`

- 主管單獨列在最上面：有 `manager` 時先 render 一列，圓點 `bg-ink`，名字「主管」，說明「分工、召集討論、整理總結」。
- 顧問說明 `text-xs text-muted` → `text-sm text-muted line-clamp-2`（P1 #17）。
- 「再加一位顧問」→ `btn btn-secondary btn-sm mt-3`。沒有顧問時的 `到市集挑選` → `link`。

#### 2.9 `file-panel.tsx`、`memory-panel.tsx`

- 所有 `text-xs` → `text-sm`（任務 1 已經做）。
- 檔案列：`<li className="flex items-baseline justify-between gap-2 text-sm"><span className="truncate">{f.name}</span><span className="shrink-0 text-muted">{(f.size / 1024).toFixed(0)} KB</span></li>`。
- 記憶：編輯 textarea 用 `field`；「修改」「刪除」「儲存」「取消」改成 `link text-sm`，刪除用 `text-seal`，按鈕之間 `gap-3`，加 `py-1` 擴大點擊範圍。
- 兩個面板的錯誤 → `notice notice-error mt-2`。

#### 驗收（任務 2）

- 以 `scratchpad/probe2.cjs` 的做法量測：登入 demo 帳號，開「金融科技展 Demo」兩個對話，390px 下 `document.documentElement.scrollWidth === 390`，`section[aria-label="對話"]` 寬度 ≤ 358。表格在自己的框裡橫向捲動。
- 390px 截圖：第一屏看到專案名稱、側欄開關、對話分頁列、第一則訊息。
- 1440px 捲到長回覆底部時，側欄仍在可視範圍（sticky）。
- 07 的每個收合發言預覽都看得到至少三行正文。
- `section[aria-label="對話"] > div:first-child > button` 數量 = 對話數 + 1，順序不變。
- 用 `POST /api/projects/:id/threads` 建一個 title 超過 30 字的對話，390px 下分頁按鈕被截斷、`scrollWidth` 仍是 390；驗完刪掉這個專案。
- `grep -n useState components/workspace/workspace.tsx` 只多出 `panelOpen` 一行；`chat.tsx` 的 useState／useEffect／useCallback 行數與改前相同。

---

### 任務 3：市集與顧問介紹（Demo 第一印象）

**檔案**：`app/page.tsx`、`app/templates/[id]/page.tsx`、`components/hire-form.tsx`

#### 3.1 `app/page.tsx`

Hero：

```tsx
<section className="py-10 sm:py-14">
  <h1 className="max-w-3xl font-display text-2xl leading-tight sm:text-4xl">請專業的人，帶著他們的方法來幫你做事</h1>
  <p className="mt-4 max-w-2xl text-muted sm:text-xl">每一位顧問都是律師、會計師、金融從業者把自己的 SOP 做成的 agent。加進你的專案，他們會分工、討論，最後給你一份整合過的建議。</p>
  <ol className="mt-8 grid gap-3 sm:grid-cols-3">
    {[['挑顧問', '在名冊裡挑一位，看這位顧問會做什麼、用什麼工具。'], ['加進專案', '一鍵加入。你的資料、對話與記憶都留在自己的專案裡。'], ['派工與討論', '兩位以上顧問時，主管會分工；需要權衡時召開討論，最後總結。']].map(([t, d], i) => (
      <li key={t} className="panel p-4">
        <div className="font-display text-xl"><span className="mr-2 text-brand">{i + 1}</span>{t}</div>
        <p className="mt-1 text-sm text-muted">{d}</p>
      </li>
    ))}
  </ol>
</section>
```

名冊：

```tsx
<section aria-labelledby="roster">
  <div className="mb-4 flex items-baseline justify-between">
    <h2 id="roster" className="font-display text-2xl">顧問名冊</h2>
    <span className="text-sm text-muted">共 {templates.length} 位</span>
  </div>
  <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
    {templates.map((t) => (
      <li key={t.id}>
        <Link href={`/templates/${t.id}`} className="panel flex h-full flex-col p-5 hover:border-brand">
          <div className="text-sm text-brand">{t.category || '未分類'}</div>
          <div className="mt-1 font-display text-xl">{t.name}</div>
          <div className="text-sm text-muted">由 {t.creator_name || '匿名創作者'} 製作</div>
          <p className="mt-3 line-clamp-3 flex-1 text-muted">{t.description || '（創作者還沒寫介紹）'}</p>
          <div className="mt-4 flex flex-wrap gap-2 text-sm text-muted">
            {t.skills.slice(0, 3).map((s) => <span key={s.name} className="chip">{s.name}</span>)}
            {t.skills.length > 3 && <span className="chip">+{t.skills.length - 3}</span>}
            {t.mcp_servers.length > 0 && <span className="chip">{t.mcp_servers.length} 個外部工具</span>}
          </div>
        </Link>
      </li>
    ))}
  </ul>
</section>
```

skill 名稱直接顯示在卡片上（「cashflow」「valuation」比「2 個 skill」有資訊）。空狀態用 `panel border-dashed p-6`，加 `<Link href="/creator" className="btn btn-secondary mt-3">去上架第一位</Link>`。

#### 3.2 `app/templates/[id]/page.tsx`：手機先看到「加入專案」

把 `article` 拆成「標題區」與「細節區」，grid 用區域排列，手機 DOM 順序是標題 → 加入面板 → 細節，桌面右欄跨兩列：

```tsx
<div className="grid gap-8 py-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:grid-rows-[auto_1fr] lg:gap-x-12 lg:py-10">
  <header className="min-w-0">
    <p className="text-sm text-brand">{template.category || '未分類'}<span className="text-muted">，由 {template.creator_name || '匿名創作者'} 製作</span></p>
    <h1 className="mt-1 font-display text-2xl leading-tight sm:text-4xl">{template.name}</h1>
    <p className="mt-4 max-w-2xl whitespace-pre-line">{template.description || '（創作者還沒寫介紹）'}</p>
  </header>

  <aside className="panel h-fit p-5 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:sticky lg:top-6">
    <h2 className="mb-3 font-display text-xl">加入你的專案</h2>
    …（三個分支不變，草稿與未登入的文字用 .link）
  </aside>

  <section className="min-w-0 lg:col-start-1">
    <h2 className="font-display text-xl">這位顧問會的事</h2>
    {skills 空：<p className="hint">沒有額外的 skill，只靠創作者寫的工作方法。</p>}
    <ul className="mt-3 grid gap-3 sm:grid-cols-2">
      {template.skills.map((s) => (
        <li key={s.name} className="panel p-4">
          <div className="font-medium">{s.name}</div>
          <div className="mt-1 text-sm text-muted">{s.description}</div>
        </li>
      ))}
    </ul>
    {mcp：<h2 className="mt-8 font-display text-xl">會用到的工具</h2> + chip 列}
  </section>
</div>
```

#### 3.3 `hire-form.tsx`

- select → `field`；label 文字 → `label`。
- 需要金鑰的 fieldset：
  ```tsx
  <fieldset className="rounded border border-line bg-paper p-3">
    <legend className="px-1 text-sm font-medium">這位顧問的工具需要你的金鑰</legend>
    <p className="hint mt-0">只會存在你的專案裡，創作者看不到。</p>
    {needed.map((n) => (
      <label key={…} className="mt-3 block">
        <span className="label"><span className="chip mr-2">{n.server}</span>{n.key}</span>
        {n.description && <span className="hint">{n.description}</span>}
        <input … className="field font-mono" />
      </label>
    ))}
  </fieldset>
  ```
- 錯誤 → `notice notice-error`。送出鈕 → `btn btn-primary w-full`。
- 沒有專案：`<div className="notice notice-info">要先有一個專案才能加入顧問。</div>` 後面接 `<Link href="/projects" className="btn btn-secondary mt-3">建立專案</Link>`。

#### 驗收（任務 3）

- 01 桌面：三欄卡片、三步驟說明；390px 單欄卡片，無水平捲動。`a[href^="/templates/"]` 數量 = 顧問數。
- 02／05 手機：「加入你的專案」面板在第一屏或第二屏（標題與介紹之後、skill 清單之前）。
- 05 桌面：右欄面板在捲動時固定。

---

### 任務 4：專案列表、創作者頁、顧問編輯器、登入

**檔案**：`app/projects/page.tsx`、`components/new-project-form.tsx`、`app/creator/page.tsx`、`components/new-template-button.tsx`、`app/creator/[id]/page.tsx`、`components/template-editor.tsx`、`app/login/page.tsx`、`app/login/login-form.tsx`

#### 4.1 專案列表

- `new-project-form.tsx`：input → `field mt-0`，`min-w-64 flex-1` → `min-w-0 flex-1 basis-64`；按鈕 → `btn btn-primary`；錯誤 → `notice notice-error w-full`。
- 列表每列：
  ```tsx
  <Link href={`/projects/${p.id}`} className="flex items-center justify-between gap-4 px-4 py-4 hover:bg-brand-soft">
    <span className="font-display text-xl">{p.name}</span>
    <span className={`chip ${p.sprite_status === 'error' ? 'chip-seal' : p.sprite_status === 'provisioning' ? 'chip-brand' : ''}`}>
      {p.sprite_status === 'provisioning' && <span className="dot-busy" aria-hidden />}{STATUS[p.sprite_status]}
    </span>
  </Link>
  ```
- 空狀態：`panel border-dashed mt-8 p-6`，標題「還沒有專案」，說明「取個名字建立第一個，接著到市集挑顧問。建立時會替專案準備一台 agent 的工作電腦，約需一分鐘。」

#### 4.2 創作者頁

- `new-template-button.tsx` 按鈕 → `btn btn-primary`；錯誤 → `notice notice-error mt-2`。
- 列表每列：狀態 chip（已上架 `chip-brand`／草稿 `chip`）＋ `{t.skills.length} 個 skill`；「編輯」→ `btn btn-secondary btn-sm`（仍是 `a[href^="/creator/"]`）。
- 空狀態 `panel border-dashed p-6`。

#### 4.3 顧問編輯器 `template-editor.tsx`

結構改成三個 `panel p-5` 區塊加一條固定在底部的操作列。只改 JSX 與 className，`run`／`save`／`uploadZip`／`publish` 不動。

- 頁首（`creator/[id]/page.tsx`）：h1 `text-2xl` 旁加狀態 chip（`initial.status`）。
- **區塊一「基本資料」**：每個欄位 `label` 當標題、`hint` 放說明，不再把說明塞進 label 文字：
  - 名稱
  - 分類，hint「例如：法律、財務、行銷。會顯示在市集卡片上。」
  - 介紹，hint「顯示在市集，也是主管決定派什麼工作給這位顧問的依據。」
  - System prompt，hint「你的工作方法與 SOP。使用者看不到這段。」textarea `field min-h-72 font-mono text-sm`
- **區塊二「Skill」**：說明一句、`FileButton`、清單改成 `ul.mt-3.space-y-2` 每項 `rounded border border-line p-3`（名稱 `font-medium`、描述 `text-sm text-muted`）；沒有 skill 時顯示 `hint`「還沒有 skill。沒有也能上架，顧問只靠 system prompt 工作。」
- **區塊三「工具（MCP）」**：每個 fieldset 加 `<legend className="px-1 text-sm font-medium">工具 {i + 1}</legend>`；所有 input/select/textarea → `field`；「移除這個工具」→ `link text-sm text-seal hover:text-seal`；「新增工具」→ `btn btn-secondary`。
- **操作列**：
  ```tsx
  <div className="sticky bottom-0 -mx-4 border-t border-line bg-paper px-4 py-3 sm:mx-0 sm:px-0">
    {message && (
      <p role={…} className={`notice mb-3 whitespace-pre-line ${message.kind === 'error' ? 'notice-error' : 'notice-info'}`}>{message.text}</p>
    )}
    <div className="flex flex-wrap items-center gap-3">
      <button onClick={save} disabled={busy} className="btn btn-secondary">儲存</button>
      <button onClick={publish} disabled={busy} className="btn btn-primary">{…}</button>
      {t.status === 'published' && <Link href={`/templates/${t.id}`} className="link ml-auto text-sm">看市集上的樣子</Link>}
    </div>
  </div>
  ```
  訊息放操作列上方，zip 驗證錯誤的多行清單（`whitespace-pre-line`）會貼著按鈕出現，不用往下找。

#### 4.4 登入

- `login/page.tsx`：外層 `mx-auto mt-10 max-w-sm` 內包一層 `panel p-6`；h1 `text-2xl`。
- `login-form.tsx`：label 文字 → `label`，input → `field`；錯誤 → `notice notice-error`；按鈕列 `flex gap-3`：第一顆仍是「登入」`btn btn-primary flex-1`，第二顆「建立帳號」`btn btn-secondary flex-1`。

#### 驗收（任務 4）

- 03／04／08／09 手機與桌面截圖：按鈕高度一致（40px），輸入框一致，狀態 chip 可辨。
- 09：三個面板分區；操作列固定底部；觸發一次 zip 驗證錯誤（上傳一個沒有 SKILL.md 的 zip），多行錯誤出現在按鈕上方。
- 登入表單第一顆 `button` 文字是「登入」，`input[name=email]`／`input[name=password]` 存在。

## 5. 驗收方式

**全部任務完成後，依序執行，缺一不可：**

```bash
cd /Users/eric/Desktop/AgentHub
pnpm -F @agenthub/web lint
pnpm -F @agenthub/web typecheck
pnpm -r --workspace-concurrency=1 test
pnpm -F @agenthub/web build
```

**靜態檢查（grep）**

```bash
cd apps/web
grep -rnE 'text-xs|text-lg|text-\[' app components            # 期望 0 行
grep -rnE '(^|[^-])disabled:opacity-60' app components         # 期望 0 行（只在 globals.css；file-button 的 peer-disabled: 不算）
grep -rn 'useState' components/workspace/workspace.tsx         # 期望比改前多且只多 panelOpen 一行
git diff --stat <BASE> -- lib proxy.ts next.config.ts vercel.json app/api ../../packages ../../supabase   # 期望空
```

`git diff` 以動工前的 commit 為基準（`git diff <BASE> -- …`）。

**截圖回歸**

1. 確認 `/projects` 只有「金融科技展 Demo」（流程測試的專案跑完會自己刪掉），`shoot.cjs` 才會截到 Demo 專案。
2. `cd scratchpad && node shoot.cjs after`，產出 `after/01–09` 桌面與手機各一張。
3. 和 `before/` 逐張並排看，重點：
   - 07 手機檔案寬度必須是 390（改前 590）。
   - 06／07 手機第一屏：專案名稱、側欄開關、對話分頁、第一則訊息。
   - 07 每個收合區塊看得到正文。
   - 01 卡片版型、02／05 手機加入面板的位置、導覽列兩行。
4. 水平捲動量測：沿用 `scratchpad/probe2.cjs`（登入後走訪每個專案的每個對話，印 `scrollWidth`），所有頁面與對話都要是 390。市集、顧問介紹、登入、專案列表、創作者頁、編輯器各加一次 `scrollWidth` 檢查。

**鍵盤與對比**

- 每頁用 Tab 走一遍：導覽列、卡片、分頁按鈕、側欄開關、輸入框、送出、收合按鈕都要看到 brand 色外框；跳到內容的連結在第一個 Tab 出現。
- 新增的顏色組合只有 `brand-strong` 底白字（> 8.66:1）與 `#B5651D` 粗體 20px（4.34 ≥ 3:1）。其他沿用 token，數據見任務 1.1。

**截圖沒拍到的狀態，至少各手動看一次**（用 `scratchpad/flow.cjs` 建新專案走流程最快）：

| 狀態 | 在哪裡觸發 | 期望 |
|---|---|---|
| Sprite 準備中／準備過久 | 新建專案後立刻進工作區；等 120 秒 | `notice-info` 加 `dot-busy`；120 秒後多出「重新準備」按鈕 |
| 準備失敗 | 舊的失敗專案 | `notice-error` 標題＋原因＋按鈕 |
| 空專案、空對話 | 新專案；新開對話 | panel 空狀態與主要按鈕 |
| 串流中、輪詢中 | 送出訊息；讓討論超過 300 秒 | `dot-busy` 行；文字切換成「回覆還在進行中」 |
| 派工處理中／失敗 | 送派工訊息；中途讓 Sprite 休眠 | chip 從「處理中」變「完成」或「失敗」＋ `notice-error` |
| 討論進行中、提前結束 | 送會召集討論的訊息 | 「第 n 輪，最多 3 輪」chip；錯誤時 `notice-error` |
| `data-warning` | 上傳一個超大檔案後要求讀取 | `notice-warn` 有「提醒」字樣 |
| 檔案上傳中、失敗 | 上傳檔案 | `FileButton` 顯示「上傳中…」；錯誤 `notice-error` |
| 啟用需要 MCP 金鑰 | 加入 `apps/web/demo/agents` 裡有 `required_secrets` 的顧問 | fieldset 內 chip 標 server 名稱 |
| skill zip 驗證錯誤 | 上傳沒有 SKILL.md 的 zip | 多行錯誤貼在操作列上方 |

每個任務完成後各自 commit（在 `feat/mvp` 分支）。卡片上用到的欄位（例如 `skills`、`mcp_servers`、`creator_name`）以 `lib/services/templates.ts` 公開型別實際有的為準，沒有的就不顯示，不要為此改 `lib/**` 或 API。
