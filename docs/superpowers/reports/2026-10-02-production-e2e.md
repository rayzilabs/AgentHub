# AgentHub MVP：Production 驗證紀錄

- 日期：2026-10-02
- Production：https://agenthub-kappa-pink.vercel.app
- 部署方式：Vercel CLI（團隊 rayzilabs-2056，Hobby），從不含 `.git` 的乾淨副本部署（見「已知限制」第 1 點）
- runtime 安裝檔：Storage `runtime/main.js`（commit `dd655ef`）

## 1. Production API 冒煙測試（`apps/web/scripts/smoke.ts`）

以 Bearer token 走完整條流程：建立帳號 → 上架兩位顧問（含 skill zip）→ 建立專案（自動建立 Fly Sprite 並部署 runtime）→ 啟用兩位顧問（自動出現主管）→ 開對話 → 送出需要討論的問題 → 等待完成 → 檢查總結 → 刪除專案與 Sprite。

| 次數 | 部署版本 | 環境就緒 | 串流大小 | 全程 | 結果 |
|---|---|---|---|---|---|
| 1 | `1941f1c` | 39 秒 | 252,919 字元 | 約 6 分鐘 | 通過，總結含「各面向建議／共識方案／仍有分歧」 |
| 2 | `dd655ef`（討論發言限字數） | 40 秒 | 109,682 字元 | 170 秒 | 通過 |

## 2. Production 瀏覽器檢查（公開頁面）

- 市集首頁、顧問介紹頁、登入頁：正常顯示，字體為霞鶩文楷 TC + Noto Sans TC。
- 390px 寬：三個頁面都沒有水平捲動（`scrollWidth === clientWidth === 390`）。
- `GET /api/templates` 不再回傳 `system_prompt`、skill 檔路徑與 MCP 連線設定。

依安全規則，自動化工具不在 production 網址建立帳號或輸入密碼；需要登入的畫面改在本機（`next dev` / `next start`，連同一個雲端 Supabase 與真的 Sprite）用瀏覽器驗證，見第 3 節。

## 3. 本機瀏覽器端對端（連雲端資料庫與真實 Sprite）

使用 Demo 帳號 `demo@demo.agenthub.app` 與「金融科技展 Demo」專案（3 位金融顧問 + 主管）。

| 項目 | 結果 |
|---|---|
| 登入、導向 `/projects` | 正常（`requestSubmit` 一次送出即 POST 200 → 導向）。自動化工具點擊時曾被 Chrome 自動填入下拉選單攔截，非產品問題 |
| 工作區：顧問名冊、識別色、主管說明 | 正常 |
| 三位顧問討論（舊版、未限字數） | 3 輪 9 段發言，621 秒完成；即時串流顯示每位顧問發言、用過的工具、立場印章；重新整理後歷史完整 |
| 發言收合 | 長發言預設收合，「展開全文」只在內容超出時出現 |
| 上傳專案檔案 | 瀏覽器直接 PUT 到 Storage 簽名網址 200（無 CORS 問題），檔案列表即時出現 |
| 派工 + 讀取檔案 + 記憶 | 59 秒完成：主管讀取上傳的公司資料、記下「使用者偏好保守的估計」（記憶面板顯示）、派工給授信審查顧問（卡片顯示交辦內容、用過的工具、完成狀態），最後整合回覆 |

## 4. Demo 資料

- 創作者帳號：`creator@demo.agenthub.app`；使用者帳號：`demo@demo.agenthub.app`（兩者同一組密碼，存在本機 `.superpowers/demo-password`，未進 repo）。
- 已上架：授信審查顧問、金融法遵顧問、財務分析顧問（介紹註明「示範內容，正式版本將由執業專業人士提供」）。
- 「金融科技展 Demo」專案：3 位顧問 + 主管，Sprite `agenthub-77ce81ec-…` 保持運作，內含兩串已完成的示範對話。
- 重建 Demo 資料：`cd apps/web && DEMO_PASSWORD=... node --env-file=../../.env --import tsx scripts/seed-demo.ts`（可重複執行）。

## 5. 已知限制與注意事項

1. **git push 不會自動部署。** Vercel Hobby 團隊會擋下 commit 作者（erichung9060）不是團隊成員的部署；CLI 從 repo 目錄部署也會帶上 git 作者而被擋。目前做法：把 repo 複製到不含 `.git`、`.env` 的目錄後執行 `vercel deploy --prod`（根目錄 `.vercelignore` 另外排除機密）。長期解法：把 GitHub 帳號加入 Vercel 團隊（需 Pro）或改由團隊擁有者帳號 commit。
2. **對話串流最長 300 秒（Hobby 上限）。** 三位顧問討論在 production 會超過時，前端自動改為輪詢，完成後顯示完整回覆。
3. **Demo 專案的顧問是舊內容快照。** 範本已更新為修正後的法規用字（實質受益人「超過 25%」、疑似洗錢交易申報、個資法第 12/20 條等），但專案裡的顧問是啟用當下的快照；要套用新內容，請在工作區「刪除專案」後重跑 seed。
4. **安全性刻意不處理**（規格 §10）：agent 的 bash 讀得到 runtime 的金鑰、檔案工具不限工作目錄、沒有上架審核與限流。不可在此狀態下放真實客戶的機密資料。
5. **runtime 更新流程：** `pnpm -F @agenthub/runtime publish-runtime` → `cd apps/web && node --env-file=../../.env --import tsx scripts/redeploy-runtime.ts`（會更新所有 ready 專案的 Sprite）。
