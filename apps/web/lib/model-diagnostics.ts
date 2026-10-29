type Part = {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name?: string; args?: unknown };
  functionResponse?: { name?: string; response?: unknown };
  inlineData?: { mimeType?: string; data?: string };
};
type Body = { systemInstruction?: { parts?: Part[] }; tools?: unknown; contents?: { role?: string; parts?: Part[] }[] };

const TOP = 12;

function describePart(p: Part): { kind: string; chars: number } {
  if (p.functionCall) return { kind: `functionCall:${p.functionCall.name}`, chars: JSON.stringify(p.functionCall.args ?? {}).length };
  if (p.functionResponse) return { kind: `functionResponse:${p.functionResponse.name}`, chars: JSON.stringify(p.functionResponse.response ?? {}).length };
  if (p.inlineData) return { kind: `inlineData:${p.inlineData.mimeType}`, chars: p.inlineData.data?.length ?? 0 };
  return { kind: p.thought ? 'thought' : 'text', chars: p.text?.length ?? 0 };
}

/**
 * 模型請求的形狀摘要：每段的角色、類型、工具名與字元數，不含任何內容。
 * 用來查 Vertex 回錯誤（例如 2026-10-30 的「input token count exceeds 32768」）時是哪一段太大。
 */
export function describeRequest(raw: string): string {
  let body: Body;
  try {
    body = JSON.parse(raw) as Body;
  } catch {
    return `[診斷] 請求 ${raw.length} 字元，不是 JSON`;
  }
  const parts = (body.contents ?? []).flatMap((c, i) => (c.parts ?? []).map((p) => ({
    i, role: c.role ?? '?', ...describePart(p), sig: p.thoughtSignature?.length ?? 0,
  })));
  const system = (body.systemInstruction?.parts ?? []).reduce((n, p) => n + (p.text?.length ?? 0), 0);
  const largest = [...parts].sort((a, b) => b.chars + b.sig - (a.chars + a.sig)).slice(0, TOP)
    .map((p) => `#${p.i} ${p.role} ${p.kind} ${p.chars}${p.sig ? ` sig=${p.sig}` : ''}`);
  return `[診斷] 請求 ${raw.length} 字元，${body.contents?.length ?? 0} 個 content、${parts.length} 段；`
    + `systemInstruction ${system}、tools ${JSON.stringify(body.tools ?? []).length}；最大的段：${largest.join('、')}`;
}
