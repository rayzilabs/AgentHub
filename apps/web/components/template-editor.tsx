'use client';

import Link from 'next/link';
import { useState } from 'react';
import { FileButton } from '@/components/file-button';
import { api } from '@/lib/client-api';
import type { McpServer } from '@/lib/schemas';
import type { TemplateRow } from '@/lib/services/templates';

type McpDraft = {
  name: string;
  transport: 'stdio' | 'http';
  command: string;
  args: string;
  url: string;
  headers: string;
  secrets: string;
};

function toDraft(s: McpServer): McpDraft {
  return {
    name: s.name,
    transport: s.transport,
    command: s.command ?? '',
    args: (s.args ?? []).join(' '),
    url: s.url ?? '',
    headers: Object.entries(s.headers ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n'),
    secrets: (s.required_secrets ?? []).map((r) => r.key).join(', '),
  };
}

function fromDraft(d: McpDraft): McpServer {
  const required_secrets = d.secrets.split(',').map((k) => k.trim()).filter(Boolean).map((key) => ({ key }));
  if (d.transport === 'stdio') {
    return { name: d.name.trim(), transport: 'stdio', command: d.command.trim(), args: d.args.split(/\s+/).filter(Boolean), required_secrets };
  }
  const headers = Object.fromEntries(
    d.headers.split('\n').map((line) => line.split(/:([\s\S]*)/).map((x) => x.trim())).filter(([k, v]) => k && v),
  );
  return { name: d.name.trim(), transport: 'http', url: d.url.trim(), headers, required_secrets };
}

const emptyDraft: McpDraft = { name: '', transport: 'stdio', command: '', args: '', url: '', headers: '', secrets: '' };

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

  const input = 'mt-1 w-full rounded border border-line bg-surface px-3 py-2';

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <label className="block">
          <span className="text-sm text-muted">名稱</span>
          <input disabled={busy} className={input} value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} />
        </label>
        <label className="block">
          <span className="text-sm text-muted">分類（例如：法律、財務、行銷）</span>
          <input disabled={busy} className={input} value={t.category} onChange={(e) => setT({ ...t, category: e.target.value })} />
        </label>
        <label className="block">
          <span className="text-sm text-muted">介紹（顯示在市集，也會讓主管知道該把什麼工作交給這位顧問）</span>
          <textarea disabled={busy} className={input} rows={3} value={t.description} onChange={(e) => setT({ ...t, description: e.target.value })} />
        </label>
        <label className="block">
          <span className="text-sm text-muted">System prompt：你的工作方法與 SOP</span>
          <textarea disabled={busy} className={`${input} font-mono text-sm`} rows={12} value={t.system_prompt} onChange={(e) => setT({ ...t, system_prompt: e.target.value })} />
        </label>
      </section>

      <section>
        <h2 className="font-display text-xl">Skill</h2>
        <p className="text-sm text-muted">上傳一個 zip，裡面每個資料夾放一份 SKILL.md（Claude Code 的 .claude/skills 資料夾直接壓縮即可）。</p>
        <FileButton label="上傳 skill zip" accept=".zip,application/zip" busy={busy} uploading={uploading} className="mt-3" onFile={(f) => void uploadZip(f)} />
        {t.skills.length > 0 && (
          <ul className="mt-3 space-y-1 text-sm">
            {t.skills.map((s) => <li key={s.name}><span className="font-medium">{s.name}</span>：{s.description}</li>)}
          </ul>
        )}
      </section>

      <section>
        <h2 className="font-display text-xl">工具（MCP）</h2>
        <p className="text-sm text-muted">需要金鑰的工具，租用的人會在加入時填自己的金鑰。</p>
        <div className="mt-3 space-y-4">
          {mcp.map((d, i) => {
            const update = (patch: Partial<McpDraft>) => setMcp(mcp.map((x, j) => (j === i ? { ...x, ...patch } : x)));
            return (
              <fieldset key={i} className="space-y-3 rounded border border-line bg-surface p-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block"><span className="text-sm text-muted">名稱（英數字）</span>
                    <input disabled={busy} className={input} value={d.name} onChange={(e) => update({ name: e.target.value })} /></label>
                  <label className="block"><span className="text-sm text-muted">連線方式</span>
                    <select disabled={busy} className={input} value={d.transport} onChange={(e) => update({ transport: e.target.value as McpDraft['transport'] })}>
                      <option value="stdio">在 agent 電腦上啟動（stdio）</option>
                      <option value="http">連到遠端網址（HTTP）</option>
                    </select></label>
                </div>
                {d.transport === 'stdio' ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block"><span className="text-sm text-muted">啟動指令</span>
                      <input disabled={busy} className={input} placeholder="npx" value={d.command} onChange={(e) => update({ command: e.target.value })} /></label>
                    <label className="block"><span className="text-sm text-muted">參數（空白分隔）</span>
                      <input disabled={busy} className={input} placeholder="-y some-mcp-server" value={d.args} onChange={(e) => update({ args: e.target.value })} /></label>
                  </div>
                ) : (
                  <>
                    <label className="block"><span className="text-sm text-muted">網址</span>
                      <input disabled={busy} className={input} placeholder="https://..." value={d.url} onChange={(e) => update({ url: e.target.value })} /></label>
                    <label className="block"><span className="text-sm text-muted">Headers（每行一個，例如 Authorization: Bearer {'${API_KEY}'}）</span>
                      <textarea disabled={busy} className={input} rows={2} value={d.headers} onChange={(e) => update({ headers: e.target.value })} /></label>
                  </>
                )}
                <label className="block"><span className="text-sm text-muted">需要的金鑰名稱（逗號分隔，例如 FINMIND_API_KEY）</span>
                  <input disabled={busy} className={input} value={d.secrets} onChange={(e) => update({ secrets: e.target.value })} /></label>
                <button type="button" onClick={() => setMcp(mcp.filter((_, j) => j !== i))} className="text-sm text-seal underline">移除這個工具</button>
              </fieldset>
            );
          })}
          <button type="button" onClick={() => setMcp([...mcp, { ...emptyDraft }])} className="rounded border border-line px-3 py-1 hover:border-ink">新增工具</button>
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-6">
        <button onClick={save} disabled={busy} className="rounded border border-line px-4 py-2 hover:border-ink disabled:opacity-60">儲存</button>
        <button onClick={publish} disabled={busy} className="rounded bg-brand px-4 py-2 text-white disabled:opacity-60">
          {t.status === 'published' ? '儲存並更新上架內容' : '儲存並上架'}
        </button>
        {t.status === 'published' && <Link href={`/templates/${t.id}`} className="text-brand underline">看市集上的樣子</Link>}
        {message && (
          <p role={message.kind === 'error' ? 'alert' : 'status'} className={`w-full whitespace-pre-line text-sm ${message.kind === 'error' ? 'text-seal' : 'text-muted'}`}>
            {message.text}
          </p>
        )}
      </div>
    </div>
  );
}
