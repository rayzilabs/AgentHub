import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { strToU8, zipSync } from 'fflate';

// 雲端資料夾端到端驗證（規格 docs/superpowers/specs/2026-11-03-cloud-folder-design.md §5）：
// 上傳中文檔名 → 單一顧問交付 → 下載 → 改名搬移後舊 id 照樣下載 → 多顧問派工交付、顧問讀得到 /shared
// → 刪除後回「檔案已刪除」→ 刪專案後 storage 清空。結束時刪掉專案、Sprite 與測試帳號。
// 用法：BASE_URL=https://… pnpm exec tsx scripts/e2e-cloud-folder.ts（預設 http://localhost:3000）
process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false } });

const email = `e2e-cloud-${randomUUID()}@test.local`;
const password = `e2e-${randomUUID()}`;
const { data: created, error: createError } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
if (createError) throw createError;
const userId = created.user.id;

const results: { check: string; pass: boolean; detail: string }[] = [];
const record = (check: string, pass: boolean, detail = '') => {
  results.push({ check, pass, detail: detail.slice(0, 300) });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${check}${pass || !detail ? '' : `\n      ${detail.slice(0, 300)}`}`);
};

type Part = { type: string; text?: string; state?: string; input?: unknown; output?: unknown };
type Message = { role: string; parts: Part[] };
type FileRow = { id: string; folder_id: string; name: string; size: number; source: string };
type FolderRow = { id: string; parent_id: string | null; name: string };
type Delivered = { file_id: string; name: string; folder: string; size: number };

let projectId: string | undefined;
let authHeaders: Record<string, string> = {};
try {
  const anon = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false } });
  const { data: session, error: signInError } = await anon.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;
  const auth = { authorization: `Bearer ${session.session!.access_token}`, 'content-type': 'application/json' };
  authHeaders = auth;

  const raw = (path: string, init: RequestInit = {}) => fetch(`${BASE}${path}`, { ...init, headers: { ...auth, ...(init.headers ?? {}) } });
  const call = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const res = await raw(path, init);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status} ${JSON.stringify(body)}`);
    return body as T;
  };
  const tree = () => call<{ folders: FolderRow[]; files: FileRow[] }>(`/api/projects/${projectId}/files`);
  const folderPath = (folders: FolderRow[], id: string): string => {
    const f = folders.find((x) => x.id === id);
    return !f ? '' : f.parent_id ? `${folderPath(folders, f.parent_id)}/${f.name}` : f.name;
  };
  const download = async (fileId: string) => {
    const res = await raw(`/api/files/${fileId}/download`);
    const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
    if (!res.ok) return { status: res.status, error: body.error ?? '' };
    const file = await fetch(body.url!);
    return { status: res.status, text: await file.text(), disposition: file.headers.get('content-disposition') ?? '' };
  };

  const publish = async (name: string, prompt: string) => {
    const t = await call<{ id: string }>('/api/templates', {
      method: 'POST',
      body: JSON.stringify({ name, description: `${name}（雲端資料夾 e2e）`, system_prompt: prompt }),
    });
    const { signedUrl } = await call<{ signedUrl: string }>(`/api/templates/${t.id}/upload-url`, { method: 'POST' });
    const zip = zipSync({ 'note/SKILL.md': strToU8('---\nname: note\ndescription: 寫報告的格式\n---\n\n標題一行，內容條列。\n') });
    const put = await fetch(signedUrl, { method: 'PUT', body: zip, headers: { 'content-type': 'application/zip', 'x-upsert': 'true' } });
    if (!put.ok) throw new Error(`上傳 skill 失敗 ${put.status}`);
    await call(`/api/templates/${t.id}`, { method: 'PATCH', body: JSON.stringify({ process_upload: true }) });
    await call(`/api/templates/${t.id}/publish`, { method: 'POST' });
    return t.id;
  };

  const chat = async (text: string): Promise<{ messages: Message[]; error: string | null }> => {
    const thread = await call<{ id: string }>(`/api/projects/${projectId}/threads`, { method: 'POST', body: JSON.stringify({}) });
    const res = await raw(`/api/threads/${thread.id}/chat`, { method: 'POST', body: JSON.stringify({ text }) });
    if (!res.ok) throw new Error(`chat → ${res.status} ${await res.text()}`);
    await res.text();
    for (let i = 0; ; i++) {
      const m = await call<{ messages: Message[]; running: boolean; error: string | null }>(`/api/threads/${thread.id}/messages`);
      if (!m.running) return m;
      if (i > 300) throw new Error('等待回覆逾時');
      await new Promise((r) => setTimeout(r, 3000));
    }
  };
  const toolParts = (m: Message | undefined, tool: string) => (m?.parts ?? []).filter((p) => p.type === `tool-${tool}` || (p.type === 'dynamic-tool' && (p as { toolName?: string }).toolName === tool));

  console.log(`雲端資料夾 e2e 目標：${BASE}`);
  const writerId = await publish('報告顧問', [
    '你是報告顧問。使用者要你產出檔案時：用 bash 把內容寫進工作目錄的檔案，再用 deliver_file 交付，',
    'folder 與 name 照使用者指定。交付後在回覆裡寫出交付的路徑與檔名。回覆要簡短。',
  ].join(''));
  const reviewerId = await publish('審閱顧問', [
    '你是審閱顧問。要你列出共用資料夾的檔案時，用 bash 執行 ls -R /workspace/shared，把完整輸出貼在回覆裡；',
    '要你交付檔案時，先寫進工作目錄再用 deliver_file 交付，folder 與 name 照指示。回覆要簡短。',
  ].join(''));

  const project = await call<{ id: string }>('/api/projects', { method: 'POST', body: JSON.stringify({ name: '雲端資料夾 e2e' }) });
  projectId = project.id;
  const start = Date.now();
  for (let i = 0; ; i++) {
    const d = await call<{ project: { sprite_status: string; sprite_error: string | null } }>(`/api/projects/${projectId}`);
    if (d.project.sprite_status === 'ready') break;
    if (d.project.sprite_status === 'error') throw new Error(`環境準備失敗：${d.project.sprite_error}`);
    if (i > 100) throw new Error('環境準備逾時');
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log(`環境就緒（${Math.round((Date.now() - start) / 1000)} 秒）`);

  // ---- 1. 使用者上傳中文檔名，放進「我上傳的」 ----
  const upload = await call<{ fileId: string; signedUrl: string }>(`/api/projects/${projectId}/files/upload-url`, { method: 'POST' });
  const csv = '姓名,金額\n王小明,100\n李小華,200\n陳大文,300\n';
  const put = await fetch(upload.signedUrl, { method: 'PUT', body: csv, headers: { 'content-type': 'text/csv', 'x-upsert': 'true' } });
  const uploaded = await call<FileRow>(`/api/projects/${projectId}/files`, {
    method: 'POST', body: JSON.stringify({ fileId: upload.fileId, folderId: null, name: '客戶名單 2026.csv' }),
  });
  let t = await tree();
  record('上傳中文檔名後放進「我上傳的」', put.ok && uploaded.name === '客戶名單 2026.csv'
    && folderPath(t.folders, uploaded.folder_id) === '我上傳的', JSON.stringify(uploaded));

  // ---- 2. 單一顧問：讀共用資料夾的檔案、交付到子資料夾 ----
  await call(`/api/projects/${projectId}/agents`, { method: 'POST', body: JSON.stringify({ template_id: writerId }) });
  const solo = await chat([
    '請用 bash 數 /workspace/shared/我上傳的/客戶名單 2026.csv 有幾行資料（不含標題），',
    '把「資料筆數：N」寫成 markdown，用 deliver_file 交付，folder 用 2026-W45，name 用 客戶摘要.md。',
  ].join(''));
  const soloFinal = solo.messages.at(-1);
  const delivered = toolParts(soloFinal, 'deliver_file').map((p) => p.output as Delivered | { error: string } | undefined)
    .find((o): o is Delivered => !!o && typeof (o as Delivered).file_id === 'string');
  record('單一顧問的回覆裡有交付的檔案（下載按鈕的資料）', !solo.error && !!delivered
    && delivered.name === '客戶摘要.md' && delivered.folder === '報告顧問/2026-W45',
    JSON.stringify({ error: solo.error, delivered, tools: soloFinal?.parts.map((p) => p.type) }));
  t = await tree();
  const reportRow = t.files.find((f) => f.id === delivered?.file_id);
  record('交付的檔案出現在雲端資料夾「報告顧問/2026-W45」、來源是顧問', !!reportRow && reportRow.source === 'agent'
    && folderPath(t.folders, reportRow.folder_id) === '報告顧問/2026-W45', JSON.stringify(reportRow));
  const d1 = delivered ? await download(delivered.file_id) : { status: 0, text: '' };
  record('下載交付的檔案：內容讀得到使用者上傳的資料（3 筆）', d1.status === 200 && 'text' in d1 && /3/.test(d1.text ?? ''), JSON.stringify(d1));

  // ---- 3. 改名、搬移後，舊回覆的 file_id 照樣下載 ----
  if (delivered) {
    await call(`/api/projects/${projectId}/files/${delivered.file_id}`, { method: 'PATCH', body: JSON.stringify({ name: '客戶摘要（改名）.md' }) });
    const mine = t.folders.find((f) => f.name === '我上傳的' && f.parent_id === null)!;
    await call(`/api/projects/${projectId}/files/${delivered.file_id}`, { method: 'PATCH', body: JSON.stringify({ folderId: mine.id }) });
    const d2 = await download(delivered.file_id);
    t = await tree();
    const moved = t.files.find((f) => f.id === delivered.file_id);
    record('改名並搬到「我上傳的」後，原本的下載按鈕（同一個 id）照樣能下載、檔名是新的', d2.status === 200
      && moved?.name === '客戶摘要（改名）.md' && folderPath(t.folders, moved.folder_id) === '我上傳的'
      && 'disposition' in d2 && decodeURIComponent(d2.disposition ?? '').includes('客戶摘要（改名）.md'), JSON.stringify({ d2, moved }));
  }

  // ---- 4. 多顧問：主管派工，顧問讀得到雲端資料夾的新結構並交付 ----
  await call(`/api/projects/${projectId}/agents`, { method: 'POST', body: JSON.stringify({ template_id: reviewerId }) });
  const multi = await chat([
    '請只派工給審閱顧問，不要開討論：請他用 ls -R 列出 /workspace/shared 的完整內容貼在回覆裡，',
    '並把同樣的清單寫成檔案，用 deliver_file 交付，folder 用 審查，name 用 共用資料夾清單.txt。',
  ].join(''));
  const multiFinal = multi.messages.at(-1);
  const delegations = toolParts(multiFinal, 'assign_task').map((p) => p.output as { files?: Delivered[]; message?: Message } | undefined);
  const delegatedFiles = delegations.flatMap((o) => o?.files ?? []);
  const delegatedText = delegations.map((o) => (o?.message?.parts ?? []).map((p) => p.text ?? '').join('')).join('\n');
  record('多顧問：派工卡片帶出交付的檔案', !multi.error && delegatedFiles.some((f) => f.name === '共用資料夾清單.txt' && f.folder === '審閱顧問/審查'),
    JSON.stringify({ error: multi.error, delegatedFiles, tools: multiFinal?.parts.map((p) => p.type) }));
  const listing = delegatedFiles[0] ? await download(delegatedFiles[0].file_id) : { status: 0, text: '' };
  const listText = `${delegatedText}\n${'text' in listing ? listing.text ?? '' : ''}`;
  record('顧問在 /workspace/shared 讀得到同步後的結構（改名搬移後的檔案、各顧問資料夾）',
    listText.includes('我上傳的') && listText.includes('客戶摘要（改名）.md') && listText.includes('客戶名單 2026.csv') && !listText.includes('2026-W45/客戶摘要.md'),
    listText.slice(0, 300));

  // ---- 5. 刪除後，舊回覆的按鈕回「檔案已刪除」 ----
  if (delivered) {
    await call(`/api/projects/${projectId}/files/${delivered.file_id}`, { method: 'DELETE' });
    const d3 = await download(delivered.file_id);
    record('刪除後下載回 404「檔案已刪除」', d3.status === 404 && 'error' in d3 && d3.error === '檔案已刪除', JSON.stringify(d3));
  }

  // ---- 6. 刪專案後 storage 清空 ----
  const deleteRes = await raw(`/api/projects/${projectId}`, { method: 'DELETE' });
  const deletedId = projectId;
  projectId = undefined;
  const left = await admin.storage.from('project-files').list(deletedId, { limit: 100 });
  const leftFiles = await admin.storage.from('project-files').list(`${deletedId}/files`, { limit: 100 });
  record('刪除專案後 storage 沒有殘留', deleteRes.ok && (left.data ?? []).length === 0 && (leftFiles.data ?? []).length === 0,
    JSON.stringify({ status: deleteRes.status, left: left.data?.map((o) => o.name), files: leftFiles.data?.map((o) => o.name) }));

  for (const id of [writerId, reviewerId]) await admin.from('agent_templates').delete().eq('id', id);
} finally {
  // 中途失敗時照樣刪專案（會先刪 Sprite）；刪不掉就印出來，避免刪掉使用者後找不到它
  if (projectId) {
    const res = await fetch(`${BASE}/api/projects/${projectId}`, { method: 'DELETE', headers: authHeaders }).catch((e: unknown) => e);
    if (!(res instanceof Response && res.ok)) console.error(`⚠ 刪除專案失敗，請手動刪除 Sprite agenthub-${projectId}`);
  }
  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) console.error(`⚠ 刪除測試使用者 ${email} 失敗：${error.message}`);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} 通過`);
if (failed.length) process.exit(1);
