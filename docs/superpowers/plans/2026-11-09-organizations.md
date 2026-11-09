# 組織（團隊內部共用顧問）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 使用者能建立組織、邀請與核准成員；顧問範本可以只放在組織裡，只有成員看得到、租得到；成員離開或顧問下架後，專案裡的組織顧問呼叫不到。

**Architecture:** 三張新表（`organizations`、`org_members`、`org_invitations`），`agent_templates` 與 `agent_instances` 各加 `org_id`。「能不能呼叫」只在資料庫判斷一次：`org_instance_problem()` 同時給 runtime 的 RLS（被擋的顧問 runtime 根本讀不到，所以不用改、也不用重新部署 runtime）、遠端 MCP 閘道與專案畫面使用。網站的組織規則放在新的 `lib/services/orgs.ts`，範本的可見與編輯規則改在 `lib/services/templates.ts`。

**Tech Stack:** Next.js 16 App Router、Supabase（Postgres＋RLS）、Vitest（測試直接打雲端 Supabase）、zod。

**Spec:** `docs/superpowers/specs/2026-11-09-organizations-design.md`

## Global Constraints

- 角色只有 `admin`、`member`；建立組織的人是第一位 `admin`。
- 邀請以 email 指定、不寄信；email 一律 `trim().toLowerCase()` 後比對。邀請 7 天有效（`expires_at = now() + interval '7 days'`），只對「還沒接受」的邀請生效。
- 管理員發出的邀請，對方接受後直接加入；一般成員發出的，接受後等管理員核准。
- `organizations.require_template_approval` 預設 `false`；核准只管範本第一次上架。
- 範本 `org_id` 只在建立時決定，之後不能改（公開↔組織不能互轉）。
- 一般成員對組織範本只拿到 `PublicTemplate`；完整內容只給「本人且仍是成員」或該組織管理員。
- 下架＝`status` 退回 `draft`，只開放給組織範本。
- 組織至少要有一位管理員。
- 不改 `packages/runtime`、不 redeploy runtime。
- migration 由使用者在 Supabase Dashboard SQL Editor 套用；套用前不要跑依賴它的測試。
- 錯誤訊息（照抄）：
  - `找不到這個組織`（404，非成員一律這個）
  - `只有管理員可以這樣做`（403）
  - `組織至少要有一位管理員，請先指定另一位管理員`（409）
  - `這個人已經是成員`（409）
  - `已經邀請過這個 email`（409）
  - `邀請已過期，請對方重新邀請`（410）
  - `找不到這份邀請`（404）
  - `你不是這個組織的成員`（403，租用組織顧問時）
  - `這位顧問已無法使用`（403，MCP 閘道）
  - `專案裡的顧問都已無法使用`（409，送出對話時）
- 顧問無法使用的原因文案：`not_member` → `你已不是「<組織名>」的成員`；`unpublished` → `這位顧問已從「<組織名>」下架`。

## Review Focus

1. 邀請時的 email 帶大寫或空白（`' Student@NTHU.edu.tw '`），對方用小寫登入也要看得到 → Task 2 測試 `邀請 email 不分大小寫與前後空白`。
2. 唯一的管理員自己退出、把自己改成一般成員、或被另一個管理員以外的方式移出 → Task 2 測試 `最後一位管理員不能退出或降級`。
3. 被移出後又重新加入，舊專案裡的顧問要恢復可用；顧問下架再上架也一樣 → Task 1 測試 `重新加入與重新上架後恢復`。
4. 非成員直接打 `/templates/<組織範本 id>` 或 `GET /api/templates/<id>`，必須是 404，不能拿到公開欄位 → Task 3 測試 `非成員用網址直接看組織範本是 404`。
5. 專案有主管＋兩位顧問、其中一位是被擋的組織顧問：runtime 只讀到一位顧問，會自動改成單一顧問模式；畫面上被擋的顧問要標出來，不是消失 → Task 1 測試 `runtime 讀不到被擋的組織顧問` 與 Task 4 測試 `專案畫面標出無法使用的顧問與原因`。

---

### Task 1: 資料表、能否呼叫的判斷與 runtime 權限

**Files:**
- Create: `supabase/migrations/20261109000001_organizations.sql`
- Modify: `docs/security-model.md`（第 3 節加一列、第 4 節 `agent_instances`／`agent_templates`／Storage `skills` 的限制欄、新表三列）
- Test: `apps/web/test/runtime-access.test.ts`（新增 `describe('組織顧問的 runtime 權限')`）、`apps/web/test/projects.test.ts`（hire 的組織情境）

**Interfaces:**
- Produces（資料表）：
  - `public.organizations(id uuid pk default gen_random_uuid(), name text not null check (char_length(trim(name)) between 1 and 50), require_template_approval boolean not null default false, created_by uuid not null → profiles on delete cascade, created_at timestamptz default now())`
  - `public.org_members(org_id uuid → organizations on delete cascade, user_id uuid → profiles on delete cascade, role text not null check in ('admin','member'), email text not null, joined_at timestamptz default now(), primary key (org_id, user_id))`，索引 `(user_id)`。`email` 是加入時的 email（給成員名單顯示用）
  - `public.org_invitations(id uuid pk, org_id uuid → organizations on delete cascade, email text not null check (email = lower(trim(email))), invited_by uuid not null → profiles on delete cascade, needs_approval boolean not null, status text not null default 'invited' check in ('invited','accepted'), accepted_user_id uuid null → profiles on delete cascade, created_at timestamptz default now(), expires_at timestamptz not null default now() + interval '7 days')`，`unique (org_id, email)`，索引 `(email)`
  - `agent_templates.org_id uuid null → organizations on delete restrict`；`status` 的 check 改成 `in ('draft','pending','published')`；`pending` 只能出現在 `org_id is not null` 的列（`check (status <> 'pending' or org_id is not null)`）
  - `agent_instances.org_id uuid null → organizations on delete set null`（租用時從範本複製）
  - 三張新表開 RLS、`revoke all ... from anon, authenticated`，只有 service role 用
- Produces（函式）：
  - `public.org_instance_problem(p_org_id uuid, p_template_id uuid, p_project_id uuid) returns text`：`stable security definer set search_path = ''`。`p_org_id` 是 null → null；專案擁有者不在 `org_members(p_org_id)` → `'not_member'`；`agent_templates` 找不到 `p_template_id`、或它的 `org_id` 不是 `p_org_id`、或 `status <> 'published'` → `'unpublished'`；其餘 null。給 `authenticated, service_role`
  - `public.project_instance_problems(p_project_id uuid) returns table (instance_id uuid, org_name text, problem text)`：只列出 problem 非 null 的顧問；只給 service_role
  - `hire_agent`：以 `20261015000002_hosted_mcp_retire.sql` 裡的最新版本為底 `create or replace`，加兩件事：範本 `org_id` 非 null 且專案擁有者不是該組織成員 → `raise exception 'not org member' using errcode = '42501'`；insert `agent_instances` 時帶 `org_id = t.org_id`
- Produces（權限）：policy `runtime_read on agent_instances` 改成 `using (project_id = public.runtime_project() and public.org_instance_problem(org_id, template_id, project_id) is null)`。`agent_templates` 與 Storage `skills` 的 runtime policy 用的是 `agent_instances` 子查詢，會跟著被濾掉，不用另外改（測試會驗證）

- [ ] **Step 1: 寫 migration**

開頭照 `20261103000001_cloud_folder.sql` 的格式寫註解（目的、規格路徑）。`drop policy runtime_read on public.agent_instances` 後重建。

- [ ] **Step 2: 改 `docs/security-model.md`**

第 4 節：`agent_instances` 限制欄改成「自己專案，且組織顧問要通過 `org_instance_problem`（擁有者仍是成員、範本仍上架）」；Storage `skills`、`agent_templates` 註明跟著濾掉；加 `organizations`／`org_members`／`org_invitations` 三列，全部 ❌。第 3 節規則表加一列「組織顧問只有成員租得到；成員離開或下架後，runtime 讀不到這位顧問、MCP 閘道拒絕」，狀態 🚧。記一個已知取捨：`org_instance_problem` 給 authenticated 執行，知道專案 id 與組織 id 的 runtime 帳號能問出「這個專案擁有者是不是那個組織的成員」。

- [ ] **Step 3: 請使用者在 Dashboard SQL Editor 套用 migration，確認沒有錯誤**

這一步要停下來等使用者。

- [ ] **Step 4: 寫測試**

`runtime-access.test.ts` 新增 `describe('組織顧問的 runtime 權限')`，輔助函式 `seedOrgProject()`：建 org（admin＝另一個使用者）、owner 加為 member、建 `org_id` 已上架的範本、`seedProject` 的 instance 補上 `org_id` 與 `template_id`。
- `runtime 讀不到被擋的組織顧問`：專案有一位公開顧問＋一位組織顧問；擁有者是成員時 `ra.from('agent_instances').select('id')` 兩筆；從 `org_members` 刪掉擁有者後只剩公開那筆，`ra.storage.from('skills').download(組織顧問的 zip)` 有 error，`ra.from('agent_templates').select('id')` 不含組織範本。
- `重新加入與重新上架後恢復`：刪成員後再加回 → 又是兩筆；範本 `status` 改 `draft` → 一筆；改回 `published` → 兩筆。
- `project_instance_problems 回傳原因`：刪成員後 `db.rpc('project_instance_problems', { p_project_id })` 是 `[{ instance_id, org_name: <組織名>, problem: 'not_member' }]`；改成 draft 且成員還在時 problem 是 `'unpublished'`。

`projects.test.ts` 新增：
- `組織顧問只有成員能租，租到的副本帶 org_id`：非成員 `hireAgent` 的 `error.code === '42501'`（此時 service 還沒對應，先斷言 rpc 錯誤；Task 4 會改成 403）；成員租用成功，`agent_instances.org_id` 等於組織 id。

- [ ] **Step 5: 跑測試**

Run: `pnpm -F @agenthub/web test test/runtime-access.test.ts test/projects.test.ts`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20261109000001_organizations.sql docs/security-model.md apps/web/test/runtime-access.test.ts apps/web/test/projects.test.ts
git commit -m "feat: 組織的資料表與組織顧問能否呼叫的資料庫判斷"
```

---

### Task 2: 組織、成員與邀請的服務與 API

**Files:**
- Create: `apps/web/lib/services/orgs.ts`
- Create: `apps/web/app/api/orgs/route.ts`、`apps/web/app/api/orgs/[id]/route.ts`、`apps/web/app/api/orgs/[id]/invitations/route.ts`、`apps/web/app/api/orgs/[id]/invitations/[invitationId]/route.ts`、`apps/web/app/api/orgs/[id]/members/[userId]/route.ts`、`apps/web/app/api/invitations/route.ts`、`apps/web/app/api/invitations/[id]/route.ts`
- Modify: `apps/web/lib/schemas.ts`（`OrgInputSchema`、`OrgPatchSchema`、`InviteSchema`、`MemberPatchSchema`）
- Test: `apps/web/test/orgs.test.ts`

**Interfaces:**
- Consumes: Task 1 的三張表
- Produces（`lib/services/orgs.ts`）：
  ```ts
  export type OrgRole = 'admin' | 'member';
  export type OrgRow = { id: string; name: string; require_template_approval: boolean; created_at: string };
  export type MyOrg = OrgRow & { role: OrgRole };
  export type OrgMember = { user_id: string; email: string; role: OrgRole; joined_at: string };
  export type OrgInvitation = { id: string; email: string; status: 'invited' | 'accepted'; needs_approval: boolean; invited_by_email: string; expires_at: string; expired: boolean };
  export type OrgDetail = { org: OrgRow; role: OrgRole; members: OrgMember[]; invitations: OrgInvitation[] }; // invitations：管理員看全部，一般成員只看自己發的
  export type MyInvitation = { id: string; org_id: string; org_name: string; invited_by_email: string; expires_at: string };

  createOrg(db, user: { id: string; email: string }, input: { name: string; require_template_approval?: boolean }): Promise<OrgRow>
  listMyOrgs(db, userId): Promise<MyOrg[]>
  getMembership(db, userId, orgId): Promise<OrgRole | null>
  requireMember(db, userId, orgId): Promise<OrgRole>   // 非成員 404「找不到這個組織」
  requireAdmin(db, userId, orgId): Promise<void>        // 非成員 404、成員 403
  getOrgDetail(db, userId, orgId): Promise<OrgDetail>
  updateOrg(db, userId, orgId, patch: { name?: string; require_template_approval?: boolean }): Promise<OrgRow> // 管理員
  invite(db, userId, orgId, email: string): Promise<OrgInvitation>
  revokeInvitation(db, userId, orgId, invitationId): Promise<void>   // 發出的人或管理員
  approveInvitation(db, userId, orgId, invitationId): Promise<OrgMember> // 管理員；只限 status 'accepted'
  rejectInvitation(db, userId, orgId, invitationId): Promise<void>   // 管理員；刪掉
  listMyInvitations(db, email: string): Promise<MyInvitation[]>      // 只列 status 'invited' 且未過期
  acceptInvitation(db, user: { id: string; email: string }, invitationId): Promise<{ joined: boolean }>
  declineInvitation(db, user: { id: string; email: string }, invitationId): Promise<void>
  setMemberRole(db, userId, orgId, targetUserId, role: OrgRole): Promise<OrgMember> // 管理員
  removeMember(db, userId, orgId, targetUserId): Promise<void>  // 本人（退出）或管理員（移出）
  ```
- 行為：
  - `invite`：email 正規化；已是成員 → 409 `這個人已經是成員`；同 email 有未過期的邀請 → 409 `已經邀請過這個 email`；過期的舊列先刪再建。`needs_approval = 邀請人不是管理員`。
  - `acceptInvitation`：邀請的 email 必須等於 `user.email` 正規化，否則 404 `找不到這份邀請`；過期 → 410；`needs_approval` 為 false → 新增成員（role `member`、email 用邀請的 email）並刪掉邀請，回 `{ joined: true }`；否則改成 `status 'accepted'`、`accepted_user_id`，回 `{ joined: false }`。
  - `approveInvitation`：用 `accepted_user_id` 新增成員後刪掉邀請。
  - `setMemberRole`／`removeMember`：會讓管理員變 0 位 → 409 `組織至少要有一位管理員，請先指定另一位管理員`。
- Produces（API，全部用 `route()`＋`requireUser`＋`readJson`）：
  - `GET /api/orgs` → `listMyOrgs`；`POST /api/orgs` → `createOrg`
  - `GET /api/orgs/:id` → `getOrgDetail`；`PATCH /api/orgs/:id` → `updateOrg`
  - `POST /api/orgs/:id/invitations` `{ email }` → `invite`
  - `POST /api/orgs/:id/invitations/:invitationId` `{ action: 'approve' | 'reject' }`；`DELETE` → `revokeInvitation`
  - `PATCH /api/orgs/:id/members/:userId` `{ role }`；`DELETE` → `removeMember`
  - `GET /api/invitations` → `listMyInvitations(user.email)`
  - `POST /api/invitations/:id` `{ action: 'accept' | 'decline' }`

- [ ] **Step 1: 寫失敗的測試（`orgs.test.ts`）**

用 `seedUser` 建 admin、member、outsider。測試名稱與斷言：
- `建立組織的人是管理員`：`createOrg` 後 `listMyOrgs(admin)` 的 role 是 `'admin'`、`require_template_approval` 是 false；outsider `getOrgDetail` → 404 `找不到這個組織`。
- `成員邀請要管理員核准、管理員邀請直接加入`：member 邀請 X → X `listMyInvitations` 有一筆；X accept 回 `{ joined: false }`，X 還不是成員；admin `approveInvitation` 後 X 是 `member`。admin 邀請 Y，Y accept 回 `{ joined: true }`。
- `邀請 email 不分大小寫與前後空白`：邀請 `' ' + X.email.toUpperCase() + ' '`，X 用原本 email 的 `listMyInvitations` 有這筆。
- `重複邀請與邀請成員回 409`：同 email 再邀一次 → 409 `已經邀請過這個 email`；邀請 member 的 email → 409 `這個人已經是成員`。
- `過期的邀請不能接受`：把 `expires_at` 改成過去 → `listMyInvitations` 沒有這筆、`acceptInvitation` → 410 `邀請已過期，請對方重新邀請`；同 email 可以重新邀請。
- `別人不能接受不是給自己的邀請`：outsider accept X 的邀請 → 404 `找不到這份邀請`。
- `一般成員只看得到自己發的邀請、不能核准或改設定`：member 的 `getOrgDetail().invitations` 只有自己發的；member `approveInvitation`、`updateOrg` → 403 `只有管理員可以這樣做`。
- `撤回邀請`：發出的 member 可以 `revokeInvitation`；另一位非發出者的一般成員 → 403。
- `最後一位管理員不能退出或降級`：唯一 admin `removeMember(自己)`、`setMemberRole(自己, 'member')` → 409；先把 member 升成 admin 後，原 admin 可以退出。
- `成員可以自己退出、管理員可以移出`：member `removeMember(自己)` 成功；admin 移出另一位成員成功；一般成員移出別人 → 403。

- [ ] **Step 2: 跑測試確認失敗**

Run: `pnpm -F @agenthub/web test test/orgs.test.ts`
Expected: FAIL（`@/lib/services/orgs` 不存在）

- [ ] **Step 3: 實作 `lib/services/orgs.ts` 與 schemas**

`OrgInputSchema`：`name` trim 1～50 字（訊息 `組織名稱 1～50 個字`）、`require_template_approval` boolean optional。`InviteSchema`：`email` 用 `z.email('請輸入有效的 Email')`。

- [ ] **Step 4: 跑測試確認通過**

Run: `pnpm -F @agenthub/web test test/orgs.test.ts`
Expected: PASS

- [ ] **Step 5: 實作 API routes**

只做轉接，照 `app/api/templates/[id]/route.ts` 的寫法；`requireUser` 回的 `user.email` 直接傳給需要 email 的函式。

- [ ] **Step 6: typecheck 與 commit**

Run: `pnpm typecheck`，Expected: 沒有錯誤

```bash
git add apps/web/lib/services/orgs.ts apps/web/lib/schemas.ts apps/web/app/api/orgs apps/web/app/api/invitations apps/web/test/orgs.test.ts
git commit -m "feat: 組織的成員、邀請與核准"
```

---

### Task 3: 組織範本的可見、編輯、上架與下架

**Files:**
- Modify: `apps/web/lib/services/templates.ts`、`apps/web/lib/services/hosted-mcp.ts`（`getOwnTemplate` 呼叫改名）、`apps/web/lib/schemas.ts`（`TemplateInputSchema` 加 `org_id`）
- Modify: `apps/web/app/api/templates/route.ts`（`GET ?org=<id>`）
- Create: `apps/web/app/api/templates/[id]/unpublish/route.ts`、`apps/web/app/api/templates/[id]/review/route.ts`
- Test: `apps/web/test/templates.test.ts`、`apps/web/test/hosted-mcp.test.ts`（既有測試改用新名稱即可）

**Interfaces:**
- Consumes: Task 2 的 `getMembership`、`requireMember`、`requireAdmin`
- Produces（`templates.ts`）：
  - `TemplateRow` 加 `org_id: string | null`；`status: 'draft' | 'pending' | 'published'`；`PublicTemplate` 也帶 `org_id`，另加 `org_name: string | null`（`PublishedTemplate` 也加）
  - `getOwnTemplate` 改名為 `getEditableTemplate(db, userId, id): Promise<TemplateRow>`：公開範本＝`creator_id` 本人；組織範本＝本人且仍是成員，或該組織管理員；其餘 404 `找不到這個 agent`。所有原本呼叫 `getOwnTemplate` 的地方（含 `hosted-mcp.ts` 的 `ownHostedMcp`、`ownVersion`）都改用它
  - `listPublishedTemplates(db)`：加 `.is('org_id', null)`
  - `listOrgTemplates(db, userId, orgId): Promise<(PublicTemplate & { editable: boolean })[]>`：`requireMember`；一般成員只列 `published`；管理員列全部狀態；`editable` 依 `getEditableTemplate` 的規則
  - `listMyTemplates(db, userId)`：自己建的，排除「組織範本且自己已不是成員」
  - `getTemplate(db, id, viewerId)`：組織範本：viewer 不是成員 → 404；可編輯者 → 完整資料；其他成員 → `published` 才看得到（公開欄位），否則 404。公開範本規則不變
  - `createTemplate(db, userId, input)`：`input.org_id` 有值時 `requireMember`
  - `publishTemplate(db, userId, id)`：組織範本、`require_template_approval` 為 true、目前是 `draft`、且呼叫者不是管理員 → `status 'pending'`；其他情況 → `published`（已上架的再按一次仍是原地更新）
  - `reviewTemplate(db, userId, id, action: 'approve' | 'reject'): Promise<TemplateRow>`：該組織管理員；只限 `pending`；approve → `published`、reject → `draft`
  - `unpublishTemplate(db, userId, id): Promise<TemplateRow>`：`getEditableTemplate`；公開範本 → 400 `公開市集的顧問目前不能下架`；組織範本 → `draft`
- Produces（API）：`GET /api/templates?org=<id>` → `listOrgTemplates`；`POST /api/templates/:id/unpublish`；`POST /api/templates/:id/review` `{ action }`

- [ ] **Step 1: 寫失敗的測試（`templates.test.ts` 新增 `describe('組織範本')`）**

輔助：`seedOrg()` 回傳 admin、member、outsider 與 org id（用 Task 2 的 service 建）。
- `組織範本不出現在公開市集`：member 建 `org_id` 範本並上架 → `listPublishedTemplates` 不含它；`listOrgTemplates(member)` 含它；outsider `listOrgTemplates` → 404。
- `非成員用網址直接看組織範本是 404`：outsider 與 `null` 的 `getTemplate` → 404。
- `一般成員只看得到公開欄位`：另一位 member2 的 `getTemplate` 沒有 `system_prompt` 屬性（`'system_prompt' in t === false`）；admin 與建立者看得到 `system_prompt`。
- `建立者離開後只有管理員能改，建立者看不到內容`：建立者被移出後，`getTemplate(建立者)` → 404、`listMyTemplates(建立者)` 不含它、`updateTemplate(建立者)` → 404；admin `updateTemplate` 成功。
- `需要核准時成員上架變待核准，管理員核准後上架`：`updateOrg(require_template_approval: true)`；member `publishTemplate` → `status 'pending'`，member2 的 `listOrgTemplates` 不含它；admin `reviewTemplate('approve')` → `published`。已上架後 member 再 `publishTemplate` 仍是 `published`。reject 的範本回到 `draft`。
- `管理員上架不需要核准`：設定為 true 時 admin 建的範本 `publishTemplate` 直接 `published`。
- `下架只限組織範本`：組織範本 `unpublishTemplate` → `draft`；公開範本 → 400 `公開市集的顧問目前不能下架`。
- `非成員不能在組織裡建範本`：outsider `createTemplate({ org_id })` → 404 `找不到這個組織`。

- [ ] **Step 2: 跑測試確認失敗**

Run: `pnpm -F @agenthub/web test test/templates.test.ts`
Expected: FAIL

- [ ] **Step 3: 實作 `templates.ts` 的改動與 `hosted-mcp.ts` 的改名**

`org_name` 用 `organizations(name)` 嵌入查詢取得。

- [ ] **Step 4: 跑測試確認通過**

Run: `pnpm -F @agenthub/web test test/templates.test.ts test/hosted-mcp.test.ts test/hosted-mcp-routes.test.ts`
Expected: PASS

- [ ] **Step 5: 實作 API routes、typecheck、commit**

Run: `pnpm typecheck`，Expected: 沒有錯誤

```bash
git add apps/web/lib/services/templates.ts apps/web/lib/services/hosted-mcp.ts apps/web/lib/schemas.ts apps/web/app/api/templates apps/web/test/templates.test.ts apps/web/test/hosted-mcp.test.ts
git commit -m "feat: 組織範本只給成員看與租，管理員可核准、維護與下架"
```

---

### Task 4: 租用、對話、MCP 閘道與專案畫面資料擋下被停用的組織顧問

**Files:**
- Modify: `apps/web/lib/services/projects.ts`（`hireAgent` 錯誤對應、`AgentSummary.unavailable`）
- Modify: `apps/web/lib/services/remote-mcp.ts`（`resolveRemoteTarget`）
- Modify: `apps/web/app/api/threads/[id]/chat/route.ts`
- Test: `apps/web/test/projects.test.ts`、`apps/web/test/remote-mcp.test.ts`、`apps/web/test/chat-route.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `org_instance_problem`、`project_instance_problems`、`agent_instances.org_id`
- Produces：
  - `AgentSummary` 加 `unavailable: string | null`（文案見 Global Constraints）
  - `export async function usableConsultantCount(db: Db, projectId: string): Promise<number>`（`projects.ts`）
  - `hireAgent`：rpc 錯誤 `42501` → `HttpError(403, '你不是這個組織的成員')`
  - `resolveRemoteTarget`：select 多取 `org_id`；`db.rpc('org_instance_problem', …)` 非 null → `HttpError(403, '這位顧問已無法使用')`
  - chat route：`usableConsultantCount === 0` 且專案有顧問 → 409 `專案裡的顧問都已無法使用`（在轉送 Sprite 之前）

- [ ] **Step 1: 寫失敗的測試**

- `projects.test.ts`：把 Task 1 的 hire 測試改成斷言 403 `你不是這個組織的成員`；新增 `專案畫面標出無法使用的顧問與原因`：成員租了組織顧問與公開顧問，移出後 `getProjectDetail` 的組織顧問 `unavailable === '你已不是「<組織名>」的成員'`、公開顧問 `unavailable === null`；改成下架時是 `'這位顧問已從「<組織名>」下架'`。
- `remote-mcp.test.ts`：`組織顧問被停用後閘道拒絕`：移出擁有者後 `resolveRemoteTarget` → 403 `這位顧問已無法使用`。
- `chat-route.test.ts`：`顧問都無法使用時不轉送`：唯一的顧問是被停用的組織顧問 → 409 `專案裡的顧問都已無法使用`，`forwardChat` 沒被呼叫（照檔案裡既有的 mock 方式）。

- [ ] **Step 2: 跑測試確認失敗**

Run: `pnpm -F @agenthub/web test test/projects.test.ts test/remote-mcp.test.ts test/chat-route.test.ts`
Expected: FAIL

- [ ] **Step 3: 實作**

- [ ] **Step 4: 跑測試確認通過**

Run: 同 Step 2，Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/services/projects.ts apps/web/lib/services/remote-mcp.ts "apps/web/app/api/threads/[id]/chat/route.ts" apps/web/test/projects.test.ts apps/web/test/remote-mcp.test.ts apps/web/test/chat-route.test.ts
git commit -m "feat: 成員離開或顧問下架後，租用、對話與 MCP 都擋下組織顧問"
```

---

### Task 5: 組織頁面

**Files:**
- Create: `apps/web/app/orgs/page.tsx`（我的組織、建立組織、待處理的邀請）
- Create: `apps/web/app/orgs/[id]/page.tsx`（成員、邀請、待核准、設定、組織的顧問）
- Create: `apps/web/components/orgs/`（`new-org-form.tsx`、`invitation-list.tsx`、`member-list.tsx`、`invite-form.tsx`、`org-settings.tsx`、`org-templates.tsx`）
- Modify: `apps/web/components/nav.tsx`（加「組織」連結；有待處理邀請時顯示數量，例如「組織 (1)」）
- Modify: `apps/web/components/new-template-button.tsx`（可選 `orgId` prop，POST 帶 `org_id`）

**Interfaces:**
- Consumes: Task 2 的 API 與 `listMyOrgs`、`getOrgDetail`、`listMyInvitations`；Task 3 的 `listOrgTemplates`、`/api/templates/:id/review`
- 行為：
  - `/orgs`：列出我的組織（名稱、我的角色）；建立組織表單（名稱、「成員放顧問要管理員核准」勾選框，預設不勾）；待處理邀請（組織名、邀請人、期限）可接受／婉拒，接受後顯示「已送出，等管理員核准」或直接進組織頁。
  - `/orgs/[id]`：非成員 `notFound()`。成員名單（email、角色）；管理員看得到「設為管理員／設為成員」「移出」；每個人都有「退出組織」（確認用頁面上的二次按鈕，不用 `confirm()`）。邀請表單（所有成員）。邀請清單：等對方接受（可撤回）、等核准（管理員可核准／拒絕）、已過期（標示）。設定（管理員）：名稱、核准勾選框。組織的顧問：卡片連到 `/templates/:id`；`editable` 的另有「編輯」連到 `/creator/:id`；管理員看到 `pending` 的有「核准上架／退回」；「在這個組織做一位新顧問」用 `NewTemplateButton orgId`。
  - 樣式沿用既有 `panel`、`chip`、`btn` class 與 `/projects` 頁的結構。

- [ ] **Step 1: 實作頁面與元件**

- [ ] **Step 2: 本機實測**

Run: `pnpm -F @agenthub/web dev`，用兩個臨時 `@test.local` 帳號（用 `seedUser` 的方式建立）在瀏覽器走一次：建立組織 → 一般成員邀請第三人 → 第三人看到「組織 (1)」並接受 → 管理員核准 → 成員退出。
Expected: 每一步畫面都更新正確、沒有 console error

- [ ] **Step 3: typecheck、lint、commit**

Run: `pnpm typecheck && pnpm -F @agenthub/web lint`，Expected: 沒有錯誤

```bash
git add apps/web/app/orgs apps/web/components/orgs apps/web/components/nav.tsx apps/web/components/new-template-button.tsx
git commit -m "feat: 組織頁面：成員、邀請、核准、設定與組織的顧問"
```

---

### Task 6: 範本、市集與專案畫面標示組織

**Files:**
- Modify: `apps/web/app/page.tsx`（登入且有組織時，名冊上方加「我的組織的顧問」區塊，依組織分組，只列 `published`）
- Modify: `apps/web/app/templates/[id]/page.tsx`（組織範本顯示「「<組織名>」組織專用」；`pending` 時 aside 顯示「等管理員核准後才能加入專案」）
- Modify: `apps/web/app/creator/[id]/page.tsx`（改用 `getEditableTemplate`，讓管理員能編輯）
- Modify: `apps/web/app/creator/page.tsx`、`apps/web/components/template-editor.tsx`（狀態 chip 多 `pending`＝「待核准」；組織範本的上架訊息改成「已上架，「<組織名>」的成員都能使用」或「已送出，等管理員核准」；組織範本已上架時多一個「下架」按鈕；「看市集上的樣子」對組織範本改成「看組織成員看到的樣子」）
- Modify: `apps/web/components/workspace/agent-roster.tsx`（`unavailable` 非 null 時名稱旁加 chip「無法使用」，下面一行顯示原因文字）

**Interfaces:**
- Consumes: Task 3 的 `org_id`、`org_name`、`status 'pending'`、`listOrgTemplates`、`unpublishTemplate` API；Task 4 的 `AgentSummary.unavailable`

- [ ] **Step 1: 實作**

- [ ] **Step 2: 本機實測**

Run: `pnpm -F @agenthub/web dev`，臨時帳號：成員在組織建範本並上架 → 市集首頁「我的組織的顧問」看得到、公開名冊沒有 → 租進專案 → 被移出後專案畫面顯示「無法使用」與原因 → 送訊息出現 `專案裡的顧問都已無法使用`。
Expected: 全部符合

- [ ] **Step 3: typecheck、lint、全部測試、commit**

Run: `pnpm typecheck && pnpm -F @agenthub/web lint && pnpm test`，Expected: 全部通過

```bash
git add apps/web/app/page.tsx "apps/web/app/templates/[id]/page.tsx" "apps/web/app/creator/[id]/page.tsx" apps/web/app/creator/page.tsx apps/web/components/template-editor.tsx apps/web/components/workspace/agent-roster.tsx
git commit -m "feat: 市集、範本與專案畫面標示組織顧問與無法使用的原因"
```

---

### Task 7: 上線與正式站驗收

**Files:**
- Create: `apps/web/scripts/e2e-orgs.ts`（照 `scripts/e2e-cloud-folder.ts` 的結構：臨時 `@test.local` 帳號、結束時全刪，包括組織、範本、專案與 Sprite）
- Modify: `CLAUDE.md`（「架構」加一段組織：三張表、`org_instance_problem` 是唯一的判斷點、改規則時要同時看 RLS 與 `resolveRemoteTarget`）、`README.md`（功能清單）

**Interfaces:**
- Consumes: 全部前面的 Task

- [ ] **Step 1: 寫 e2e 腳本**

API 層，對 `BASE_URL`（預設正式站）。步驟與斷言：admin 建組織 → member 經邀請、接受、核准加入 → member 建組織範本（只有 system prompt，不帶 skill 與 MCP）並上架 → outsider `GET /api/templates/<id>` 是 404、`GET /api/templates` 不含它 → member 建專案、租用、等 Sprite ready、送一則訊息，回覆非空 → admin 移出 member → member 再送訊息得到 409 `專案裡的顧問都已無法使用` → admin 重新邀請、member 接受並核准 → 再送訊息成功。印出每一步 PASS／FAIL。

- [ ] **Step 2: 走 `superpowers:finishing-a-development-branch`**

跑 `pnpm test` 確認通過，讓使用者選擇整合方式。選 push 時，push 到 `main` 後 Vercel 自動部署。

- [ ] **Step 3: 跑正式站 e2e**

Run: `cd apps/web && pnpm exec tsx scripts/e2e-orgs.ts`
Expected: 每一步 PASS，臨時資料全部清掉

- [ ] **Step 4: 請使用者在瀏覽器確認畫面**

我登不進正式站看畫面。請使用者用自己的帳號建一個組織，確認導覽列、組織頁、市集的「我的組織的顧問」區塊。

- [ ] **Step 5: 更新 `docs/security-model.md` 第 3 節那一列的狀態為 ✅ 與日期，commit**

```bash
git add apps/web/scripts/e2e-orgs.ts CLAUDE.md README.md docs/security-model.md
git commit -m "docs: 組織功能的架構說明與正式站驗收腳本"
```
