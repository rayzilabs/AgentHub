# 人資顧問：調查報告（KAN-15 階段一）

> 調查日：2026-11-12。星數、最後更新日、授權都是當天用 `gh api repos/<repo>` 查的；MCP 是當天實測的結果。

## 結論

- **骨架**用 `anthropics/claude-for-legal/employment-legal`（Apache-2.0）的流程：先問事實、掃高風險、查管轄規定、輸出清單和建議做或不做。這些 skill 有 200–400 行，有深度，但內容全是美國法，**法律內容要整份換掉，只留流程**。
- **台灣實務內容**主要來自兩個 MIT 專案：
  - `hikari5014/Labor-Pixie`：41 則勞資案例、公司體檢清單、表單範本，規則表每筆都有生效日、出處網址與查證日。
  - `law24tw/tw-legal-calc`：資遣費與特休試算的 Python，每條公式都附條號。
- **MCP 三個都可用**：taiwan-payroll、taiwan-holidays、taiwan-law-mcp。都免金鑰，也都接受平台多帶的 `Authorization` 標頭。依使用者的資料來源原則，**最後三個都改由平台代管**（原始碼都是 MIT），見「三、推薦清單」。
- **時效風險**：116 年（2027）1 月 1 日起最低工資調為月薪 30,900 元、時薪 205 元（勞動部 115/10/16 勞動條 2 字第 1150148692 號公告），但 116 年的勞健保分級表還沒公告，taiwan-payroll 也只有 2024–2026 年的資料。上架後七週就會碰到跨年，skill 和 system prompt 要寫清楚怎麼處理。

## 一、候選比較

### Skill／agent 來源

| 來源 | ★ | 最後更新 | 授權 | 內容深度 | 台灣適用性 | 怎麼用 |
|---|---|---|---|---|---|---|
| [anthropics/claude-for-legal](https://github.com/anthropics/claude-for-legal) `employment-legal/` | 9,986 | 2026-11-08 | Apache-2.0 | 深：termination-review 283 行、worker-classification 399 行、wage-hour-qa 214 行、hiring-review 213 行、internal-investigation 765 行、cold-start-interview 324 行 | 低：全是美國法（at-will、FLSA、state law、exempt） | 留流程骨架（事實→高風險旗標→管轄規定→文件→建議做或不做→清單）和「做重大決定前的關卡」；法律內容全部換成台灣法 |
| [anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins) `human-resources/` | 35,525 | 2026-11-12 | Apache-2.0 | 淺：28–149 行 | 中：流程通用，但薪酬講 equity / RSU、假別講 PTO | draft-offer、interview-prep、onboarding、performance-review 當結構參考；comp-analysis、org-planning、people-report、recruiting-pipeline 需要 HRIS 或是大公司情境，不用 |
| 同上 `small-business/`：hiring-screener、job-post-builder、payroll-prep、plan-payroll | 同上 | 同上 | Apache-2.0 | 中：88–204 行 | 中：小企業語氣對，但是美國薪資流程 | 參考職缺文案和小老闆的口吻；薪資步驟改成台灣的勞健保勞退與扣繳 |
| [hikari5014/Labor-Pixie](https://github.com/hikari5014/Labor-Pixie)（網站 [labor-pixie.vercel.app](https://labor-pixie.vercel.app)） | 0 | 2026-11-12 | MIT | 深：13 部法規全文、24 張爭議主題卡、41 則案例、公司體檢清單、契約條款檢查、5 份表單範本、19 張規則表，附 Python 和 JS 測試 | **高**：台灣勞動法，雇主和勞工兩邊的觀點都有，判決說已核對過原文 | 規則表、案例、體檢清單、表單改寫進 `references/`。風險是作者只有一人、10 月才建立，引用前要用 law MCP 抽查條號 |
| [law24tw/tw-legal-calc](https://github.com/law24tw/tw-legal-calc) `calc/labor.py`、`calc/dates.py` | 0 | 2026-10-04 | MIT | 中：資遣費（舊制、新制、跨制併計、平均工資兩種算法）、特休（週年制，離職未休全額計給） | **高**：每條公式附條號；9 月自己更正過一次捏造的法源，態度嚴謹 | 只用標準函式庫，可以直接放進 skill 的 `scripts/`。`annual_leave` 會把到職以來每期都加總，要改成只算未結清的期間 |
| [mohitagw15856/pm-claude-skills](https://github.com/mohitagw15856/pm-claude-skills) `skills/tw-labour-standards/` | 1,541 | 2026-11-11 | MIT | 淺：4.7 KB，附 `tw_severance.py` | 中：站勞工立場 | 只參考「向雇主提出的要求」和「申訴管道（地方勞工局、1955）」這兩段；試算改用 tw-legal-calc |
| [tahodev/baodao-skill](https://github.com/tahodev/baodao-skill) `taiwan-labor-health-insurance/` | 2 | 2026-11-11 | MIT | 淺：7 KB | 高，但跟 taiwan-payroll MCP 重疊 | 只參考它列的官方公告網址，用來核對 MCP 的費率 |
| [asgard-ai-platform/skills](https://github.com/asgard-ai-platform/skills) `law-labor/` | 245 | 2026-06-06 | MIT | 淺：5.6 KB 英文概論 | 中 | 不用，內容已被上面幾個來源涵蓋 |
| [msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents) `specialized/recruitment-specialist.md`、`hr-onboarding.md` | 167,852 | 2026-11-09 | MIT | 中：30 KB、24 KB | 低：美國流程 | system prompt 的角色寫法參考 |
| [wshobson/agents](https://github.com/wshobson/agents) `plugins/hr-legal-compliance/`：`agents/hr-pro.md`、`skills/employment-contract-templates/` | 42,433 | 2026-11-09 | MIT | 中 | 低 | hr-pro 參考 system prompt 的原則段；契約範本只參考條款清單，台灣版以勞動部範本為準 |
| [alirezarezvani/claude-skills](https://github.com/alirezarezvani/claude-skills) `c-level-advisor/skills/chro-advisor` | 29,685 | 2026-11-12 | MIT | 中 | 低：大公司 CHRO 視角 | 不用，對象不符 |
| [sara-hamza/people-ops-claude](https://github.com/sara-hamza/people-ops-claude) | 0 | 2026-10-20 | MIT | 中：25 個 skill，每個 6–9 KB，附 guardrails | 中：寫法不分國家，每個義務都標 [Verify] | `performance-support-plan` 當績效改善計畫的結構參考，其餘不用 |

### MCP（實測）

實測方法：送 `initialize`、`tools/list`，再實際呼叫工具；每個都另外加上 `Authorization: Bearer …` 標頭再測一次。

| MCP | ★／授權 | 網址 | 實測結果 | 帶 Authorization | 建議 |
|---|---|---|---|---|---|
| [supra126/taiwan-payroll](https://github.com/supra126/taiwan-payroll) | 2／MIT | `https://taiwan-payroll.simoko.workers.dev/mcp` | v1.4.1，9 個工具。`calculate_payroll`（2026 年、月薪 36,000、1 位眷屬）：級距 36,300；員工自付勞保 908、健保 1,126；雇主勞保 3,176、健保 1,757、勞退 2,178、職災 76。**我手算核對過全部正確**（勞保 12.5%×20%；健保 5.17%×30%×2 口；雇主健保乘 1.56 平均眷口）。`list_years` 只有 2024–2026 | 正常 | **採用**，`remote` |
| [imsyuan/taiwan-holidays](https://github.com/imsyuan/taiwan-holidays) | 18／MIT | `https://mcp.tw-holidays.gooliya.com/mcp` | 6 個工具。`count_workdays` 2027-01-01～02-28 → 35 個工作日、24 天假日；`add_workdays` 2026-12-28 加 10 個工作日 → 2027-01-12 | 正常 | **採用**，`remote`；用來算預告期滿日、資遣費 30 日內給付期限、特休到期日 |
| [legaltechtw/taiwan-law-mcp](https://github.com/legaltechtw/taiwan-law-mcp) | 3／MIT | `https://legaltech.org.tw/mcp` | v0.3.0，14 個工具。查勞基法 §38、就服法 §5、勞基法 §9-1 都回傳現行全文和官方網址；`search_taiwan_judgments`「試用期 不能勝任 資遣」→ 最高法院 115 台上 1146、高等法院 115 勞上 126（115/11/03）等最新判決 | 正常 | **採用**，`remote`；和法務顧問共用 |
| [lis186/taiwan-holiday-mcp](https://github.com/lis186/taiwan-holiday-mcp) | 28／MIT | 只有 npx（stdio） | 沒有遠端版 | — | 備案；遠端版已經夠用 |
| tw-legal-calc 的 `mcp_server.py` | 0／MIT | 只有本機版（要 FastAPI） | — | — | 不當 MCP 用，改把 `labor.py` 放進 skill 的 `scripts/` |

### 官方網站（`references/` 的出處）

法令與公文依著作權法第 9 條不受著作權保護；政府網站的其他內容依《政府資料開放授權條款》使用，要註明出處。

| 主題 | 出處 | 重點 |
|---|---|---|
| 116 年最低工資 | 勞動部[新聞稿](https://www.mol.gov.tw/1607/1632/1633/99195/)；[行政院新聞稿](https://www.mol.gov.tw/1607/1632/2665/99661/post)；公告文號 勞動條 2 字第 1150148692 號（115/10/16） | 116/1/1 起月薪 30,900 元、時薪 205 元；115 年是 29,500 元、196 元 |
| 115 年勞保、健保、勞退分級表 | [勞保局分級表](https://www.bli.gov.tw/0005475.html)、[勞動部說明](https://www.mol.gov.tw/1607/1632/1633/86680/) | 勞保第一級 29,500、最高 45,800；健保最高 313,000；勞退最高 150,000。116 年版還沒公告 |
| 承攬或僱傭 | 勞動部[勞動契約認定指導原則](https://www.mol.gov.tw/1607/1632/1640/12431/)（108/11/19）＋從屬性判斷檢核表 | 人格從屬性 8 項、經濟從屬性 5 項、組織從屬性；看實質不看契約名稱 |
| 工作規則 | 勞動部工作規則參考手冊（111 年 6 月修正版）、部分工時勞動契約參考範本 | 30 人以上要訂工作規則並報主管機關核備（勞基法 §70） |
| 試用期 | 勞動部[試用期說明](https://www.mol.gov.tw/1607/28162/28296/81778/81781/82213/) | 試用不通過仍要符合 §11 事由，並給預告、資遣費和謀職假；法院多數見解認為試用期是「附保留終止權」，比較寬鬆。兩種見解都要列出來 |
| 官方試算 | 勞動部試算系統 [calcr2.mol.gov.tw](https://calcr2.mol.gov.tw/)（實測可連）、[資遣費給付標準](https://www.mol.gov.tw/1607/28162/28296/81778/81793/81935/) | 加班費、特休（週年制、曆年制）、資遣費；顧問回答時可附上這個網址讓使用者自己核對 |
| 育嬰與家庭照顧 | 勞動部[新聞稿](https://www.mol.gov.tw/1607/1632/1633/83137/) | 115/1/1 起：育嬰留停有 30 天可以「日」申請；家庭照顧假一年 56 小時、可按小時請 |
| 職場性騷擾 | 性別平等工作法（113/3/8 施行） | 10–29 人：設申訴管道並公開揭示；30 人以上：訂防治措施、申訴及懲戒規範，並辦教育訓練 |
| 職場霸凌 | 職業安全衛生法霸凌防治專章（114/12/19 公布，115/7/1 施行）；勞動部《執行職務遭受不法侵害預防指引》第五版（115/7） | 依規模訂申訴管道；初報、結案、申復三項要上勞動部系統登錄；罰 3 萬–75 萬。《職場霸凌防治準則》定稿狀態還沒查到，寫內容時要再查 |
| 常見違規 | 勞動部與縣市勞動局的勞檢統計 | 休息日加班費、國定假日加倍、連續出勤超過 6 日、沒有出勤紀錄（§30 要記到分鐘、保存 5 年）最常見 |

## 二、排除名單

| 來源 | 原因 |
|---|---|
| g0v/labor-standards-tw（最後 push 2018-01）、g0v/workweek（2016-08） | 法規已經改過好幾次（2018 年修法、最低工資法），資料過時 |
| 104 人力銀行相關 MCP | 非官方爬蟲，有服務條款風險（單裡已排除） |
| kensairay/SKILL_taiwan-labor-law-expert、jsphh7124/taiwan-labor-law、calebcaleb13241-cell/labor-tools、wonbadon/taiwan-labor-calculator、xax89/taiwan-tax-guide、EagleChu-hub/labor-law-helper、ccwu0918/twinkle-hub-skills、kevintsai1202/law-powers | 沒有授權檔 |
| licy0916/fnb-claude-skills | 授權是 NOASSERTION，沒有可辨識的授權 |
| com.onrender.x402-tw-data/taiwan-open-data | 要付費（x402 USDC） |
| eu.ansvar/taiwanese-law-mcp | 沒有遠端網址，功能和 taiwan-law-mcp 重疊 |
| ThomasMoreAI/legal-skills-open | 是轉載合集，內容是美國法，子項目的授權要回去看原始來源；要用就直接用原始來源 |
| employment-legal 的 international-expansion、expansion-*、matter-workspace、customize、investigation-* 子指令、log-leave | 跨國擴張、律所案件工作區、斜線指令，對台灣中小企業沒有用；有價值的內容併進下面推薦的 skill |
| knowledge-work-plugins/human-resources 的 comp-analysis、org-planning、people-report、recruiting-pipeline、policy-lookup | 偏大公司或需要 HRIS 連接器；薪酬內容以 equity / RSU 為主 |
| alirezarezvani chro-advisor | 大公司 CHRO 視角，跟目標使用者不符 |

## 三、推薦清單

**共通做法**：每個 skill 開頭先 `memory_read` 專案記憶 `hr-playbook`；沒有的話先問 2–3 個關鍵問題，或明講「以下用法定最低標準」。法條一律用 taiwan-law-mcp 核對條號，金額一律用 MCP 或 `scripts/` 計算，不心算。

### Skill（建議 9 個，其中 2 個可選）

| # | skill | 什麼情況用 | 合併哪些來源 | 台灣化要做什麼 |
|---|---|---|---|---|
| 1 | `hr-setup` 公司設定訪談 | 第一次使用，或公司人數、制度有變 | employment-legal `cold-start-interview` 和 `CLAUDE.md` 的 practice profile | 改問會影響法定義務的事：人數（10／30 人門檻決定性騷擾、工作規則的義務）、行業（是否適用 §84-1、變形工時）、特休用週年制或曆年制、薪資結構（哪些算經常性薪資）、試用期政策、加班是申請制或認定制、有沒有勞資會議。問完寫進 project 記憶 `hr-playbook` |
| 2 | `hiring` 招募到錄取 | 寫職缺、準備面試題目、發錄取通知 | HR `interview-prep`、`draft-offer`；small-business `job-post-builder`、`hiring-screener`；employment-legal `hiring-review` 的流程；agency-agents recruitment-specialist | 就服法 §5：禁止 18 種歧視；月薪未達 4 萬元要公開薪資範圍；不能要求非就業所需的隱私資料。面試不能問婚姻、懷孕、星座血型。錄取通知列出工資、工時、試用期、到職日，並附個資法告知。刊登平台用 104、1111、Yourator、LINE |
| 3 | `onboarding-contract` 到職、勞動契約與試用 | 簽勞動契約、設計試用期、到職手續、競業禁止或最低服務年限條款 | wshobson `employment-contract-templates` 的條款清單；HR `onboarding`；agency-agents hr-onboarding；Labor-Pixie `checklists/contract-terms.json`、`forms/probation-review.json`、`cases/probation.json`、`cases/contract.json` | 不定期與定期契約（§9）；試用期兩種見解都列；§9-1 競業禁止四要件、最長 2 年、合理補償；§15-1 最低服務年限；到職當日加保勞健保、提繳勞退；員工資料卡（§7）。以勞動部工作規則參考手冊和部分工時契約範本為底 |
| 4 | `payroll-insurance` 薪資與勞健保勞退 | 算每月薪資、勞健保自付與公司負擔、勞退 6%、扣繳稅額、二代健保補充保費、到職或離職當月破月 | small-business `payroll-prep`、`plan-payroll`；taiwan-payroll MCP；tahodev 列的官方公告網址 | **一律呼叫 taiwan-payroll**；工資清冊（§23）、薪資明細要列的項目；最低工資附生效日。**跨年規則**：MCP 沒有該年度資料時（例如 116 年），要說明 116/1/1 起最低工資 30,900，第一級級距會跟著調、正式分級表以勞保局公告為準，並列出用 115 年資料估算的數字 |
| 5 | `working-hours` 工時、加班與例休假 | 排班、加班費怎麼算、休息日或國定假日出勤、變形工時、出勤紀錄 | employment-legal `wage-hour-qa` 的流程；Labor-Pixie `rules/overtime-rates.json`、`overtime-limits.json`、`wage-basis.json`、`cases/overtime.json`、`cases/hours.json`；taiwan-holidays MCP | §24（平日前 2 小時 1⅓、再 2 小時 1⅔；休息日）、§30（出勤紀錄到分鐘、保存 5 年）、§32（一日 12 小時、每月 46 小時，經勞資會議同意可到 54 小時、三個月 138 小時）、§36、§37、§39；2 週、4 週、8 週變形工時；先列出勞檢最常見的違規 |
| 6 | `leave` 特休與請假 | 特休天數、未休折現、病假事假婚喪、產假與陪產檢、育嬰留停、家庭照顧假 | employment-legal `leave-tracker` agent 的追蹤結構；tw-legal-calc `annual_leave`（放進 `scripts/`）；Labor-Pixie `rules/annual-leave.json`、`sick-leave-rules.json`、`marriage-leave.json` | §38、勞工請假規則、性平法（產假 8 週、產檢假 7 日、陪產檢及陪產假 7 日）；115/1/1 新制（育嬰以日申請、家庭照顧假以小時請）；週年制與曆年制換算。修正腳本只算未結清的期間 |
| 7 | `termination` 資遣、解僱與離職 | 想資遣或解僱員工、員工自請離職、試用不通過、算資遣費與預告期 | employment-legal `termination-review`（高風險旗標→文件→建議做或不做→離職日清單）；tw-legal-calc `severance`（放進 `scripts/`）；Labor-Pixie `rules/separation-obligations.json`、`notice-period.json`、`cases/separation.json` | §11（資遣事由，加上最後手段性原則）、§12（懲戒解僱，30 日除斥期間）、§14、§15、§16（預告 10／20／30 日、謀職假）、§17 與勞退條例 §12（新制每年 ½ 個月、最高 6 個月）；就服法 §33（10 日前資遣通報）；§19 非自願離職證明；資遣費 30 日內給付（勞退條例 §45-1 罰 30–150 萬）。**高風險旗標**：懷孕、育嬰中、職災醫療期間（§13）、剛提申訴、勞資爭議中（勞資爭議處理法 §8） |
| 8 | `worker-classification` 承攬、委任或僱傭 | 外包、接案、外送、講師、業務員要簽承攬或勞動契約 | employment-legal `worker-classification`（只做事前判斷的關卡、5 步驟流程） | 改用勞動部勞動契約認定指導原則的人格、經濟、組織從屬性和 25 項檢核表；參考司法院釋字第 740 號；用 law MCP 查近期判決 |
| 9 | `performance` 績效考核與改善計畫（可選） | 年度考核、試用期考核、員工表現不佳要做改善計畫 | HR `performance-review`；sara-hamza `performance-support-plan` 的結構 | 和 `termination` 連動：§11 第 5 款「不能勝任」要有具體考核紀錄、給過改善機會（最後手段性）；考核不能成為就服法 §5 的歧視 |
| 10 | `harassment-bullying` 性騷擾與職場霸凌申訴（可選） | 訂申訴管道與防治規範、收到申訴要怎麼調查處理 | employment-legal `internal-investigation`（765 行調查流程）、`policy-drafting` | 性平法 113 年新制（依人數分級的義務）、職安法霸凌專章（115/7/1 起，申訴、調查、三項登錄）；調查的保密與迴避 |

**取捨建議**：
- 第 9、10 個可選。不做的話，績效的部分併進 `termination` 的「不能勝任」段落；申訴只在 `hr-setup` 提醒法定義務，詳細處理請使用者找律師或勞工局。
- 我傾向**做第 10 個**：10 人以上就有法定義務，115/7/1 的霸凌新制也才剛上路，小老闆最容易不知道。

### MCP（使用者已決定）

三個 MCP 的提供者都是個人或民間單位：taiwan-payroll 是個人帳號 `supra126`，taiwan-holidays 是個人帳號 `imsyuan`（gooliya.com），taiwan-law 是 2026-08 才建立的組織 `legaltechtw`。使用者決定薪資和行事曆改由平台代管，免得依賴第三方伺服器，薪資數字也不會送出平台。

| name | 做法 | 說明 |
|---|---|---|
| `taiwan-payroll` | `{ transport: 'remote', hosted: true }` | 從 `packages/mcp`（MIT）改用平台 Node 範本：沿用它的 `handleMcpRequest`（Web 標準、無狀態），外面包 `0.0.0.0:8080/mcp` 和平台通行證驗證 |
| `taiwan-holidays` | `{ transport: 'remote', hosted: true }` | 計算核心 `mcp/src/engine`（MIT）原樣使用；Cloudflare 專用的 `McpAgent` 外殼改寫成 Node 版（官方 SDK + streamable HTTP）。行事曆資料（`data/<年>.json`，政府資料開放授權）在建置時打包 |
| `taiwan-law` | `{ transport: 'remote', hosted: true }`，用 KAN-14 做好的代管套件 | 更正：GitHub repo 沒有原始碼，但 npm 套件 `taiwan-law-mcp@0.3.0`（MIT）的 `server.js` 是完整程式。KAN-14 把它改成我們代管，索引改從法務部官方 API 產生，不再連 legaltech.org.tw；人資用同一份套件另外部署一台（代管 MCP 綁在範本上） |

**代管之後要承擔的維護**：
- 勞健保費率每年 1 月要更新，下一年的行事曆約 6 月公布後要更新，每次都要發布新版本。
- 既有專案留在租用當時的版本，所以 skill 要檢查 MCP 回傳的資料年度。不是當年時，要提醒使用者「重新加入顧問才會拿到新年度的數字」。
- 每個版本佔 Demo 創作者帳號一台代管機器，上限 10 台，和法務、行銷顧問共用。
- 116 年分級表公告後（預計 115 年 11–12 月），要先更新 taiwan-payroll 的資料再發布；在那之前用 115 年的資料，並說明 116/1/1 起最低工資是 30,900 元。

### 資料來源與更新方式

使用者定的原則：每個資料來源都要符合下面其中一項。**(a)** 我們自己能更新：資料放在我們的 repo 或我們代管的 MCP 裡，並寫明怎麼更新。**(b)** 直接來自權威機構：政府機關的官方 API 或官方網站。不能依賴第三方個人架的伺服器。

| 資料 | 放在哪 | 符合 | 誰更新、多久一次、從哪取得 |
|---|---|---|---|
| 勞保、就保、職災、健保、勞退級距與費率、扣繳稅額表 | 代管的 `taiwan-payroll`（參數在程式碼裡） | (a) | 我們更新。每年 1 月前，勞保局、健保署公告新分級表後（[勞保局分級表](https://www.bli.gov.tw/0005475.html)、[健保署投保金額分級表](https://www.nhi.gov.tw/ch/cp-19422-c534e-2569-1.html)、財政部薪資所得扣繳稅額表），改參數、跑上游的官方範例測試、發布新版本。也可以先看上游有沒有更新再合併 |
| 政府行政機關辦公日曆（國定假日、補班） | 代管的 `taiwan-holidays`（`data/<年>.json` 建置時打包） | (a) | 我們更新。每年人事行政總處公布下一年辦公日曆後（約 6 月），從[政府資料開放平台資料集 14718](https://data.gov.tw/dataset/14718) 抓 CSV 轉成 JSON，重新部署並發布 |
| 勞動法規條文（勞基法、施行細則、勞工請假規則、性平法、就服法、勞退條例、勞保條例、職安法、最低工資法、勞資爭議處理法、大量解僱勞工保護法等） | 代管的 `taiwan-law`（KAN-14 製作），索引從法務部 API 產生 | (a)＋(b) | 由 KAN-14 的套件負責；法律與命令（施行細則、勞工請假規則）都查得到。更新方式依 KAN-14 的設計 |
| 法院判決 | 代管的 `taiwan-law` 直接查[司法院裁判書系統](https://judgment.judicial.gov.tw/FJUD/default.aspx)官網 | (b) | 即時查詢，不存副本。**風險**：司法院可能擋海外 IP，KAN-14 部署後會實測；被擋的話改用下方的 J1。不論有沒有被擋，skill 都會引用精選的重要判決（附字號與官方網址） |
| 規則表、案例、體檢清單、表單（改寫自 Labor-Pixie，MIT） | skill 的 `references/`（我們的 repo） | (a) | 我們更新。每筆都保留 `source_url` 和「資料截至」日期：最低工資、勞健保每年 1 月更新；法規修正時跟著改。上線前逐筆對照官方網址核對 |
| 資遣費、特休試算程式（改寫自 tw-legal-calc，MIT） | skill 的 `scripts/`（我們的 repo） | (a) | 我們更新。公式來自勞基法 §17、§38，勞退條例 §12，施行細則 §24、§24-1，法規修正時跟著改 |
| 勞動部說明頁、試算系統、範本（試用期、承攬與僱傭指導原則、工作規則參考手冊、[calcr2.mol.gov.tw](https://calcr2.mol.gov.tw/)） | skill 裡寫重點並附官方網址 | (b) | 直接連官方網站；重點摘要每年核對一次 |

**法規條文的決定**（主工作區判斷）：不另外打包，也不由 KAN-15 另寫 MCP，共用 KAN-14 的代管 `taiwan-law`。法務部 API 只能整包下載（實測法律 6.1 MB／3 秒、命令 25.8 MB／7 秒，資料日期 2026/10/30）。

**代管名額**：人資 3 台（payroll、holidays、taiwan-law）、法務 1 台、行銷 1 台，平常合計 5 台，上限 10 台。更新時要把舊版本下架。

**法院判決的備案：司法院開放資料 API 的限制**（暫不申請帳號）（[裁判書開放 API 規格說明 114.08.22](https://opendata.judicial.gov.tw/api/Newses/42/file)）：

- 只有三支 API：`Auth`（帳號密碼換 token，有效 6 小時）、`JList`（只回傳「7 日前那一天」異動的判決 ID 清單）、`JDoc`（用判決 ID 取單筆全文）。**沒有關鍵字搜尋**。
- 服務時間只有**每日 0–6 時**。
- 判決被撤下後，使用者必須刪除先前取得的副本。
- 所以要做到「用關鍵字找判決」，得自己每天凌晨同步、累積全部判決、建搜尋索引、處理撤下。平台代管機器閒置會休眠、不能依賴排程（`docs/creator/hosted-mcp.md` 第 5 節），做不到。

如果代管的 `taiwan-law` 被司法院擋海外 IP，就用：
- **J1 精選判決放進 references**：挑勞動實務上的關鍵判決（試用期的附保留終止權、不能勝任與最後手段性、§12 懲戒解僱、從屬性認定等），每則寫判決字號、重點、司法院裁判書查詢的官方網址。符合 (a)，我們每年檢視一次。判決全文從[司法院裁判書查詢](https://judgment.judicial.gov.tw/FJUD/default.aspx)取得，這是公開網站，不用帳號。
- **J2 申請帳號只用來核對**：帳號只用 `JDoc` 依字號抓精選判決的全文、確認沒被撤下；搜尋功能還是做不到。
- **J3 自建判決庫**：另開一張單，需要能跑排程的機器和大量儲存空間，超出這張單的範圍。

### Skill（使用者已決定）

做 9 個：`hr-setup`、`hiring`、`onboarding-contract`、`payroll-insurance`、`working-hours`、`leave`、`termination`、`worker-classification`、`harassment-bullying`。`performance` 不做，績效考核紀錄與改善機會併進 `termination` 的「不能勝任」段落。

### `scripts/`

- `termination/scripts/severance.py`、`leave/scripts/annual_leave.py`：從 tw-legal-calc 的 `calc/labor.py` 和 `calc/dates.py` 改寫，只用標準函式庫，沙盒有 python3 就能跑。MIT 授權，NOTICE 要列出來源。

### system prompt 參考

- 角色寫法參考 wshobson `hr-pro.md` 的原則段和 agency-agents `recruitment-specialist.md`，改成「在台灣中小企業做過十年以上人資，處理過勞檢與勞資調解」。
- 原則沿用 employment-legal `CLAUDE.md` 的「重大決定前停下來確認」與出處檢查。
- 聲明句和金融 Demo 一致：「以下為一般性分析，不構成正式法律、財務或授信意見」。
- 要求：數字一律附條號與「資料截至哪天」；遇到懷孕、職災、勞資爭議中、大量解僱時，明講「這種情況要找律師或勞工局」。

## 驗收

（階段三完成後填寫）
