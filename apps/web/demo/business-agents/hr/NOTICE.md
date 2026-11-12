# 人資顧問：來源與授權

這位顧問的 skill 改寫自下列開放授權的專案，已翻譯並改寫為台灣情境（台灣勞動法規、新臺幣、台灣用語與官方出處）。每個 SKILL.md 結尾的「來源」段落列出該 skill 用到的檔案。

## Apache License 2.0

授權全文：https://www.apache.org/licenses/LICENSE-2.0

| 專案 | 用到的檔案 | 修改 |
|---|---|---|
| [anthropics/claude-for-legal](https://github.com/anthropics/claude-for-legal) | `employment-legal/CLAUDE.md`；`employment-legal/skills/` 的 `cold-start-interview`、`hiring-review`、`termination-review`、`wage-hour-qa`、`worker-classification`、`policy-drafting`、`internal-investigation`、`leave-tracker`；`employment-legal/agents/leave-tracker.md` | 翻譯成繁體中文；美國聯邦與州的勞動法全部換成台灣法規；設定檔改存成專案記憶；拿掉連接器、斜線指令、律所案件工作區與 hooks |
| [anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins) | `human-resources/skills/` 的 `interview-prep`、`draft-offer`、`onboarding`、`performance-review`；`small-business/skills/` 的 `job-post-builder`、`hiring-screener`、`payroll-prep`、`plan-payroll` | 同上；薪資流程換成勞保、健保、勞退、二代健保與薪資所得扣繳 |

## MIT License

授權全文：https://opensource.org/license/mit

| 專案 | 用到的檔案 | 修改 |
|---|---|---|
| [hikari5014/Labor-Pixie](https://github.com/hikari5014/Labor-Pixie)（Copyright (c) 2026 hikari5014） | `data/checklists/contract-terms.json`、`company-audit.json`；`data/forms/probation-review.json`；`data/rules/` 的 `overtime-rates`、`wage-basis`、`national-holidays`、`annual-leave`、`sick-leave-rules`、`marriage-leave`、`separation-obligations`、`notice-period`、`severance-rules`、`bullying-deadlines`；`data/topics/` 的 `probation`、`overtime-records`、`worker-status`、`workplace-bullying`、`sexual-harassment`、`sick-leave-2026`；`data/cases/separation.json` | 從 JSON 改寫成 Markdown 說明與表格，並依法務部全國法規資料庫現行條文重新核對、補充 |
| [law24tw/tw-legal-calc](https://github.com/law24tw/tw-legal-calc) | `calc/labor.py`（`severance`、`annual_leave`）、`calc/dates.py` | 改寫成 `termination/scripts/severance.py`、`leave/scripts/annual_leave.py`：新制資遣費年資改用勞動部試算表的算法；特休改成只結算當期；加上命令列介面 |
| [msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents) | `specialized/recruitment-specialist.md`、`specialized/hr-onboarding.md` | 參考面試評分表與到職安排的寫法，翻譯並改寫 |
| [wshobson/agents](https://github.com/wshobson/agents) | `plugins/hr-legal-compliance/agents/hr-pro.md`、`plugins/hr-legal-compliance/skills/employment-contract-templates` | 參考 system prompt 原則與契約條款清單，改寫為台灣勞動契約 |
| [mohitagw15856/pm-claude-skills](https://github.com/mohitagw15856/pm-claude-skills) | `skills/tw-labour-standards` | 參考申訴管道與證據保存的提醒 |
| [sara-hamza/people-ops-claude](https://github.com/sara-hamza/people-ops-claude) | `plugins/people-ops/skills/performance-support-plan` | 參考績效改善計畫的結構 |

## 政府資料

- 法規條文：法務部全國法規資料庫（https://law.moj.gov.tw/）。法令依著作權法第 9 條不受著作權保護。
- 勞動部、勞保局、健保署、財政部的公告、說明與範本：依《政府資料開放授權條款－第 1 版》（https://data.gov.tw/license）使用，各處都註明出處。

## 平台代管的 MCP

計算工具 taiwan-payroll、taiwan-holidays 由平台代管，程式與授權見 `apps/web/demo/hosted-mcp/<名稱>/` 的 `LICENSE` 與 `README.md`。
