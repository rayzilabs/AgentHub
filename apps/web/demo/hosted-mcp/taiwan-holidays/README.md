# taiwan-holidays（平台代管）

依政府行政機關辦公日曆計算工作日、補班與請假規劃。人資顧問用它算以「工作日」計的期限（例如職場霸凌申訴的 10 個工作日）、查某段期間有幾個工作日或哪天補班。預告期間、資遣費 30 日內給付這類期限是曆日，不用這個工具。

這是**行政機關**的辦公日曆：國定假日本身和民間相同，但國定假日遇例假或休息日時的補假、調整放假與補行上班只適用公務機關，民間的補假日期由勞雇協商（勞基法施行細則第 23-1 條）。

## 出處

- 計算核心：[imsyuan/taiwan-holidays](https://github.com/imsyuan/taiwan-holidays) 的 `mcp/src/engine/index.ts`、`types.ts`，commit `bd5551c`（2026-11-03），MIT 授權，全文見 `LICENSE`。原樣搬入，沒有修改。
- `src/create-server.ts` 改寫自上游的 `mcp/src/index.ts`：
  - 拿掉 Cloudflare 專用的 `McpAgent` 外殼，改用官方 MCP SDK。
  - 拿掉和人資無關的 `find_travel_windows`、`build_travel_links`。
  - 保留 4 個工具（`count_workdays`、`add_workdays`、`next_makeup_workday`、`optimize_leave`），名稱、說明、參數、回傳格式都和上游相同。
- `server.mjs` 負責平台通行證驗證與 HTTP，照 `docs/creator/examples/hosted-node`。
- 行事曆資料 `data/<西元年>.json` **不是從上游複製的**，而是用 `scripts/update-calendar.mjs` 直接從官方來源產生：政府資料開放平台「中華民國政府行政機關辦公日曆表」（[資料集 14718](https://data.gov.tw/dataset/14718)，行政院人事行政總處提供），依[政府資料開放授權條款](https://data.gov.tw/license)使用。產生結果已和上游資料逐日比對，2017–2027 年沒有差異。

## 行事曆更新（每年一次，年中）

人事行政總處約在每年 **6–7 月** 公布下一年的辦公日曆，年底前也可能修正（例如 114 年 10 月 20 日的更新版）。

1. 在這個目錄跑 `node scripts/update-calendar.mjs`。它會讀資料集 API，每個年度只取最新一份 CSV（不要 Google 行事曆專用版），並檢查天數。
2. 看 `git diff data/`，確認新年度的國定假日、補假、補班和官方公告一致。
3. 在 repo 根目錄跑 `pnpm -F @agenthub/web test test/hosted-mcp-hr.test.ts`；有新年度時，更新測試裡的預期年度清單。
4. 重新上架：套件內容變了就會建立新版本並發布。既有專案要重新加入顧問才會拿到新年度的資料。
