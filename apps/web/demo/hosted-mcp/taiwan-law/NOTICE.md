# taiwan-law（平台代管）

法務與人資顧問共用的台灣法律查詢 MCP。由 AgentHub 平台代管，部署方式見 `apps/web/scripts/seed-business-agents.ts`。

## 程式來源

- `server.js`：npm 套件 [`taiwan-law-mcp@0.3.0`](https://www.npmjs.com/package/taiwan-law-mcp)（[legaltechtw/taiwan-law-mcp](https://github.com/legaltechtw/taiwan-law-mcp)），MIT 授權，全文見 `LICENSE`。
- AgentHub 對 `server.js` 的修改（其餘未動）：
  1. 立法歷程三個工具（`get_taiwan_law_progress`、`get_taiwan_law_versions`、`search_taiwan_bills`）原本查民間的 LYAPI（ly.govapi.tw），改成匯入 `ly.mjs`，直接查立法院開放資料服務平台；三個工具的說明同步改寫。
  2. 資料檔只讀本套件的 `data/legal-data/`，預設上游從 `https://legaltech.org.tw` 改成不存在的位址，執行時不會連到第三方。
  3. `/mcp` 先呼叫 `start.mjs` 提供的平台通行證驗證，平台以外的請求回 401。
- `start.mjs`、`auth.mjs`、`ly.mjs`：AgentHub 撰寫。

## 資料來源與更新方式

| 資料 | 來源 | 更新方式 |
|---|---|---|
| 法條、法規全文 | 法務部全國法規資料庫網頁（law.moj.gov.tw），每次查詢即時抓 | 不需更新 |
| 法務部函釋 | 法務部主管法規查詢系統（mojlaw.moj.gov.tw），即時查詢 | 不需更新 |
| 司法院裁判 | 司法院裁判書查詢（judgment.judicial.gov.tw），即時查詢 | 不需更新 |
| 議案、三讀紀錄 | 立法院開放資料服務平台資料集 20、373（data.ly.gov.tw），即時查詢、快取 6 小時 | 不需更新 |
| `data/legal-data/pcode_all.json`、`histories-*.json`（法規名稱對 pcode、廢止清單、修正沿革） | 法務部全國法規資料庫開放 API `https://law.moj.gov.tw/api/Ch/Law/JSON`、`/api/Ch/Order/JSON` | 平台維運者每月一次，或重大修法公布後：`cd apps/web && node scripts/taiwan-law-data.ts`（約 80 分鐘：憲法法庭網站每頁約 5 秒，依「下一筆」連結順序抓），commit 後跑 `seed-business-agents.ts` 部署新版本 |
| `data/legal-data/old_cases.json`、`new_cases.json`、`interp-index.json`（釋字、憲判字全文與索引） | 憲法法庭網站（cons.judicial.gov.tw） | 同上；有新的憲判字時再跑 |

**既有租用者的資料版本**：平台的代管 MCP 版本在租用時鎖定，重新產生資料並部署新版本後，只有之後新加入顧問的專案會用新版本；已租用的專案留在舊版本（舊版本有專案在用時不會被下架）。受影響的只有本機資料檔（法規名稱索引、修正沿革、釋憲全文）；法條、函釋、判決、議案都是即時查官方網站，不受影響。要讓既有專案用新版本，請租用者重新加入顧問。

法令、判決、解釋依《著作權法》第 9 條不受著作權保護；立法院開放資料依《政府資料開放授權條款》使用並標示出處。

意見書只收錄網站上的文件名稱，不含全文。
