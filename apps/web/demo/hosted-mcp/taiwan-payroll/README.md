# taiwan-payroll（平台代管）

台灣勞保（含就保）、健保、勞退、職災、二代健保補充保費、薪資扣繳、破月與勞保老年給付試算。人資顧問用它算薪資相關數字，不心算。

## 出處

- 上游：[supra126/taiwan-payroll](https://github.com/supra126/taiwan-payroll)，commit `81bf20d`（2026-09-09），MIT 授權，全文見 `LICENSE`。
- 原樣搬入：`packages/core/src/`（計算核心）、`packages/mcp/src/tools.ts`、`packages/mcp/src/create-server.ts`、`data/`（2024–2026 年度參數與 schema）、`testdata/`（官方範例向量，只留 JSON）。
- 我們改的地方：
  - `tools.ts` 第 2 行的 import 從 npm 套件 `taiwan-payroll` 改成相對路徑 `../../core/src/index`。
  - 新增 `server.mjs`，負責平台通行證驗證與 HTTP，照 `docs/creator/examples/hosted-node`。
  - 拿掉 Cloudflare Workers 的入口（`worker.ts`）和 stdio 入口。
- 啟動方式：`node --import tsx server.mjs`，直接執行 TypeScript 原始碼，不用建置。

## 年度資料更新（每年一次）

勞動部勞保局與衛福部健保署通常在 **11–12 月** 公告下一年 1 月 1 日起適用的分級表（配合最低工資調整）。只能用主管機關的官方公告，不能從前一年推算，也不能用民間轉錄網站。

1. 取得官方資料（每個數字都要記下文號或網址，填進 `sources`）：

   | 項目 | 官方來源 |
   |---|---|
   | 勞工保險投保薪資分級表 | 勞保局 https://www.bli.gov.tw/0005475.html（附件 PDF） |
   | 勞工退休金月提繳分級表 | 勞保局 https://www.bli.gov.tw/0013083.html |
   | 職業災害保險投保薪資分級表、平均費率 | 勞保局災保專區、勞動部年度公告 |
   | 全民健康保險投保金額分級表、保險費負擔金額表 | 健保署 https://www.nhi.gov.tw/ch/cp-19421-f9533-2569-1.html（網站會擋程式抓取，用瀏覽器下載官方 PDF 或 ODS） |
   | 二代健保補充保費費率 | 健保署 https://www.nhi.gov.tw/ch/cp-4516-74b0f-2613-1.html |
   | 薪資所得扣繳稅額表 | 財政部 |

2. 照 `data/2026.json` 的結構和 `data/schema.json` 新增 `data/<西元年>.json`：級距用分級表的投保金額陣列產生（`min` 是前一級加 1、最高級 `max` 是 `null`）；費率寫成字串、金額寫成整數；`dataVersion` 寫 `<年>.1.0`。
3. 在 `packages/core/src/data.ts` 的 `registry` 加上新年度。
4. 用官方的「保險費負擔金額表」在 `testdata/official-cases/` 加上新年度的向量：勞保最低級與最高級、健保第 1 級本人、本人加 1 眷、最高級，勞退、職災各一筆，每筆都附 `source`。
5. 在 repo 根目錄跑 `pnpm -F @agenthub/web test test/hosted-mcp-hr.test.ts`，向量要全過；再更新測試裡 `getAvailableYears()` 的預期年度。
6. 重新上架：`seed-business-agents.ts` 發現套件內容變了，會建立新版本並發布。既有專案還是用舊版本，要重新加入顧問才會拿到新年度的資料。

上游也可能先更新。可以比對上游的 `data/` 和 `testdata/` 再合併，但要逐筆對照上面的官方來源。
