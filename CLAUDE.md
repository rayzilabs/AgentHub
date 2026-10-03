# AgentHub

專業人士把 SKILL / SOP 包裝成可租用的 AI 顧問；使用者一鍵啟用到自己的專案。單一顧問直接對話；兩位以上時自動出現主管，負責派工（`assign_task`）或召開最多 3 輪的討論（`convene_discussion`）。MVP：沒有金流，安全性刻意不處理（規格 §10）。

- 規格：`docs/superpowers/specs/2026-10-02-agenthub-mvp-design.md`（有疑問以規格為準）
- 實作計畫：`docs/superpowers/plans/`；production 驗證紀錄：`docs/superpowers/reports/`
- Production：https://agenthub-kappa-pink.vercel.app

## 開發原則

1.  不要為了向下相容留垃圾： 直接刪掉過時的路徑，不要疊加相容層
2.  選最簡單的實現： 滿足當前需求就好，別過度抽象和預判
3.  分層成長： 先做出最小可用的端到端版本，再一層層往上疊，別用半成品換掉能跑的產品
4.  保持模組化： 組件職責要分離清楚
5.  優先用成熟的輪子： 能降低複雜度的就用現成函式庫，別重造
6.  先用專案已有的依賴： 寫新程式前先查文件，別急著裝新套件
7.  做長期的架構決策： 別接受那種「先暫時這樣，以後再重構」的解法

## 架構

```
瀏覽器 ──▶ Vercel（apps/web：頁面 + /api/*）──▶ Supabase（Postgres、Auth、Storage）
                    └─ 轉送 /chat ──▶ Fly Sprite（每專案一台，名稱 agenthub-<project id>）
                                        └─ packages/runtime（Hono + Vercel AI SDK v7 + Vertex Gemini）
```

- **瀏覽器只打 Vercel `/api/*`**，不直接連 Supabase（唯一例外：檔案上傳用 Storage 簽名網址 PUT）。所有資料表開 RLS 且沒有 policy，只有伺服器端用 secret key（`adminDb()`）存取；權限檢查寫在 `lib/services/*`（`user.id` 比對擁有者）。
- **runtime 跑在 Sprite 裡**，由 Vercel 從 Storage `runtime/main.js` 安裝成服務。runtime 直接讀寫 Supabase（run、訊息、記憶、檔案同步）。
- 對話串流：runtime 把 UI stream tee 成兩路，一路回瀏覽器、一路寫 DB，所以瀏覽器斷線不影響結果；前端串流中斷時改輪詢 `/api/threads/:id/messages`。
- 派工 / 討論是 generator tool，用 preliminary output 推送快照（`DelegationOutput` 在 `packages/runtime/src/tools/delegate.ts`、`DiscussionState` 在 `tools/discuss.ts`），前端在 `components/workspace/` 渲染。**web 端在 `apps/web/lib/agent-output.ts` 有一份相同的型別，改形狀時兩邊要一起改。**
- Vercel Hobby：函式最長 300 秒（`maxDuration = 300`），所以長討論會在 production 改成輪詢，這是預期行為。

## 專案結構

```
apps/web/                Next.js 16（App Router），部署到 Vercel，root directory = apps/web
  app/api/**/route.ts    API：一律用 route() 包裝、requireUser(req)、readJson(req, schema)
  lib/services/          商業邏輯（templates / projects / threads / files），第一個參數是 db
  lib/sprites.ts         建立 Sprite、安裝 runtime、轉送對話
  lib/schemas.ts         zod 表單 / API 驗證（template、MCP 設定）
  components/workspace/  對話、派工卡片、討論畫面
  demo/agents/           Demo 三位金融顧問（agent.json + skills/）
  scripts/               seed-demo、smoke、redeploy-runtime
packages/runtime/        agent runtime，esbuild 打包成單一 dist/main.js
  src/agents/            主管 / 顧問的 prompt 與組裝
  src/tools/             bash、files、memory、delegate（派工）、discuss（討論）
supabase/migrations/     schema、RPC（hire_agent、get_project_secrets）、buckets
supabase/tests/          pgTAP
```

## 常用指令

```bash
pnpm install
pnpm test                                  # 全部單元測試（Vitest）
pnpm typecheck
pnpm -F @agenthub/web test test/projects.test.ts    # 跑單一檔案
pnpm -F @agenthub/web dev                  # http://localhost:3000，連雲端 Supabase、建立真的 Sprite
pnpm db:push                               # 套用 migration 到雲端 Supabase
pnpm db:test                               # pgTAP（對雲端 DB，需要 Docker/OrbStack 跑 pg_prove）
cd apps/web && pnpm exec tsx scripts/smoke.ts       # 冒煙測試，BASE_URL 預設 localhost:3000
```

- 沒有本機 Supabase；**測試直接打雲端 Supabase**（ref `xrcyllzqionkwareukif`）。測試帳號用 `@test.local` 結尾，global setup 結束時會清掉。
- 所有腳本與 Next 都從 repo 根目錄 `.env` 讀環境變數：`SUPABASE_URL`、`SUPABASE_PUBLISHABLE_KEY`、`SUPABASE_SECRET_KEY`、`FLY_SPRITES_TOKEN`、`VERTEX_API_EXPRESS_MODE_KEY`。
- pgTAP 測試開頭要加 `set local role postgres; set local search_path to public, extensions;`，否則會缺 `extensions` schema 權限。

## 部署

改了哪一層就部署哪一層：

| 改動 | 部署方式 |
|---|---|
| `apps/web` | push 到 `main`（Vercel 自動部署） |
| `packages/runtime` | `pnpm -F @agenthub/runtime publish-runtime` → `cd apps/web && pnpm exec tsx scripts/redeploy-runtime.ts` |
| `supabase/migrations` | `pnpm db:push`，再 `pnpm db:test` |

**push 到 `main` 會自動部署 production**（Vercel 連 GitHub `rayzilabs/AgentHub`，root directory `apps/web`，區域 `sin1`）。部署狀態用 `vercel ls agenthub` 或 GitHub commit 的 status 查看。

- Vercel 的環境變數已在專案設定好，`.env` 不進 git。
- `publish-runtime` 會上傳 `runtime/main.js` 與 `runtime/main-<commit>.js`；新專案自動用最新版，既有專案要跑 `redeploy-runtime.ts`。
- 部署後跑 `BASE_URL=https://agenthub-kappa-pink.vercel.app pnpm exec tsx scripts/smoke.ts` 驗證（約 3 分鐘，會建立並刪除一台 Sprite）。

## Git

- 直接在 `main` 開發、commit、push 到 `origin main`；push 前先跑 `pnpm test` 與 `pnpm typecheck`，因為 push 就會上 production。
- 不要 commit `.env`、`.superpowers/`（SDD 工作區與 demo 密碼都在裡面）。

## 慣例

- UI 文字、錯誤訊息、註解都用繁體中文；錯誤訊息要說清楚發生什麼、怎麼處理。
- 設計 token 在 `apps/web/app/globals.css` 的 `@theme`（paper / surface / sunken / ink / muted / line / brand（填色）/ link（文字色）/ seal / ochre / sage、字級 14/16/20/28/40），深色模式在同檔 `prefers-color-scheme: dark` 重新定義同一組 token。標題用霞鶩文楷 TC，內文優先系統字（PingFang TC）、退回 Noto Sans TC。不要另外寫死色碼。
- 視覺與動態依 Apple 設計原則（`docs/superpowers/plans/2026-10-03-apple-redesign.md`）：淺灰底上的白色群組（`.panel`、`.group-title`）、浮在內容上的用半透明材質（`.material`）、按下即回饋（`:active` 縮放）、會動的東西用 `motion/react` 的彈簧（預設臨界阻尼，`components/providers.tsx`），並尊重減少動態 / 透明度 / 高對比設定。
- Next.js 16：用 `proxy.ts`（不是 middleware）、route params 是 Promise、背景工作用 `after()`。
- AI SDK v7、`@fly/sprites`、Next 16 的 API 和舊版差很多，寫之前先用 context7 查文件。
- 公開的 template API 不能回傳 `system_prompt`、`skills_zip_path`、MCP 連線設定。

## 不要碰

- 其他 Supabase 專案（`agenthub-fintech`、Tryzeon App、RiluTrip）。
- Fly 上不是 `agenthub-` 開頭的 Sprite（例如 `qm-*`）。
- Demo 專案「金融科技展 Demo」的 Sprite 要保持運作；Demo 資料用 `DEMO_PASSWORD=… pnpm exec tsx scripts/seed-demo.ts` 重建（密碼在 `.superpowers/demo-password`，不要貼出或 commit）。
