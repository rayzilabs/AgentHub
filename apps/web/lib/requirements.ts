import { strFromU8 } from 'fflate';
import type { SkillMeta } from '@/lib/skills-zip';

/**
 * skill 的 requirements.txt：創作者宣告這位顧問需要的 Python 套件，runtime 會裝進顧問自己的虛擬環境。
 * 只接受 PyPI 上的具名套件（不接受選項、網址、本機路徑），上架時確認每個套件與指定版本在 PyPI 存在。
 */
export type Requirement = { name: string; normalized: string; pinned?: string; line: number };

const MAX_LINES = 50;
const MAX_BYTES = 4096;
const PYPI_TIMEOUT_MS = 5_000;
const NAME = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)(\[[A-Za-z0-9._,\s-]+\])?\s*(.*)$/;
const SPEC = /^\s*(==|>=|<=|~=|!=|<|>)\s*([A-Za-z0-9.*+!]+)\s*$/;

/** PEP 503：小寫，連續的 - _ . 視為一個 - */
export const normalizeName = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '-');

export function parseRequirements(text: string): { requirements: Requirement[]; problems: string[] } {
  const clean = text.replace(/^﻿/, '');
  if (new TextEncoder().encode(clean).length > MAX_BYTES) return { requirements: [], problems: [`檔案超過 ${MAX_BYTES} bytes`] };
  const requirements: Requirement[] = [];
  const problems: string[] = [];
  const lines = clean.split(/\r?\n/);
  if (lines.filter((l) => l.trim() && !l.trim().startsWith('#')).length > MAX_LINES) return { requirements: [], problems: [`最多 ${MAX_LINES} 個套件`] };
  lines.forEach((raw, i) => {
    const line = raw.replace(/\s+#.*$/, '').trim();
    const n = i + 1;
    if (!line || line.startsWith('#')) return;
    if (line.startsWith('-')) return problems.push(`第 ${n} 行：不接受 - 開頭的選項（只能寫套件名稱與版本）`);
    if (/:\/\/|@|\//.test(line)) return problems.push(`第 ${n} 行：不接受網址、@ 或本機路徑（只能從 PyPI 安裝）`);
    if (line.includes(';')) return problems.push(`第 ${n} 行：不接受環境標記（;）`);
    const m = NAME.exec(line);
    const specs = m?.[3] ? m[3].split(',').map((s) => SPEC.exec(s)) : [];
    if (!m || specs.some((s) => !s)) return problems.push(`第 ${n} 行：格式不正確，例如 numpy、pandas>=2.0、requests==2.32.3`);
    const exact = specs.length === 1 && specs[0]![1] === '==' ? specs[0]![2] : undefined;
    requirements.push({ name: m[1], normalized: normalizeName(m[1]), line: n, ...(exact ? { pinned: exact } : {}) });
  });
  return { requirements, problems };
}

export async function checkOnPyPI(reqs: Requirement[], fetchImpl: typeof fetch = fetch): Promise<string[]> {
  let unreachable = false;
  const problems = await Promise.all(reqs.map(async (r): Promise<string | null> => {
    try {
      const res = await fetchImpl(`https://pypi.org/pypi/${encodeURIComponent(r.normalized)}/json`, { signal: AbortSignal.timeout(PYPI_TIMEOUT_MS) });
      if (res.status === 404) return `第 ${r.line} 行：PyPI 上找不到套件 ${r.name}`;
      if (!res.ok) { unreachable = true; return null; }
      const body = (await res.json()) as { releases?: Record<string, unknown> };
      if (r.pinned && !(r.pinned in (body.releases ?? {}))) return `第 ${r.line} 行：${r.name} 沒有 ${r.pinned} 這個版本`;
      return null;
    } catch {
      unreachable = true;
      return null;
    }
  }));
  const found = problems.filter((p): p is string => p !== null);
  return unreachable ? [...found, '暫時無法連線 PyPI 檢查套件，請稍後再試'] : found;
}

/** 檢查 zip 裡每個 skill 的 requirements.txt；回傳的問題前綴「<檔案路徑>：」 */
export async function requirementsProblems(files: Record<string, Uint8Array>, skills: SkillMeta[], fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const all: string[] = [];
  for (const skill of skills) {
    const file = skill.path ? `${skill.path}/requirements.txt` : 'requirements.txt';
    if (!files[file]) continue;
    const { requirements, problems } = parseRequirements(strFromU8(files[file]));
    const found = problems.length ? problems : await checkOnPyPI(requirements, fetchImpl);
    all.push(...found.map((p) => `${file}：${p}`));
  }
  return all;
}
