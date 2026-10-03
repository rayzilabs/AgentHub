# AgentHub

專業人士（律師、行銷、金融從業者等）把自己的 SKILL 和 SOP 包裝成可租用的 AI 顧問；使用者在市集一鍵啟用，就能在自己的專案裡和顧問對話。專案裡有兩位以上顧問時，會自動出現一位主管，負責派工或召開討論，最後整合成一份回覆。

Production：https://agenthub-kappa-pink.vercel.app

> 這是 MVP：沒有金流，也刻意不處理安全性（見[已知限制](#已知限制)）。不要放真實客戶的機密資料。

## 功能

- **上架顧問**：創作者填寫名稱、介紹、system prompt，上傳 skill zip，設定需要的 MCP 工具後發布到市集。市集只公開介紹，不會露出 system prompt、skill 檔與 MCP 連線設定。
- **一鍵啟用**：啟用時只複製 system prompt、skills 和 MCP 設定；執行環境與記憶都是專案自己的。MCP 需要金鑰時由使用者填寫。
- **單一顧問**：直接對話，回覆即時串流。顧問可以讀寫專案檔案、執行指令，並自己決定要記住什麼。
- **多顧問**：加入第二位顧問時自動建立主管。主管可以：
  - **派工**：把工作交給某位顧問，畫面上即時顯示交辦內容、用到的工具與完成狀態。
  - **召開討論**：第一輪所有顧問同時發言，之後依序回應，最多 3 輪；全員表態「同意」就提早結束。主管最後依「各面向建議／共識方案／仍有分歧」寫總結。

## 架構

```
瀏覽器 ──▶ Vercel（Next.js：頁面 + /api/*）──▶ Supabase（Postgres、Auth、Storage）
                     │
                     └─ 轉送對話 ──▶ Fly Sprite（每個專案一台）
                                       └─ agent runtime（Hono + Vercel AI SDK）
                                            ├─ Google Vertex AI（Gemini）
                                            ├─ 工具：bash、檔案、記憶、MCP
                                            └─ 主管工具：派工、召開討論
```

- 瀏覽器只呼叫 Vercel 的 `/api/*`；唯一例外是上傳檔案時直接 PUT 到 Storage 的簽名網址。Supabase 的資料表全部開啟 RLS 且沒有 policy，只有伺服器端用 secret key 存取。
- 建立專案時，Vercel 會建立一台 Sprite、從 Storage 下載 `runtime/main.js` 並註冊成服務。Sprite 閒置會休眠，收到請求時自動喚醒。
- runtime 把對話串流同時送回瀏覽器和寫進資料庫，瀏覽器斷線不會遺失結果；串流中斷時前端改成輪詢。

完整設計見 [技術規格](docs/superpowers/specs/2026-10-02-agenthub-mvp-design.md)。

## 專案結構

```
apps/web/              Next.js 網站與 API（部署到 Vercel）
  app/                 頁面與 /api 路由
  components/          工作區 UI（對話、派工卡片、討論畫面）
  lib/                 服務層、Supabase、Sprite 管理、表單驗證
  demo/agents/         Demo 用的三位金融顧問
  scripts/             seed、冒煙測試、更新所有 Sprite 的 runtime
packages/runtime/      跑在 Sprite 裡的 agent runtime（打包成單一 main.js）
supabase/
  migrations/          資料表、RPC、Storage bucket
  tests/               pgTAP 測試
docs/superpowers/      規格、實作計畫、production 驗證紀錄
```

## 本機開發

### 需要的工具

- Node.js 24 以上、pnpm 12（`corepack enable`）
- [Supabase CLI](https://supabase.com/docs/guides/cli)（只用來推 migration 和跑資料庫測試，不需要本機 Supabase）
- Docker：只有 `pnpm db:test` 需要
- 帳號：Supabase 雲端專案、Fly Sprites token、Vertex AI express mode API key

### 環境變數

在 repo 根目錄建立 `.env`（不會進 git）。網站、runtime 打包腳本與 `apps/web/scripts/*` 都從這個檔案讀。

| 變數 | 用途 |
|---|---|
| `SUPABASE_URL` | Supabase 專案網址 |
| `SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_…`，登入用 |
| `SUPABASE_SECRET_KEY` | `sb_secret_…`，伺服器端存取資料庫與 Storage |
| `FLY_SPRITES_TOKEN` | 建立、管理 Sprite |
| `VERTEX_API_EXPRESS_MODE_KEY` | Vertex AI express mode 金鑰，會帶進每台 Sprite |

### 啟動

```bash
pnpm install

# 連到雲端 Supabase 並套用 migration
supabase link --project-ref <project-ref>
pnpm db:push

# 打包 runtime 並上傳到 Storage（建立專案時 Sprite 會下載它）
pnpm -F @agenthub/runtime publish-runtime

pnpm -F @agenthub/web dev   # http://localhost:3000
```

本機網站一樣會建立真的 Sprite，並連到同一個雲端資料庫。

## 測試

```bash
pnpm test        # web 與 runtime 的單元測試（Vitest）
pnpm typecheck
pnpm db:test     # pgTAP，對雲端資料庫執行（需要 Docker）

# 冒煙測試：建立測試帳號 → 上架兩位顧問 → 建專案 → 討論 → 檢查總結 → 清理
cd apps/web
pnpm exec tsx scripts/smoke.ts                                            # 打本機
BASE_URL=https://agenthub-kappa-pink.vercel.app pnpm exec tsx scripts/smoke.ts  # 打 production
```

冒煙測試會建立並刪除一台真的 Sprite，全程約 3 分鐘。

## 部署

### 網站（Vercel）

Vercel 專案的 Root Directory 是 `apps/web`，區域 `sin1`，環境變數同上表。

push 到 `main` 會自動部署到 production。

### runtime（Sprite）

```bash
pnpm -F @agenthub/runtime publish-runtime              # 上傳 runtime/main.js 與 runtime/main-<commit>.js
cd apps/web && pnpm exec tsx scripts/redeploy-runtime.ts  # 更新所有已就緒專案的 Sprite 並重啟服務
```

新建立的專案會自動用最新的 `runtime/main.js`。

### 資料庫

新增 migration 放在 `supabase/migrations/`，用 `pnpm db:push` 套用。

## Demo 資料

```bash
cd apps/web
DEMO_PASSWORD=<密碼> pnpm exec tsx scripts/seed-demo.ts
```

會建立（或更新）兩個帳號、上架 `apps/web/demo/agents/` 的三位金融顧問，並建好「金融科技展 Demo」專案。可以重複執行。

| 帳號 | 角色 |
|---|---|
| `creator@demo.agenthub.app` | 創作者，擁有三位顧問 |
| `demo@demo.agenthub.app` | 使用者，擁有 Demo 專案 |

沒給 `DEMO_PASSWORD` 時會自動產生一組並印出來。已經存在的 Demo 專案不會被覆蓋；顧問內容改過後，要先在工作區刪除專案再重跑，才會套用新內容。

## 上架顧問的格式

**Skill zip**：每個 skill 一個資料夾，裡面放 `SKILL.md`，開頭用 YAML 寫 `name` 和 `description`。同一個 zip 可以放多個 skill，資料夾裡的其他檔案也會一起帶進 Sprite。

```
skills.zip
├─ credit-5p/
│  └─ SKILL.md
└─ ratio-check/
   ├─ SKILL.md
   └─ thresholds.csv
```

```markdown
---
name: credit-5p
description: 用 5P 架構評估中小企業授信案件
---

（skill 內容）
```

**MCP**：支援 `stdio`（`command` + `args`）和 `http`（`url` + `headers`）。需要金鑰時在 `required_secrets` 列出名稱，使用者啟用顧問時填寫；stdio 會當成環境變數傳入，http 可在 `headers` 裡用 `${KEY}` 引用。

範例見 `apps/web/demo/agents/*/`。

## 已知限制

- **安全性未處理**：agent 的 bash 讀得到 runtime 的金鑰，檔案工具不限工作目錄；沒有上架審核和限流。被 prompt injection 操縱時可能洩漏金鑰。
- **對話串流最長 300 秒**（Vercel Hobby 上限）：較長的多輪討論會在中途改成輪詢，完成後顯示完整結果。
- **Sprite 冷啟動**：休眠中的 Sprite 第一次回應會慢幾秒；新專案約 40 秒就緒。

## 文件

- [技術規格](docs/superpowers/specs/2026-10-02-agenthub-mvp-design.md)
- 實作計畫：[基礎與 runtime](docs/superpowers/plans/2026-10-02-agenthub-plan1-foundation-runtime.md)、[多顧問](docs/superpowers/plans/2026-10-02-agenthub-plan2-multi-agent.md)、[網站](docs/superpowers/plans/2026-10-02-agenthub-plan3-web.md)、[Demo 與端對端](docs/superpowers/plans/2026-10-02-agenthub-plan4-demo-e2e.md)
- [Production 驗證紀錄](docs/superpowers/reports/2026-10-02-production-e2e.md)
