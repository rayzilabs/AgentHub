'use client';

import Link from 'next/link';
import { useState } from 'react';
import { FileButton } from '@/components/file-button';
import { HostedMcpPanel } from '@/components/hosted-mcp-panel';
import { api } from '@/lib/client-api';
import { emptyDraft, fromDraft, isSavedHosted, toDraft, type McpDraft } from '@/lib/mcp-draft';
import type { TemplateRow } from '@/lib/services/templates';

export function TemplateEditor({ initial }: { initial: TemplateRow }) {
  const [t, setT] = useState(initial);
  const [mcp, setMcp] = useState<McpDraft[]>(initial.mcp_servers.map(toDraft));
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);

  async function run(label: string, action: () => Promise<TemplateRow>, apply: (updated: TemplateRow) => void): Promise<boolean> {
    setBusy(true);
    setMessage(null);
    try {
      const updated = await action();
      apply(updated);
      setMessage({ kind: 'ok', text: label });
      return true;
    } catch (e) {
      setMessage({ kind: 'error', text: (e as Error).message });
      return false;
    } finally {
      setBusy(false);
    }
  }

  const applyAll = (updated: TemplateRow) => {
    setT(updated);
    setMcp(updated.mcp_servers.map(toDraft));
  };

  const save = () =>
    run('已儲存', () =>
      api<TemplateRow>(`/api/templates/${t.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: t.name, description: t.description, category: t.category, system_prompt: t.system_prompt,
          mcp_servers: mcp.map(fromDraft),
        }),
      }),
      applyAll,
    );

  async function uploadZip(file: File) {
    setUploading(true);
    await run(`已讀取 skill 檔案`, async () => {
      const { signedUrl } = await api<{ signedUrl: string }>(`/api/templates/${t.id}/upload-url`, { method: 'POST' });
      const res = await fetch(signedUrl, { method: 'PUT', body: file, headers: { 'content-type': 'application/zip', 'x-upsert': 'true' } });
      if (!res.ok) throw new Error(`上傳失敗（${res.status}），請再試一次`);
      return api<TemplateRow>(`/api/templates/${t.id}`, { method: 'PATCH', body: JSON.stringify({ process_upload: true }) });
    }, (updated) => setT((p) => ({ ...p, skills: updated.skills, skills_zip_path: updated.skills_zip_path })));
    setUploading(false);
  }

  const publish = async () => {
    if (!(await save())) return;
    await run('已上架，現在大家都能在市集看到這位顧問', () => api<TemplateRow>(`/api/templates/${t.id}/publish`, { method: 'POST' }), applyAll);
  };

  return (
    <div className="space-y-8 pb-4">
      <div className="flex items-center gap-3">
        <h1 className="font-display text-2xl font-bold sm:text-4xl">編輯顧問</h1>
        <span className={`chip ${t.status === 'published' ? 'chip-sage' : ''}`}>{t.status === 'published' ? '已上架' : '草稿'}</span>
      </div>
      <section aria-labelledby="basic-title">
        <h2 id="basic-title" className="group-title">基本資料</h2>
        <div className="panel space-y-5 p-5">
        <label className="block">
          <span className="label">名稱</span>
          <input disabled={busy} className="field" value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} />
        </label>
        <label className="block">
          <span className="label">分類</span>
          <input disabled={busy} className="field" value={t.category} onChange={(e) => setT({ ...t, category: e.target.value })} />
          <span className="hint block">例如：法律、財務、行銷。會顯示在市集卡片上。</span>
        </label>
        <label className="block">
          <span className="label">介紹</span>
          <textarea disabled={busy} className="field" rows={3} value={t.description} onChange={(e) => setT({ ...t, description: e.target.value })} />
          <span className="hint block">顯示在市集，也是主管決定派什麼工作給這位顧問的依據。</span>
        </label>
        <label className="block">
          <span className="label">System prompt</span>
          <textarea disabled={busy} className="field min-h-72 font-mono text-sm" rows={12} value={t.system_prompt} onChange={(e) => setT({ ...t, system_prompt: e.target.value })} />
          <span className="hint block">你的工作方法與 SOP。使用者看不到這段。</span>
        </label>
        </div>
      </section>

      <section aria-labelledby="skill-title">
        <h2 id="skill-title" className="group-title">Skill</h2>
        <div className="panel p-5">
        <p className="text-sm text-muted">上傳一個 zip，裡面每個資料夾放一份 SKILL.md（Claude Code 的 .claude/skills 資料夾直接壓縮即可）。</p>
        <FileButton label="上傳 skill zip" accept=".zip,application/zip" busy={busy} uploading={uploading} className="mt-3" onFile={(f) => void uploadZip(f)} />
        {t.skills.length > 0 ? (
          <ul className="mt-3 space-y-2">
            {t.skills.map((s) => (
              <li key={s.name} className="rounded-xl bg-sunken px-4 py-3">
                <div className="font-medium">{s.name}</div>
                <div className="text-sm text-muted">{s.description}</div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint mt-3">還沒有 skill。沒有也能上架，顧問只靠 system prompt 工作。</p>
        )}
        </div>
      </section>

      <section aria-labelledby="mcp-title">
        <h2 id="mcp-title" className="group-title">工具（MCP）</h2>
        <p className="mb-3 px-1 text-sm text-muted">需要金鑰的工具，租用的人會在加入時填自己的金鑰；交給平台代管的工具，金鑰由你設定。</p>
        <div className="space-y-4">
          {mcp.map((d, i) => {
            const update = (patch: Partial<McpDraft>) => setMcp(mcp.map((x, j) => (j === i ? { ...x, ...patch } : x)));
            return (
              <fieldset key={i} className="panel space-y-3 p-5 [&>legend+*]:clear-left">
                <legend className="float-left w-full text-sm font-medium text-muted">工具 {i + 1}</legend>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block"><span className="label">名稱（英數字）</span>
                    <input disabled={busy} className="field" value={d.name} onChange={(e) => update({ name: e.target.value })} /></label>
                  <label className="block"><span className="label">連線方式</span>
                    <select disabled={busy} className="field" value={d.transport} onChange={(e) => update({ transport: e.target.value as McpDraft['transport'] })}>
                      <option value="stdio">在 agent 電腦上啟動（stdio）</option>
                      <option value="http">連到遠端網址（HTTP）</option>
                      <option value="remote">你自己架的 MCP（經平台閘道）</option>
                      <option value="hosted">交給平台代管（上傳程式）</option>
                    </select></label>
                </div>
                {d.transport === 'stdio' ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block"><span className="label">啟動指令</span>
                      <input disabled={busy} className="field" placeholder="npx" value={d.command} onChange={(e) => update({ command: e.target.value })} /></label>
                    <label className="block"><span className="label">參數（空白分隔）</span>
                      <input disabled={busy} className="field" placeholder="-y some-mcp-server" value={d.args} onChange={(e) => update({ args: e.target.value })} /></label>
                  </div>
                ) : d.transport === 'hosted' ? (
                  isSavedHosted(t.mcp_servers, d.name.trim())
                    ? <HostedMcpPanel templateId={t.id} mcpName={d.name.trim()} />
                    : <p className="hint">
                        先按「儲存」，就能在這裡設定金鑰、上傳程式並部署。
                        {t.status === 'published' && '範本已上架：在這個工具發布第一個版本之前，新加入這位顧問的專案會失敗。'}
                      </p>
                ) : d.transport === 'remote' ? (
                  <label className="block"><span className="label">網址</span>
                    <input disabled={busy} className="field" placeholder="https://..." value={d.url} onChange={(e) => update({ url: e.target.value })} />
                    <span className="mt-1 block text-sm text-muted">租用的人看不到這個網址；平台會帶通行證呼叫，驗證方式見創作者文件。</span></label>
                ) : (
                  <>
                    <label className="block"><span className="label">網址</span>
                      <input disabled={busy} className="field" placeholder="https://..." value={d.url} onChange={(e) => update({ url: e.target.value })} /></label>
                    <label className="block"><span className="label">Headers（每行一個，例如 Authorization: Bearer {'${API_KEY}'}）</span>
                      <textarea disabled={busy} className="field" rows={2} value={d.headers} onChange={(e) => update({ headers: e.target.value })} /></label>
                  </>
                )}
                {d.transport !== 'remote' && d.transport !== 'hosted' && (
                  <label className="block"><span className="label">需要的金鑰名稱（逗號分隔，例如 FINMIND_API_KEY）</span>
                    <input disabled={busy} className="field" value={d.secrets} onChange={(e) => update({ secrets: e.target.value })} /></label>
                )}
                <button type="button" onClick={() => setMcp(mcp.filter((_, j) => j !== i))} className="btn btn-sm -ml-3 text-seal hover:bg-seal/10">移除這個工具</button>
              </fieldset>
            );
          })}
          <button type="button" onClick={() => setMcp([...mcp, { ...emptyDraft }])} className="btn btn-secondary">新增工具</button>
        </div>
      </section>

      <div className="material-surface sticky bottom-3 z-10 rounded-[24px] px-4 py-3 shadow-float">
        {message && (
          <p role={message.kind === 'error' ? 'alert' : 'status'} className={`notice mb-3 max-h-[40vh] overflow-y-auto whitespace-pre-line ${message.kind === 'error' ? 'notice-error' : 'notice-info'}`}>
            {message.text}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <button onClick={save} disabled={busy} className="btn btn-secondary">儲存</button>
          <button onClick={publish} disabled={busy} className="btn btn-primary">
            {t.status === 'published' ? '儲存並更新上架內容' : '儲存並上架'}
          </button>
          {t.status === 'published' && <Link href={`/templates/${t.id}`} className="link ml-auto text-sm">看市集上的樣子</Link>}
        </div>
      </div>
    </div>
  );
}
