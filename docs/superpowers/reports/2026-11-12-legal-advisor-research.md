# 企業法務顧問：調查報告（KAN-14 階段一）

調查日期：2026-11-12（民國 115 年 11 月 12 日）。星數、更新日期都是當天在 GitHub 查到的。

目標使用者：沒有專職法務的台灣中小企業老闆。範圍：商務合約、個資、產品與行銷合規、一般法律風險評估。勞動法歸人資顧問（KAN-15），不在這裡。

## 1. 候選比較

### 1.1 Skill／外掛來源

| 來源 | ★ | 最後更新 | 授權 | 內容深度 | 台灣適用性 | 要怎麼改 |
|---|---|---|---|---|---|---|
| [anthropics/claude-for-legal](https://github.com/anthropics/claude-for-legal) | 9,986 | 2026-11-08 | Apache-2.0 | **深**。12 個外掛；`nda-review` 312 行、`vendor-agreement-review` 343 行、`saas-msa-review` 245 行、`marketing-claims-review` 220 行、`dpa-review` 245 行、`use-case-triage` 295 行；每個都有決策流程、輸出範本、「不做什麼」 | 結構可以直接用，內容全是美國法（FTC、NAD、UDAP、GDPR/CCPA、Delaware、consequential damages）。**刻意不附預設立場**，立場全放在 playbook | 保留流程與輸出格式；playbook 改成專案記憶；預設立場換成台灣市場慣例；法條換成民法、消保法、公平法、個資法；拿掉 matter workspace、CLM、DocuSign、Slack、斜線指令、privilege header |
| [anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins) `legal/` | 35,524 | 2026-11-12 | Apache-2.0 | 中。`triage-nda` 262 行，**有寫明預設值**（期間 2–3 年、五種除外、禁競業）；`review-contract` 358 行；`legal-risk-assessment` 265 行（可能性 × 嚴重度矩陣）；`legal-response` 457 行（回函範本） | 結構通用，例子是美國 | 補 claude-for-legal 缺的「沒有 playbook 時的預設值」與風險矩陣 |
| 同 repo `small-business/skills/contract-review` | 同上 | 同上 | Apache-2.0 | 中。158 行，8 大風險類別（付款、責任、終止、IP、範圍、競業、保密、營運），語氣就是寫給沒有法務的老闆 | 類別直接適用；Net-30 等商業慣例要換成台灣（月結 30／60 天、票期） | 當作合約審閱的骨架與語氣範本 |
| [tern/taiwan-claude-legal](https://github.com/tern/taiwan-claude-legal) | 10 | 2026-08-26 | Apache-2.0 | 淺。一個 84 行的 `taiwan-legal-audit` skill＋民法、公司法、著作權法、勞基法、個資法的條文快照 | **台灣**。可取的是全國法規單條網址格式（`LawSingle.aspx?pcode=…&flno=…`）與 pcode 對照 | 只借網址格式與 pcode；條文快照不收（會過期，用 MCP 即時查） |
| [lawchat-oss/taiwan-legal-plugin](https://github.com/lawchat-oss/taiwan-legal-plugin) | 43 | 2026-10-21 | MIT | 中。5 個 skill（法規、裁判、函釋、研究資料、設定訪談），是查詢 MCP 的包裝 | 台灣，但對象是律師、明說「不是給一般消費者」 | 借「信心等級」與「引用前回官方網址核對」的寫法 |
| [msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents) `specialized/legal-document-review.md`、`legal-client-intake.md` | 167,852 | 2026-11-09 | MIT | 454／492 行 agent 定義 | 通用 | system prompt 參考：先確認當事人與立場、「沒寫到的條款也要標」、每次都給下一步 |
| [wshobson/agents](https://github.com/wshobson/agents) `hr-legal-compliance/agents/legal-advisor.md` | 42,433 | 2026-11-09 | MIT | 53 行 | 通用 | system prompt 參考 |
| [VoltAgent/awesome-claude-code-subagents](https://github.com/VoltAgent/awesome-claude-code-subagents) `08-business-product/legal-advisor.md` | 26,498 | 2026-11-02 | MIT | 中等長度清單 | 通用，偏科技公司 | system prompt 參考（工作流程三步） |
| [law24tw/tw-legal-calc](https://github.com/law24tw/tw-legal-calc) | 0 | 2026-10-04 | MIT | 20 種試算（遲延利息與違約金、司法規費、地址→管轄法院…），純 Python | 台灣 | **可選**：把 `calc/money.py`、`fees.py` 放進存證信函 skill 的 `scripts/`，算遲延利息與訴訟費用。沒有人用過（0 ★），要自己寫測試才收 |

### 1.2 MCP（全部實測過）

| MCP | 授權 | 連線 | 實測結果 | 結論 |
|---|---|---|---|---|
| [legaltechtw/taiwan-law-mcp](https://github.com/legaltechtw/taiwan-law-mcp)（`https://legaltech.org.tw/mcp`） | MIT | 遠端 Streamable HTTP、免金鑰、無狀態（不發 session id） | `initialize` 帶假的 `Authorization: Bearer` 仍回 200（伺服器 `taiwan-legal-research` 0.3.0）；`tools/list` 14 個工具；實際呼叫：民法第 252 條、公平法第 21 條全文正確並附 `source_url`；裁判搜尋「違約金 過高 酌減」回傳高院 114 年度判決與官方網址；法務部函釋搜尋「個人資料 委託 蒐集」回傳 107 年法律字函釋 | 功能採用，**但不連它的伺服器**：伺服器是第三方個人架設，不符合資料來源原則（見 1.3）。改成平台代管同一份程式，見第 5 節 |
| [lawchat-oss/mcp-taiwan-legal-db](https://github.com/lawchat-oss/mcp-taiwan-legal-db) | MIT | stdio，`uvx` 執行，第一次啟動會在背景裝 Chromium（約 150MB）過司法院的瀏覽器檢查 | 未在沙盒裝（見右欄） | **不採用**：工具比 taiwan-law-mcp 多（26 個），但每位租用者的 Sprite 都要裝 uv＋Chromium，沙盒帳號也不一定能跑瀏覽器；taiwan-law-mcp 已涵蓋需要的法規、裁判、函釋 |
| [aa0101181514/tw-legal-rag](https://github.com/aa0101181514/tw-legal-rag) | 自訂（NOASSERTION） | 遠端，連線時要 OAuth 登入 | — | 排除：OAuth、授權不明 |
| [RegAI-tw/regai-legal-mcp](https://github.com/RegAI-tw/regai-legal-mcp) | CC-BY-4.0 | 遠端，要金鑰 | — | 排除：要金鑰 |
| [pass-and-prosper/twlawexam-mcp](https://github.com/pass-and-prosper/twlawexam-mcp) | MIT | stdio | — | 排除：國考考古題，與用途無關 |
| 官方 MCP Registry（`registry.modelcontextprotocol.io`）搜 taiwan／legal／law | — | — | 沒有台灣法律伺服器 | — |
| Glama、Smithery 搜 taiwan law | — | — | 搜尋 API 沒有回傳結果 | — |

**taiwan-law-mcp 的限制**（要寫進 skill）：
- `search_taiwan_regulations` 只搜法律與命令的**名稱**，資料快照 2026-07-18；公平會處理原則、定型化契約應記載事項這類行政規則搜不到，要直接給主管機關網址。
- 法規條文是即時查（`cached:false`）或最多幾小時的快取，回答要附 `source_url`。
- 從 Windows 命令列送中文參數會亂碼（只影響本機測試；runtime 走 JSON，不受影響）。對方擋 Python urllib 的 User-Agent（403），curl 與 MCP 用戶端正常。

### 1.3 資料來源原則（使用者定，三張單都適用）

每一筆資料來源都要符合其中一項：**(a)** 我們自己能更新（資料在我們的 repo 或我們代管的 MCP 裡，並寫明怎麼更新）；**(b)** 直接來自權威機構（政府機關官方 API 或官方網站）。不能依賴第三方個人架的伺服器。

| 來源 | 符合 | 更新方式 |
|---|---|---|
| 法條全文、單條（`law.moj.gov.tw` 網頁） | (b) | 代管 MCP 每次查詢即時抓官方網頁，不需更新 |
| 法規名稱→pcode 索引、修正沿革（代管 MCP 的 `pcode_all.json`、`histories-*.json`） | (a)，資料取自 (b) 法務部開放 API `https://law.moj.gov.tw/api/Ch/Law/JSON`、`/api/Ch/Order/JSON`（免金鑰；實測 200、6.1 MB，`UpdateDate` 2026/10/30） | 由我們的產生腳本重建後重新部署代管版本；平台維運者每月一次，或重大修法公布後手動跑一次 |
| 釋字、憲判字全文與索引（`old_cases.json`、`new_cases.json`、`interp-index.json`） | (a)，資料取自 (b) 憲法法庭網站 `cons.judicial.gov.tw` | 同上（`node scripts/taiwan-law-data.ts`，約 80 分鐘）；憲判字有新判決時再跑。意見書只收文件名稱 |
| 法務部函釋（`mojlaw.moj.gov.tw`） | (b) | 即時查詢，不需更新 |
| 司法院裁判（`judgment.judicial.gov.tw` 查詢網頁） | (b) | 即時查詢；**要在代管 Sprite 上實測**，司法院 WAF 擋海外 IP 就拿掉這兩個工具並寫進報告 |
| 立法歷程三個工具 | (b)（改寫後） | 原程式用民間的 `ly.govapi.tw`，使用者決定**改接立法院開放資料**：資料集 20（議案提案，每日 04:15 更新）、373（三讀條文），即時查詢、快取 6 小時，不需更新 |
| 程式本身（npm `taiwan-law-mcp@0.3.0`，MIT） | (a) | 程式放進我們的 repo，版本固定；要升級時由我們重新打包、部署 |
| skill 的 `references/`（從官方網站整理的重點與出處網址） | (a)，出處 (b) | 寫明「資料截至 YYYY-MM-DD」；平台維運者每季檢查一次，修法時更新 |
| tw-legal-calc 試算程式 | (a) | 只收**遲延利息**試算，改寫成 `legal-letter/scripts/interest.py`；法定利率（民法第 203 條）修法才改。**規費試算沒收**：它依賴各高等法院轄區的加徵標準資料檔（民事訴訟法第 77-27 條，會變動、要另外維護），改成在 skill 寫明法條與「用司法院官方試算」 |
| 食品、化粧品廣告可用與禁用詞句 | (a)，出處 (b) | 逐字取自衛福部認定準則附件（全國法規資料庫 PDF），放在 `ad-claims-review/references/official-phrases.md`；準則修正時更新 |

### 1.4 網站（當作 `references/` 的出處，不整段複製）

政府網站的法令、公文依《著作權法》第 9 條不受著作權保護；其他政府網站內容依《政府資料開放授權條款》引用並標示出處。律師事務所文章只當背景，不複製。

| 網站 | 用途 | 從沙盒能否取得 |
|---|---|---|
| 全國法規資料庫 `law.moj.gov.tw` | 條文單條連結 `LawSingle.aspx?pcode=<pcode>&flno=<條號>` | 200 |
| 個人資料保護委員會籌備處 `pdpc.gov.tw` | 個資法修正、子法預告 | 200 |
| 公平交易委員會 `ftc.gov.tw`、主管法規系統 `law.ftc.gov.tw` | [對於網路廣告案件之處理原則](https://law.ftc.gov.tw/law/LawContent.aspx?id=GL000222)、[對於薦證廣告之規範說明](https://law.ftc.gov.tw/law/LawContent.aspx?id=FL037059)、比較廣告案件處理原則、[不實廣告規範與案例說明](https://www.ftc.gov.tw/upload/promo/9-1100915.pdf) | 200 |
| 衛福部食藥署 `fda.gov.tw` | 《食品及相關產品標示宣傳廣告涉及不實誇張易生誤解或醫療效能認定準則》（pcode L0040140）、《化粧品標示宣傳廣告涉及虛偽誇大或醫療效能認定準則》（L0030099） | 200 |
| 行政院消費者保護處 `cpc.ey.gov.tw` | 各行業定型化契約應記載及不得記載事項（依消保法第 17 條公告） | **逾時**；改用全國法規資料庫與各主管機關公告 |
| 經濟部中小及新創企業署 `sme.gov.tw` | 「中小企業法律諮詢服務」：榮譽律師免費線上諮詢、預約面談 | 200 |
| 法律扶助基金會 `laf.org.tw` | 找律師的管道 | 200 |
| 經濟部商業發展署 `gcis.nat.gov.tw` | 查對方公司登記（簽約前確認對方是誰） | 200 |
| 經濟部智慧財產局 `tipo.gov.tw` | 著作權、商標（合約的智財條款引用） | 200 |

## 2. 已查證的台灣化重點（階段三沿用）

- **個資法 114 年 11 月 11 日大修，尚未施行**：修正公布第 1-1、12、18、21、22–26、41、47–49、52、53、55 條，增訂第 20-1、21-1–21-5、51-1、53-1 條等，**施行日期由行政院定之**；全國法規資料庫已經顯示修正後條文（例如第 12 條事故要「通知當事人」並「通報主管機關」），臺北市法規系統標示「最後施行日期：未定」；個資會網站仍是「籌備處」，115 年 1 月、3 月預告施行細則修正與子法草案。
  → 個資 skill 必須同時寫「現在有效的義務」與「修正後會多出的義務」，並註明「資料截至 2026-11-12，施行日以行政院公告為準」，回答前用 MCP 確認。
- 民法第 252 條（違約金過高法院得酌減）：MCP 查證全文。
- 公平法第 21 條（不實廣告；第 5 項薦證者連帶責任，非知名人士以報酬十倍為限）：MCP 查證全文。網紅業配沒揭露利益關係屬第 25 條問題（薦證廣告規範說明）。
- 定型化契約：民法第 247-1 條、消保法第 11 條起；應記載事項依消保法第 17 條，違反者條款無效（行政院消保處 107.10.05 院臺消保字第 1070035451 號函引述）。
- 找律師：中企署中小企業法律諮詢服務（115 年 1 月 1 日改版，榮譽律師免費線上諮詢）、法扶、各地律師公會。

## 3. 排除名單

| 來源 | 原因 |
|---|---|
| [lawve-ai/awesome-legal-skills](https://github.com/lawve-ai/awesome-legal-skills)（947 ★） | CC BY-NC-ND，禁止改作 |
| [vivy-yi/Greater-China-Legal](https://github.com/vivy-yi/Greater-China-Legal) | 沒有授權檔 |
| [alfred-ij-tsai/tw-pdpa-gcbpr-toolkit](https://github.com/alfred-ij-tsai/tw-pdpa-gcbpr-toolkit)（台灣個資法遵對照表，內容扎實） | 沒有授權檔；只能當作「有哪些主題要涵蓋」的提示，不能引用內容 |
| [LucasYeh702/alr-tw](https://github.com/LucasYeh702/alr-tw)（Apache-2.0） | 是法律研究框架（provider、trace、評測），不是 skill，搬不進來 |
| [csterryliu/Legal-Attest-Letter-Generator-TW](https://github.com/csterryliu/Legal-Attest-Letter-Generator-TW)（存證信函產生器） | 授權 NOASSERTION |
| [aa0101181514/tw-legal-rag](https://github.com/aa0101181514/tw-legal-rag)、[RegAI-tw/regai-legal-mcp](https://github.com/RegAI-tw/regai-legal-mcp) | OAuth／金鑰 |
| [lawchat-oss/mcp-taiwan-legal-db](https://github.com/lawchat-oss/mcp-taiwan-legal-db) | 沙盒要裝 uv＋Chromium，見 1.2 |
| claude-for-legal 的 `employment-legal` | 勞動法歸人資顧問 |
| claude-for-legal 的 `ip-legal`（商標檢索、侵權分析、FTO）、`corporate-legal`（併購、董事會）、`litigation-legal`、`regulatory-legal`、`ai-governance-legal` | 超出中小企業日常；合約裡的著作權歸屬放進合約審閱處理 |
| claude-for-legal 的 `matter-workspace`、`customize`、`renewal-tracker`、`stakeholder-summary`、`dsar-response`、`policy-monitor` | 依賴 CLM／連接器或是律師事務所流程 |

## 4. 推薦清單（10 個 skill，請挑選）

每個 skill 開頭先 `memory_read` 專案記憶 `legal-playbook`；沒有就先問兩三題或明講「以下用一般市場標準」。

| # | skill | 什麼時候用 | 主要來源（合併） | 台灣化要改什麼 |
|---|---|---|---|---|
| 1 | `legal-setup` 公司法務設定訪談 | 第一次使用、公司狀況改變 | claude-for-legal 三個 `cold-start-interview`（commercial／privacy／product）、`references/company-profile-template.md` | 只問中小企業答得出來的：行業（食品、化粧品、電商、SaaS…）、多半是買方或賣方、常見對象、可接受的付款條件與違約金上限、有沒有合作律師、蒐集哪些個資、在哪些平台賣。寫成 project 記憶 `legal-playbook` |
| 2 | `contract-review` 商務合約審閱 | 收到供應商、客戶、經銷、委外、服務合約要簽之前 | claude-for-legal `vendor-agreement-review`＋`review`、kwp `review-contract`、small-business `contract-review` 八大類別 | 民法債編（買賣瑕疵擔保、承攬、委任）、第 247-1 條附合契約條款無效、第 252 條違約金酌減、第 222 條故意重大過失責任不得預免、第 216 條損害賠償範圍、合意管轄（民訴第 24 條）與仲裁法；`references/us-vs-tw-clauses.md` 對照 indemnification、consequential damages、Delaware arbitration、liquidated damages；著作權歸屬（著作權法第 11、12 條）；付款慣例（月結、票期） |
| 3 | `nda-review` 保密協議紅黃綠初審 | 談合作前對方丟來 NDA | claude-for-legal `nda-review`（scope check、紅黃綠）＋kwp `triage-nda`（預設值） | 營業秘密法第 2 條（合理保密措施）、違約金酌減、名為 NDA 實藏競業／專屬條款；預設值改成台灣常見做法；員工保密與競業轉給人資顧問 |
| 4 | `online-terms-review` 網購與定型化契約（B2C） | 官網、蝦皮／momo 賣場、會員條款、訂閱方案要上線前，或檢查自己的消費者條款 | kwp `compliance-check` 的檢查結構＋claude-for-legal `saas-msa-review` 的自動續約、價格調整段 | **台灣獨有**：消保法第 11–17 條（審閱期、應記載不得記載）、第 19 條通訊交易七日解除權與「通訊交易解除權合理例外情事適用準則」、網路交易相關應記載事項；自動續約與退費 |
| 5 | `privacy-check` 個資蒐集與告知健檢 | 新活動要收個資（會員、抽獎、問卷、LINE 官方帳號、預約表單）、要寫隱私權政策或告知聲明 | claude-for-legal `use-case-triage`＋`pia-generation`（精簡）、kwp `compliance-check` | 個資法第 5–9 條（特定目的、告知事項）、第 6 條特種個資、第 19、20 條（非公務機關蒐集利用、行銷拒絕權）、特定目的及個資類別代號、安全維護計畫；**114 年修法前後兩版**；不講 GDPR／CCPA，除非客戶在當地。產出可貼上的告知聲明 |
| 6 | `data-processing-review` 個資委外與跨境 | 把客戶資料交給外包、雲端、行銷代理商、海外服務 | claude-for-legal `dpa-review` | 個資法第 4 條（受託者視同委託機關）、施行細則第 8 條監督事項、第 21 條國際傳輸限制、事故通知（第 12 條新舊版）；把 GDPR DPA 用語對到台灣義務 |
| 7 | `ad-claims-review` 廣告與行銷文案合規 | 要發廣告、業配、網紅合作、商品頁、比較廣告、限時優惠 | claude-for-legal `marketing-claims-review`（宣稱分類：主觀、具體事實、比較、隱含、絕對） | 公平法第 21、25 條、網路廣告處理原則、薦證廣告規範說明（業配揭露、連帶責任）、比較廣告處理原則、消保法第 22 條；特定產業：食安法第 28 條＋食品廣告認定準則、化粧品衛生安全管理法＋認定準則、健康食品管理法、醫療器材與藥事法廣告；`references/` 放台灣違規詞例與公平會案例 |
| 8 | `legal-risk-triage` 這樣做有沒有問題、要不要找律師 | 老闆的快速問題（「可以用別人的照片嗎？」「這樣抽獎合法嗎？」） | claude-for-legal `is-this-a-problem`（✅／⚠️／🛑）＋`escalation-flagger`、kwp `legal-risk-assessment`（可能性 × 嚴重度） | 「這種情況要找律師」清單（被告、收到存證信函或律師函、金額超過設定門檻、刑事責任、主管機關來函）；免費與低價管道：中企署中小企業法律諮詢、法扶、律師公會、鄉鎮市調解委員會、消保官 |
| 9 | `legal-letter` 回函、催告與存證信函草稿 | 客戶欠款、對方違約、收到客訴或存證信函要回 | kwp `legal-response`、claude-for-legal legal-clinic `client-letter`（白話寫法）；可選加 tw-legal-calc 的利息與規費試算 | 民法第 229 條遲延、第 254 條解除前催告、第 233 條遲延利息、第 203 條法定利率；存證信函格式與寄法、律師函與存證信函差別；何時不要自己寫 |
| 10 | `saas-terms-review` SaaS／雲端服務條款（買方） | 公司要訂閱軟體、雲端服務 | claude-for-legal `saas-msa-review` | 自動續約、漲價、資料可攜與退場、SLA、次處理者；連到 #6 的委外個資義務。**也可以併進 #2** |

**使用者確認（2026-11-12）**：做 8 個 skill——legal-setup、contract-review（SaaS／雲端合約檢查清單併入 references/saas-cloud.md）、nda-review、legal-risk-triage、privacy-check（委外與跨境併入）、ad-claims-review、online-terms-review、legal-letter（附利息試算）。

## 5. 推薦的 MCP：平台代管的 taiwan-law（法務、人資共用）

主工作區已決定（使用者授權）：不用 legaltechtw 的公開伺服器，改由平台代管同一份程式。

- **程式**：npm `taiwan-law-mcp@0.3.0`（MIT；`server.js` 約 860 KB 未壓縮的打包檔，`bin.mjs` 是自架入口，Node 22+）。GitHub repo 沒有原始碼，npm 有。
- **對外連線**（從 `server.js` 找出的網址）：`law.moj.gov.tw`、`mojlaw.moj.gov.tw`、`judgment.judicial.gov.tw`、`lawsearch.judicial.gov.tw`、`cons.judicial.gov.tw` 都是官方；另有三個要處理的：
  1. `fetchAsset` 先讀 `DATA_DIR/legal-data/*`，**沒有才**向 `ASSET_UPSTREAM`（預設 `https://legaltech.org.tw`）下載 → 由我們的腳本產生這五個檔、打包進套件，並把 `ASSET_UPSTREAM` 指到不存在的位址，確保不會連出去。
  2. `ly.govapi.tw`（民間 LYAPI）→ 使用者決定改接立法院開放資料：新寫 `ly.mjs`（資料集 20、373），`server.js` 的立法區段改為匯入它。`data.ly.gov.tw` 只支援舊式 TLS 重新協商，Node 內建 `fetch` 會拒絕，所以 `ly.mjs` 用 `node:https` 並只對這個網站開 `SSL_OP_LEGACY_SERVER_CONNECT`。
  3. `region-fetch.internal`（Cloudflare 區域代理）在自架模式是 `setRegionFetcher(null)`，不會用到；但這表示司法院可能擋海外 IP，判決工具要在代管 Sprite 實測。
- **放的位置**：`apps/web/demo/hosted-mcp/taiwan-law/`（不放在 `demo/business-agents/` 那一層，否則會被當成顧問）。顧問的 `agent.json` 寫 `{ "name": "taiwan-law", "transport": "remote", "hosted": true }`，上架腳本依名稱找 `demo/hosted-mcp/<名稱>/`。
- **平台通行證**：`start.mjs` 設定 `DATA_DIR` 後載入 `server.js`；`/mcp` 先由 `auth.mjs`（Node 內建 crypto 驗 ES256，不用安裝套件）驗 `X-AgentHub-Token`，平台以外一律 401。
- **上架腳本支援代管**：建立版本 → 上傳 zip → 部署 → 每 5 秒讀取直到 ready → 發布 → 上架範本；套件內容雜湊沒變就不建新版本；最後下架其他沒有專案在用的版本（含上次中斷留下的失敗版本）。部署檢查要用平台私鑰簽通行證、私鑰只在正式站，所以代管的每一步都以創作者身分呼叫**正式站 API**（`apiHostedClient`），創作者 session 用 admin 產生一次性登入取得，不改 Demo 密碼。
- **資料檔**：`scripts/taiwan-law-data.ts` 從法務部開放 API 產生 `pcode_all.json`（法律 1,351＋命令 10,454，更新日 2026-10-30）、`histories-*.json`，從憲法法庭網站產生釋字 813 號、憲判字 59 號，共約 17 MB，commit 進 repo。
- **機器數**：Demo 創作者帳號上限 10 台。法務 1（taiwan-law）＋人資 3（taiwan-law、taiwan-payroll、taiwan-holidays）＋行銷可能 1 ＝ 5 台；更新時新舊版本短暫並存，最多再多 5 台，剛好在上限內，所以舊版一定要下架。

system prompt 規定：引用法條、函釋、判決一律先用這個 MCP 查，回答附 `source_url`；MCP 查不到就說查不到，不要憑記憶給條號。

## 6. system prompt 參考

- agency-agents `legal-document-review.md`：先確認文件類型、雙方、使用者是哪一方；「沒寫到的也要標」；每次都給下一步。
- VoltAgent `legal-advisor.md`：先了解業務 → 看現有文件 → 分析風險 → 給可執行建議。
- claude-for-legal 共用守則：不確定的引用要標「需查證」，不要編條號；紅旗才要求律師、不要每件都叫人找律師。
- 台灣：回答開頭聲明「以下為一般性分析，不構成正式法律、財務或授信意見」（與金融 Demo、`demo.test.ts` 一致）。

## 7. 驗收（2026-11-12，正式站 https://agenthub-kappa-pink.vercel.app）

做法參考 `scripts/smoke.ts`：建立 `@test.local` 測試帳號 → 建專案 → 租用「企業法務顧問」→ 每個情境開一個新對話 → 從資料庫讀 `messages.tool_events` 檢查載入的 skill 與 MCP 呼叫。跑完已刪除測試專案（含 Sprite）與帳號，過程持有雲端測試鎖。

上架：`scripts/seed-business-agents.ts` 以 `creator@demo.agenthub.app` 建立並上架範本（8 個 skill），taiwan-law 代管版本部署成功，`tools/list` 14 個工具。

| # | 情境 | 耗時 | 載入的 skill | MCP 呼叫 | 結果 |
|---|---|---|---|---|---|
| 1 | 一次給齊公司資料，請它做法務設定並存起來（手工皂／保養品公司、買方、月結 60 天、違約金上限 10%、台中地院、不接受仲裁…） | 41 秒 | legal-setup | — | 寫入專案記憶 `legal-playbook`（project 範圍），內容完整。缺點：更新日期是模型自己猜的（2026-03-29）→ 已在 skill 加「用 `date +%F` 取得日期」 |
| 2 | 檢查官網文案「有效改善痘痘與過敏肌，醫藥級品質，全台最便宜！網紅見證痘疤完全消失」 | 90 秒 | ad-claims-review（讀了 industry-rules、official-phrases、online-ads-endorsement） | `search_taiwan_laws` ×3（化粧品法第 10、20 條、公平法第 21 條） | **用到記憶**：認出是化粧品、有網紅業配。逐句判斷：「醫藥級」「抗過敏」引用準則附件一、「痘疤完全消失」引用附件四；罰鍰 60 萬至 500 萬元正確；提醒業配揭露（公平法第 25 條、薦證連帶責任）；給可用改寫 |
| 3 | 包材合約三條：每日千分之五違約金、英文 indemnify／consequential damages、德拉瓦州法＋AAA 仲裁；並查證違約金酌減條文 | 89 秒 | contract-review（讀了 us-vs-tw-clauses） | `search_taiwan_laws` ×4（民法第 252、250、205、233 條） | **用到記憶**：依「不接受仲裁、台中地院、違約金上限 10%」判斷。美式條款都轉成台灣說法並給改寫，條文附官方連結；用 `deliver_file` 交付報告。缺點：替代方案寫了「每日萬分之五」（年息約 18.25%，超過民法第 205 條的 16%）→ 已在 skill 主檔與 checklist 補上限 |
| 4 | IG 抽獎用 Google 表單收姓名、手機、地址、生日，之後想推 LINE 優惠，請寫告知聲明 | 79 秒 | privacy-check | `search_taiwan_laws` ×4（個資法第 56 條含沿革、第 8、19、20 條） | 先查第 56 條確認 114 年修正尚未施行，分「現在就要做／修正施行後」；抽獎與行銷同意要分開、不能預設勾選、首次行銷提供拒絕方式；附可貼上的告知聲明。沒有提 GDPR |
| 5 | 查每日千分之五違約金被酌減的判決 | 75 秒 | （不需要 skill） | `search_taiwan_judgments` ×3、`get_taiwan_judgment` ×2 | **代管 Sprite 查司法院判決成功，沒有被 WAF 擋**，判決工具保留。引用北院 107 訴 4981（酌減為每日千分之一）、中高分院 111 建上易 20（酌減為 1.5‰），已另外抓判決全文核對無誤 |

檢查項目：

- 有載入對的 skill：情境 1–4 都是；情境 5 是單純查判決，直接用 MCP。
- MCP 有被呼叫：情境 2–5 共 15 次，回答都附全國法規資料庫或司法院的官方網址。
- 沒有美國法殘留：美式條款都改用民法、民事訴訟法說明；個資只講台灣個資法。
- 數字有出處：罰鍰金額、利率、期限都附條號。
- 回答開頭都有「以下為一般性分析，不構成正式法律、財務或授信意見」。

驗收後的修正（已重新上架）：legal-setup 用系統日期、contract-review 提醒約定利率上限（民法第 205 條）。另外 simplify 審查時發現 `interest.py` 會把 `--rate 1` 當成 100%，已改成一律以百分比解讀並補測試。
