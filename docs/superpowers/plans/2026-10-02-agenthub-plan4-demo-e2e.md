# AgentHub 計畫 4：Demo 顧問與 production 端對端驗證實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 production 上架 3 位金融顧問（授信審查、金融法遵、財務分析），建立一個已經雇好三位顧問的 Demo 專案，並在 production 網站用瀏覽器實際走完創作者、租用者、單一顧問、派工、討論的完整流程。

**Architecture:** Demo 內容以檔案放在 `apps/web/demo/agents/<slug>/`（`agent.json` + `skills/*/SKILL.md`），由 `scripts/seed-demo.ts` 讀取、打包 skill zip，並直接呼叫計畫 3 的 service 函式寫入雲端資料庫（可重複執行，已存在就更新）。端對端驗證在 production 網址用瀏覽器操作。

**Tech Stack:** 計畫 3 的 `apps/web`（services、`provisionProject`）、fflate、tsx。

**Spec:** `docs/superpowers/specs/2026-10-02-agenthub-mvp-design.md`

**前置條件：** 計畫 1–3 已完成，production 已部署且 `scripts/smoke.ts` 通過。

## Global Constraints

- 沿用計畫 1–3 的環境規則（雲端 Supabase 只用 `--linked`、`.env` 不可印出或 commit、commit 結尾加 `Claude-Session: https://claude.ai/code/session_019gWKBjFHT2VamSLeQeXEqj`）。
- Demo 帳號 Email 用 `@demo.agenthub.app` 結尾（不可用 `@test.local`，否則會被測試清理刪掉）：創作者 `creator@demo.agenthub.app`、使用者 `demo@demo.agenthub.app`。密碼由環境變數 `DEMO_PASSWORD` 提供；未提供時腳本產生一組隨機密碼並只印一次。
- Demo 顧問的內容是示範用，介紹最後一句固定為「（示範內容，正式版本將由執業專業人士提供）」。每位顧問的 system prompt 必須要求回答時聲明「以下為一般性分析，不構成正式法律、財務或授信意見」。
- seed 腳本可重複執行：以「創作者 + 顧問名稱」判斷是否已存在，存在就更新內容與 skill；Demo 專案以名稱「金融科技展 Demo」判斷，已存在且三位顧問都在就不重建。

## Review Focus

1. **重複執行 seed**：不產生重複的範本、專案或顧問。→ Task 1 Step 4 連跑兩次。
2. **skill 內容格式**：每個 SKILL.md 都通過計畫 3 的 `parseSkillsZip`。→ Task 1 測試。
3. **production 上的討論流程**：主管真的召開討論、印章顯示、三段總結。→ Task 2。
4. **重新整理與斷線**：串流進行中重新整理頁面，完成後看得到完整回覆。→ Task 2。
5. **手機寬度**：工作區在 390px 寬可以操作。→ Task 2。

---

### Task 1: Demo 顧問內容與 seed 腳本

**Files:**
- Create: `apps/web/demo/agents/credit/agent.json`、`apps/web/demo/agents/credit/skills/credit-5p/SKILL.md`、`apps/web/demo/agents/credit/skills/ratio-check/SKILL.md`
- Create: `apps/web/demo/agents/compliance/agent.json`、`apps/web/demo/agents/compliance/skills/aml-kyc/SKILL.md`、`apps/web/demo/agents/compliance/skills/data-privacy/SKILL.md`
- Create: `apps/web/demo/agents/finance/agent.json`、`apps/web/demo/agents/finance/skills/cashflow/SKILL.md`、`apps/web/demo/agents/finance/skills/valuation/SKILL.md`
- Create: `apps/web/lib/demo.ts`、`apps/web/scripts/seed-demo.ts`
- Test: `apps/web/test/demo.test.ts`

**Interfaces:**
- Consumes: 計畫 3 的 `createTemplate`、`updateTemplate`、`publishTemplate`、`listMyTemplates`、`createProject`、`listProjects`、`getProjectDetail`、`hireAgent`、`provisionProject`、`parseSkillsZip`、`TemplateInput`
- Produces:
  - `type DemoAgent = { slug: string; input: TemplateInput; skillsZip: Uint8Array }`
  - `loadDemoAgents(root?: string): Promise<DemoAgent[]>`（讀 `demo/agents/*`，依 slug 排序）
  - 指令：`cd apps/web && node --env-file=../../.env --import tsx scripts/seed-demo.ts`

- [ ] **Step 1: 寫 Demo 內容**

建立 `apps/web/demo/agents/credit/agent.json`：

```json
{
  "name": "授信審查顧問",
  "category": "金融授信",
  "description": "依銀行中小企業授信審查流程，從借款人、資金用途、還款來源、債權保障與產業展望五個面向評估案件，列出需要補件與追問的地方。（示範內容，正式版本將由執業專業人士提供）",
  "system_prompt": "你是一位有十五年經驗的銀行授信審查主管，專門審查台灣中小企業的融資案件。\n\n工作方法：\n1. 先用 credit-5p skill 的五個面向（借款人、資金用途、還款來源、債權保障、未來展望）逐一檢視，資訊不足的面向要明確寫「資料不足」並列出需要補的文件。\n2. 有財務數字時，用 ratio-check skill 計算關鍵比率並和門檻比較。\n3. 最後給出「建議核貸／附條件核貸／暫緩」其中之一，附上理由與條件。\n\n原則：保守、具體、指出風險訊號；不要編造數字，沒有的資料就說沒有。回答一開始先聲明「以下為一般性分析，不構成正式法律、財務或授信意見」。用繁體中文回答。",
  "mcp_servers": []
}
```

建立 `apps/web/demo/agents/credit/skills/credit-5p/SKILL.md`：

```markdown
---
name: credit-5p
description: 授信五 P 審查清單：借款人、資金用途、還款來源、債權保障、未來展望
---

# 授信五 P 審查清單

逐項檢查，每一項給出「良好／普通／有疑慮／資料不足」並寫一句理由。

## 1. 借款人（People）
- 負責人與主要股東的經營年資、信用紀錄（聯徵有無遲繳、退票）
- 公司成立年數、營業登記與實際營運是否一致
- 關係企業與關係人交易是否單純

## 2. 資金用途（Purpose）
- 用途是否明確：週轉金、購置設備、擴廠、還舊債
- 金額是否與營運規模相稱（週轉金一般不超過年營收的 25%）
- 是否有挪用風險（例如週轉金名義實際用於投資）

## 3. 還款來源（Payment）
- 第一還款來源：營業現金流是否足以支應本息（DSCR 建議 ≥ 1.25）
- 第二還款來源：處分資產、股東增資
- 應收帳款集中度：前三大客戶佔比超過 50% 要特別註記

## 4. 債權保障（Protection）
- 擔保品種類、鑑價、成數（不動產一般 7 成以內）
- 保證人資力
- 信保基金保證成數

## 5. 未來展望（Perspective）
- 產業景氣與政策風險
- 公司在產業中的競爭地位
- 匯率、原物料、利率敏感度

## 需要追問的典型問題
- 最近三年營收與毛利率變化的原因
- 銀行往來家數與總借款額度
- 有無或有負債（背書保證、訴訟）
```

建立 `apps/web/demo/agents/credit/skills/ratio-check/SKILL.md`：

```markdown
---
name: ratio-check
description: 授信常用財務比率的公式與參考門檻，用來快速判斷償債能力
---

# 財務比率檢查

用使用者提供的財報數字計算，算不出來的比率寫「缺資料」，不要猜。

| 比率 | 公式 | 參考門檻（中小企業） |
|---|---|---|
| 流動比率 | 流動資產 ÷ 流動負債 | ≥ 1.5 |
| 速動比率 | （流動資產 − 存貨）÷ 流動負債 | ≥ 1.0 |
| 負債比率 | 總負債 ÷ 總資產 | ≤ 60% |
| 利息保障倍數 | 稅前息前淨利 ÷ 利息費用 | ≥ 3 倍 |
| DSCR | （稅後淨利 + 折舊攤銷 + 利息）÷（本期應還本金 + 利息） | ≥ 1.25 |
| 應收帳款週轉天數 | 平均應收帳款 ÷ 營收 × 365 | 與同業比較，明顯偏高要追問 |

輸出格式：先列計算結果表，再用三句話總結償債能力。
```

建立 `apps/web/demo/agents/compliance/agent.json`：

```json
{
  "name": "金融法遵顧問",
  "category": "金融法規",
  "description": "從洗錢防制、個人資料保護、金融消費者保護與主管機關規範的角度，檢查新業務或資料應用的法遵風險，並提出具體的控制措施。（示範內容，正式版本將由執業專業人士提供）",
  "system_prompt": "你是一位熟悉台灣金融監理的法遵主管，曾任職銀行法遵部與律師事務所金融組。\n\n工作方法：\n1. 先釐清業務流程與涉及的資料、對象、金流。\n2. 依序檢查可能適用的規範：洗錢防制法與相關辦法（用 aml-kyc skill）、個人資料保護法（用 data-privacy skill）、金融消費者保護法、銀行法與主管機關函令。\n3. 每個風險標示「高／中／低」，並給出可執行的控制措施（流程、文件、系統控制）。\n4. 不確定法規細節時，明確寫出需要再向主管機關或外部律師確認的問題，不要假裝確定。\n\n回答一開始先聲明「以下為一般性分析，不構成正式法律、財務或授信意見」。用繁體中文回答。",
  "mcp_servers": []
}
```

建立 `apps/web/demo/agents/compliance/skills/aml-kyc/SKILL.md`：

```markdown
---
name: aml-kyc
description: 洗錢防制與認識客戶（KYC）檢查重點，用於評估新產品或新客群的洗錢風險
---

# 洗錢防制與 KYC 檢查

## 客戶審查
- 是否完成身分驗證，法人是否辨識實質受益人（持股 25% 以上或實際控制者）
- 是否篩檢制裁名單與重要政治性職務人士（PEP）
- 依客戶風險分級決定強化審查（EDD）或簡化審查

## 交易監控
- 是否有大額通貨交易申報機制（新台幣 50 萬元以上現金交易）
- 疑似洗錢交易態樣：短期內頻繁進出、與身分不符的金額、拆分交易
- 監控規則是否涵蓋新產品的交易型態

## 紀錄保存與教育訓練
- 交易紀錄與客戶資料保存至少 5 年
- 新產品上線前是否完成洗錢風險評估並留存紀錄

## 輸出
列出「已具備／需補強」兩欄，需補強的項目寫明負責單位與建議做法。
```

建立 `apps/web/demo/agents/compliance/skills/data-privacy/SKILL.md`：

```markdown
---
name: data-privacy
description: 個人資料保護法檢查清單，用於評估客戶資料的蒐集、處理、利用（含拿去訓練模型）是否合法
---

# 個資保護檢查

## 特定目的與告知
- 蒐集時告知的特定目的是什麼？新用途（例如模型訓練、行銷分析）是否在原目的範圍內
- 超出原目的時，是否取得當事人書面同意，或符合法定例外

## 去識別化
- 資料是否已去識別化到無法直接或間接識別個人
- 去識別化的方法與重新識別風險評估是否有紀錄
- 金融業另需注意主管機關對客戶資料保密的要求

## 委外與跨境
- 資料是否交給第三方（含雲端或 AI 服務商）處理，契約是否約定保密與安全措施
- 是否傳輸到境外，有無主管機關限制

## 安全維護
- 存取權限控管、加密、軌跡紀錄
- 發生外洩時的通報流程

## 輸出
用表格列出每個檢查點的結論（符合／有風險／需確認）與建議措施。
```

建立 `apps/web/demo/agents/finance/agent.json`：

```json
{
  "name": "財務分析顧問",
  "category": "財務分析",
  "description": "讀財報、拆解獲利與現金流，評估一個決策對營收、成本、現金與估值的影響，並把假設講清楚。（示範內容，正式版本將由執業專業人士提供）",
  "system_prompt": "你是一位具會計師資格的財務分析師，擅長把複雜的財務影響講成經營者聽得懂的話。\n\n工作方法：\n1. 先列出分析需要的假設（營收、成本、期間、折現率），使用者沒給的用合理假設並明確標示「假設」。\n2. 現金流相關問題用 cashflow skill；投資或併購價值用 valuation skill。\n3. 結論要量化：影響金額或比例的範圍（保守／基準／樂觀）。\n4. 指出對結論最敏感的一兩個假設。\n\n回答一開始先聲明「以下為一般性分析，不構成正式法律、財務或授信意見」。用繁體中文回答。",
  "mcp_servers": []
}
```

建立 `apps/web/demo/agents/finance/skills/cashflow/SKILL.md`：

```markdown
---
name: cashflow
description: 現金流分析步驟：營業、投資、籌資現金流與自由現金流的拆解與檢查
---

# 現金流分析

1. **營業現金流**：從稅後淨利出發，加回折舊攤銷，調整應收、存貨、應付的變動。淨利為正但營業現金流為負時，優先檢查應收帳款與存貨。
2. **投資現金流**：資本支出是維持性還是擴張性；一次性處分資產要另外標出。
3. **籌資現金流**：借款、還款、增資、發放股利。
4. **自由現金流** = 營業現金流 − 資本支出。連續兩年為負要說明原因與資金缺口。
5. **現金轉換循環** = 應收天數 + 存貨天數 − 應付天數，天數拉長代表需要更多週轉金。

輸出：一張簡表（三種現金流 + 自由現金流），加上三點觀察。
```

建立 `apps/web/demo/agents/finance/skills/valuation/SKILL.md`：

```markdown
---
name: valuation
description: 企業或專案估值方法：現金流折現（DCF）與市場倍數法，含敏感度分析
---

# 估值

## 現金流折現（DCF）
- 預測 3–5 年自由現金流，寫清楚營收成長率與利潤率假設
- 折現率用 WACC；中小企業可在上市同業的基礎上加 2–5% 規模與流動性溢酬
- 終值 = 最後一年自由現金流 ×（1 + 永續成長率）÷（折現率 − 永續成長率），永續成長率一般 1–3%

## 市場倍數法
- 選 3–5 家可比公司，使用本益比、EV/EBITDA 或股價淨值比
- 說明可比公司與標的的差異並調整

## 敏感度分析
- 至少做「折現率 ± 1%」與「營收成長率 ± 5%」兩個維度的表格
- 指出價值區間，而不是單一數字
```

- [ ] **Step 2: 寫測試**

建立 `apps/web/test/demo.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { loadDemoAgents } from '@/lib/demo';
import { TemplateInputSchema } from '@/lib/schemas';
import { parseSkillsZip } from '@/lib/skills-zip';

describe('loadDemoAgents', () => {
  it('讀出三位顧問，內容通過格式檢查，skill zip 可以解析', async () => {
    const agents = await loadDemoAgents();
    expect(agents.map((a) => a.slug)).toEqual(['compliance', 'credit', 'finance']);
    for (const a of agents) {
      expect(TemplateInputSchema.parse(a.input)).toEqual(a.input);
      expect(a.input.description).toContain('（示範內容，正式版本將由執業專業人士提供）');
      expect(a.input.system_prompt).toContain('以下為一般性分析，不構成正式法律、財務或授信意見');
      expect(parseSkillsZip(a.skillsZip)).toHaveLength(2);
    }
  });
});
```

- [ ] **Step 3: 確認測試失敗，實作 loadDemoAgents 與 seed 腳本**

```bash
pnpm -F @agenthub/web test test/demo.test.ts
```

Expected: FAIL，找不到 `@/lib/demo`。

建立 `apps/web/lib/demo.ts`：

```ts
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { TemplateInputSchema, type TemplateInput } from '@/lib/schemas';

export type DemoAgent = { slug: string; input: TemplateInput; skillsZip: Uint8Array };

const DEFAULT_ROOT = fileURLToPath(new URL('../demo/agents', import.meta.url));

async function collect(dir: string, prefix = ''): Promise<Record<string, Uint8Array>> {
  const out: Record<string, Uint8Array> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(out, await collect(full, rel));
    else out[rel] = new Uint8Array(await readFile(full));
  }
  return out;
}

export async function loadDemoAgents(root = DEFAULT_ROOT): Promise<DemoAgent[]> {
  const slugs = (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  return Promise.all(
    slugs.map(async (slug) => {
      const dir = path.join(root, slug);
      const input = TemplateInputSchema.parse(JSON.parse(await readFile(path.join(dir, 'agent.json'), 'utf8')));
      const skillsZip = zipSync(await collect(path.join(dir, 'skills')));
      return { slug, input, skillsZip };
    }),
  );
}
```

建立 `apps/web/scripts/seed-demo.ts`：

```ts
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));

const { adminDb } = await import('../lib/supabase/admin');
const { loadDemoAgents } = await import('../lib/demo');
const templates = await import('../lib/services/templates');
const projects = await import('../lib/services/projects');
const { provisionProject } = await import('../lib/sprites');

const db = adminDb();
const DEMO_PROJECT = '金融科技展 Demo';

async function ensureUser(email: string, password: string): Promise<string> {
  const { data, error } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw error;
  const found = data.users.find((u) => u.email === email);
  if (found) {
    const { error: updateError } = await db.auth.admin.updateUserById(found.id, { password });
    if (updateError) throw updateError;
    return found.id;
  }
  const { data: created, error: createError } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (createError) throw createError;
  return created.user.id;
}

const generated = !process.env.DEMO_PASSWORD;
const password = process.env.DEMO_PASSWORD ?? randomBytes(9).toString('base64url');
const creatorId = await ensureUser('creator@demo.agenthub.app', password);
const demoUserId = await ensureUser('demo@demo.agenthub.app', password);

const existing = await templates.listMyTemplates(db, creatorId);
const templateIds: string[] = [];
for (const agent of await loadDemoAgents()) {
  const current = existing.find((t) => t.name === agent.input.name);
  const t = current ?? (await templates.createTemplate(db, creatorId, agent.input));
  const { signedUrl } = await templates.createSkillsUploadUrl(db, creatorId, t.id);
  const put = await fetch(signedUrl, { method: 'PUT', body: agent.skillsZip, headers: { 'content-type': 'application/zip', 'x-upsert': 'true' } });
  if (!put.ok) throw new Error(`上傳 ${agent.slug} skill 失敗：${put.status}`);
  await templates.updateTemplate(db, creatorId, t.id, { ...agent.input, process_upload: true });
  await templates.publishTemplate(db, creatorId, t.id);
  templateIds.push(t.id);
  console.log(`${current ? '已更新' : '已建立'}並上架：${agent.input.name}`);
}

let project = (await projects.listProjects(db, demoUserId)).find((p) => p.name === DEMO_PROJECT);
if (!project) {
  project = await projects.createProject(db, demoUserId, DEMO_PROJECT);
  console.log('已建立 Demo 專案');
}
const detail = await projects.getProjectDetail(db, demoUserId, project.id);
for (const id of templateIds) {
  if (!detail.agents.some((a) => a.template_id === id)) await projects.hireAgent(db, demoUserId, project.id, id, {});
}
if (project.sprite_status !== 'ready') {
  console.log('正在準備 Demo 專案的 agent 環境…');
  await provisionProject(db, project.id);
}
const final = await projects.getOwnProject(db, demoUserId, project.id);
console.log(`Demo 專案狀態：${final.sprite_status}${final.sprite_error ? `（${final.sprite_error}）` : ''}`);
console.log('Demo 帳號：creator@demo.agenthub.app、demo@demo.agenthub.app');
if (generated) console.log(`Demo 密碼（只顯示這一次）：${password}`);
```

- [ ] **Step 4: 測試、執行兩次確認可重複**

```bash
pnpm -F @agenthub/web test test/demo.test.ts
pnpm -F @agenthub/web typecheck
cd apps/web
DEMO_PASSWORD=<自訂一組至少 12 字元的密碼> node --env-file=../../.env --import tsx scripts/seed-demo.ts
DEMO_PASSWORD=<同一組密碼> node --env-file=../../.env --import tsx scripts/seed-demo.ts
cd ../..
```

Expected: 測試 PASS；第一次執行「已建立並上架」三次、Demo 專案狀態 `ready`；第二次執行「已更新並上架」三次、沒有建立新專案。用 `supabase db query --linked "select count(*) from agent_templates where name in ('授信審查顧問','金融法遵顧問','財務分析顧問')"` 確認只有 3 筆；Demo 專案的 `agent_instances` 有 3 位顧問 + 1 位主管。把密碼寫進報告（只寫在報告檔，不要寫進 repo）。

- [ ] **Step 5: Commit 並部署**

```bash
git add apps/web/demo apps/web/lib/demo.ts apps/web/scripts/seed-demo.ts apps/web/test/demo.test.ts
git commit -m "feat(web): Demo 金融顧問與 seed 腳本"
git checkout main && git merge --no-ff feat/mvp -m "Merge feat/mvp: Demo 金融顧問

Claude-Session: https://claude.ai/code/session_019gWKBjFHT2VamSLeQeXEqj" && git push origin main && git checkout feat/mvp
```

等 `vercel ls agenthub --scope rayzilabs-2056` 最新部署為 Ready，打開 production 首頁確認三位顧問出現在名冊。

---

### Task 2: production 瀏覽器端對端驗證

**Files:**
- Modify: 驗證中發現問題時修改對應檔案（每個修正都要先寫或補測試，再修，再部署）
- Create: `docs/superpowers/reports/2026-10-02-production-e2e.md`（驗證紀錄）

**Interfaces:**
- Consumes: production 網址、Task 1 的 Demo 帳號

- [ ] **Step 1: 創作者流程（新帳號）**

在 production 用瀏覽器：
1. 以新的 Email（例如 `e2e-<時間>@demo.agenthub.app`）建立帳號。
2. 「我上架的 agent」→ 做一位新顧問「行銷顧問」，填介紹與 system prompt，上傳一個含兩個 SKILL.md 的 zip，新增一個 http 工具並設定金鑰名稱 `MARKETING_API_KEY`，儲存並上架。
3. 首頁名冊出現「行銷顧問」，介紹頁顯示兩個 skill 與一個工具。

記錄每一步截圖與結果。

- [ ] **Step 2: 租用者流程與單一顧問對話**

用同一個新帳號：
1. 建立專案「E2E 驗證」，看到準備中，約一分鐘後可以輸入。
2. 從市集加入「財務分析顧問」→ 回到專案名冊看得到。
3. 上傳一個文字檔（內容：某公司去年營收 1 億、毛利率 30%、應收帳款 4,000 萬）。
4. 開新對話問「根據專案資料，這家公司的現金流有什麼風險？」→ 串流回覆，內容引用了上傳的數字。
5. 說「我偏好保守的估計，請記住」→ 記憶面板出現這筆記憶（重新整理後仍在）。

- [ ] **Step 3: 多顧問、派工與討論**

用 Demo 帳號 `demo@demo.agenthub.app` 登入，打開「金融科技展 Demo」：
1. 問「一家做電商的中小企業申請 2,000 萬週轉金，請授信審查顧問先看要補哪些資料」→ 看到主管派工給授信審查顧問的卡片（顧問識別色、處理中 → 完成），主管整理回覆。
2. 問「我們想把客戶交易資料拿去訓練內部的信用評分模型，請三位顧問一起討論可行性，最後給我總結」→ 看到討論區塊：第 1 輪三位同時發言、第 2 輪起輪流、立場印章、最後主管回覆含「各面向建議」「共識方案」「仍有分歧」。
3. 討論進行中重新整理頁面 → 顯示「回覆還在進行中」，完成後自動出現完整回覆（含討論紀錄）。
4. 用瀏覽器把寬度縮到 390px，工作區可以捲動、輸入、看討論。

- [ ] **Step 4: 清理與紀錄**

1. 刪除 Step 1–2 建立的「E2E 驗證」專案（確認對應 Sprite 被刪除），保留 Demo 專案與三位 Demo 顧問。
2. 「行銷顧問」範本保留（示範創作者流程）或刪除皆可，紀錄決定。
3. 把每一步的結果、截圖描述、發現的問題與修正（含 commit）寫進 `docs/superpowers/reports/2026-10-02-production-e2e.md`，commit 並合併 push 到 main。

Expected: 所有步驟在 production 通過；任何失敗都已修正並重新驗證。
