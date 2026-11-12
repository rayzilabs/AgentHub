# 企業法務顧問：來源與授權

本顧問的 skill 改寫自下列開源專案，已翻譯並改寫為台灣情境（法源換成台灣法、拿掉連接器與外部檔案路徑、公司設定改存 AgentHub 專案記憶）。各 SKILL.md 結尾的「來源」段落列出對應的原始檔案。

## Apache License 2.0

授權全文：https://www.apache.org/licenses/LICENSE-2.0

| 專案 | 使用的檔案 | 用在 |
|---|---|---|
| [anthropics/claude-for-legal](https://github.com/anthropics/claude-for-legal)（Copyright Anthropic, PBC） | `commercial-legal/skills/cold-start-interview`、`nda-review`、`vendor-agreement-review`、`review`、`saas-msa-review`、`escalation-flagger`；`privacy-legal/skills/cold-start-interview`、`use-case-triage`、`pia-generation`、`dpa-review`；`product-legal/skills/cold-start-interview`、`marketing-claims-review`、`is-this-a-problem`；`legal-clinic/skills/client-letter`；`references/company-profile-template.md` | legal-setup、contract-review、nda-review、legal-risk-triage、privacy-check、ad-claims-review、online-terms-review、legal-letter |
| [anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins)（Copyright Anthropic, PBC） | `legal/skills/triage-nda`、`review-contract`、`legal-risk-assessment`、`compliance-check`、`legal-response`；`small-business/skills/contract-review` | contract-review、nda-review、legal-risk-triage、privacy-check、online-terms-review、legal-letter |

改寫內容：翻譯為繁體中文；美國與歐盟法規（FTC、NAD、州法、GDPR、CCPA 等）換成台灣法規；刪除 CLM、DocuSign、Slack、Gmail 等連接器、斜線指令、matter workspace 與 hooks；新增台灣法條、主管機關規範與 references。

## MIT License

| 專案 | 使用的檔案 | 用在 |
|---|---|---|
| [law24tw/tw-legal-calc](https://github.com/law24tw/tw-legal-calc) | `calc/dates.py`、`calc/money.py`（`interest_penalty`） | `legal-letter/scripts/interest.py`（改為單檔命令列工具，只保留利息試算） |

## 參考（未複製內容）

- [msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents) `specialized/legal-document-review.md`（MIT）、[VoltAgent/awesome-claude-code-subagents](https://github.com/VoltAgent/awesome-claude-code-subagents) `categories/08-business-product/legal-advisor.md`（MIT）、[wshobson/agents](https://github.com/wshobson/agents) `plugins/hr-legal-compliance/agents/legal-advisor.md`（MIT）：system prompt 的寫法參考。

## 政府資料

法條、公告、處理原則與認定準則附件取自法務部全國法規資料庫、公平交易委員會主管法規共用系統等政府網站（資料截至 2026-11-12）。法令、公文依《著作權法》第 9 條不受著作權保護；其他政府網站內容依《政府資料開放授權條款》引用並標示出處。

## MCP

`taiwan-law`：平台代管的台灣法律查詢 MCP，程式來源與資料更新方式見 `apps/web/demo/hosted-mcp/taiwan-law/NOTICE.md`。
