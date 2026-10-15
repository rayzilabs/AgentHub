import { env } from '@/lib/env';
import { HttpError } from '@/lib/http';
import type { Db } from '@/lib/supabase/admin';

/** edgeToken：平台代管時用來通過 Fly 驗證的 Sprites token（Fly 驗證後就拿掉，不會到達創作者的程式） */
export type RemoteTarget = { url: string; templateId: string | null; creatorId: string | null; edgeToken?: string };

/** 找出顧問鎖定的創作者 MCP 網址；顧問不存在、不屬於這個專案或沒有這個 MCP 時拒絕 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resolveRemoteTarget(db: Db, instanceId: string, mcpName: string, projectId: string): Promise<RemoteTarget> {
  if (!UUID.test(instanceId)) throw new HttpError(404, '找不到這位顧問');
  const { data: inst, error } = await db
    .from('agent_instances')
    .select('project_id, role, template_id, template:agent_templates(creator_id)')
    .eq('id', instanceId)
    .maybeSingle();
  if (error) throw error;
  if (!inst || inst.role !== 'consultant') throw new HttpError(404, '找不到這位顧問');
  if (inst.project_id !== projectId) throw new HttpError(403, '這位顧問不屬於這個專案');
  const { data: target, error: targetError } = await db
    .from('remote_mcp_targets')
    .select('kind, url, hosted_version_id')
    .eq('instance_id', instanceId)
    .eq('mcp_name', mcpName)
    .maybeSingle();
  if (targetError) throw targetError;
  const template = inst.template as { creator_id?: string } | null;
  const base = { templateId: inst.template_id as string | null, creatorId: template?.creator_id ?? null };
  if (target?.kind === 'hosted' && target.hosted_version_id) {
    const { data: version, error: versionError } = await db
      .from('hosted_mcp_versions')
      .select('status, sprite_url')
      .eq('id', target.hosted_version_id)
      .maybeSingle();
    if (versionError) throw versionError;
    if (version?.status === 'disabled') throw new HttpError(503, '這個工具服務已被暫停');
    // 租用時鎖定的是已發布版本；之後只會變成下架或停用
    if (!version || !['published', 'ready'].includes(version.status) || !version.sprite_url) {
      throw new HttpError(404, '找不到這個工具服務');
    }
    return { ...base, url: `${version.sprite_url}/mcp`, edgeToken: env.spritesToken };
  }
  if (!target || target.kind !== 'self' || !target.url) throw new HttpError(404, '找不到這個工具服務');
  return { ...base, url: target.url };
}

/** JSON-RPC 本文是 tools/call 時回傳工具名稱（批次取第一個），其餘回傳 null */
export function toolCallName(body: string | undefined): string | null {
  if (!body) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const call = list.find((m) => (m as { method?: unknown } | null)?.method === 'tools/call') as
      | { params?: { name?: unknown } }
      | undefined;
    return typeof call?.params?.name === 'string' ? call.params.name : null;
  } catch {
    return null;
  }
}

/** 只轉 MCP 需要的請求標頭；請求方的 cookie、Authorization 等一律不轉 */
const FORWARD = ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id', 'mcp-method', 'mcp-name'];
const HOP_BY_HOP = new Set(['connection', 'content-length', 'transfer-encoding', 'keep-alive', 'content-encoding']);
/** 判斷工具是否失敗時最多看這麼多字，避免大回應占用記憶體 */
const MAX_INSPECT = 1_000_000;

function rpcFailed(text: string): boolean {
  const trimmed = text.trim();
  const payloads = trimmed.startsWith('{') || trimmed.startsWith('[')
    ? [trimmed]
    : trimmed.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
  for (const p of payloads) {
    try {
      const parsed: unknown = JSON.parse(p);
      for (const m of Array.isArray(parsed) ? parsed : [parsed]) {
        const msg = m as { error?: unknown; result?: { isError?: unknown } } | null;
        if (msg?.error || msg?.result?.isError === true) return true;
      }
    } catch {
      // 不是 JSON（或被截斷）就不當成失敗
    }
  }
  return false;
}

const WAKING = new Set([502, 503]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 把 MCP 請求轉給創作者，回應以串流原樣傳回。
 * onEnd 在回應結束時才呼叫（含串流時間與工具是否回報錯誤）；呼叫端自己中途取消時不呼叫。
 * opts.edgeToken：Authorization 改用它（平台代管的 Sprite），創作者通行證只放 X-AgentHub-Token。
 * opts.retries：休眠中的代管 Sprite 喚醒時可能先回 502／503，重試這麼多次。
 */
export async function forwardToCreator(
  req: Request,
  body: string | undefined,
  url: string,
  token: string,
  onEnd?: (ok: boolean) => Promise<void>,
  opts: { edgeToken?: string; retries?: number; retryDelayMs?: number } = {},
): Promise<Response> {
  const headers = new Headers();
  req.headers.forEach((v, k) => {
    if (FORWARD.includes(k) || k.startsWith('mcp-param-')) headers.set(k, v);
  });
  headers.set('x-agenthub-token', token);
  headers.set('authorization', `Bearer ${opts.edgeToken ?? token}`);

  let upstream: Response;
  try {
    // 不跟隨轉址：避免帶著通行證被導到 http 或其他主機
    upstream = await fetch(url, { method: req.method, headers, body, signal: req.signal, redirect: 'manual' });
    for (let i = 0; i < (opts.retries ?? 0) && WAKING.has(upstream.status) && !req.signal.aborted; i++) {
      await upstream.body?.cancel();
      await sleep(opts.retryDelayMs ?? 1000);
      upstream = await fetch(url, { method: req.method, headers, body, signal: req.signal, redirect: 'manual' });
    }
  } catch {
    if (!req.signal.aborted) await onEnd?.(false);
    throw new HttpError(502, '工具服務無法連線');
  }
  if (upstream.status >= 300 && upstream.status < 400) {
    await upstream.body?.cancel();
    await onEnd?.(false);
    throw new HttpError(502, '工具服務不能轉址');
  }

  const out = new Headers();
  upstream.headers.forEach((v, k) => {
    if (!HOP_BY_HOP.has(k)) out.set(k, v);
  });
  if (!onEnd || !upstream.body) {
    await onEnd?.(upstream.ok);
    return new Response(upstream.body, { status: upstream.status, headers: out });
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (cancelled) return;
        if (done) {
          // 先記用量再結束串流：串流結束後 Vercel 可能隨即停止這個函式
          await onEnd(upstream.ok && !rpcFailed(text));
          controller.close();
          return;
        }
        if (text.length < MAX_INSPECT) text += decoder.decode(value, { stream: true });
        controller.enqueue(value);
      } catch (e) {
        if (cancelled) return;
        if (!req.signal.aborted) await onEnd(false);
        controller.error(e);
      }
    },
    cancel(reason) {
      cancelled = true;
      return reader.cancel(reason);
    },
  });
  return new Response(stream, { status: upstream.status, headers: out });
}

export type UsageRow = {
  project_id: string;
  instance_id: string;
  template_id: string | null;
  creator_id: string | null;
  mcp_name: string;
  tool: string;
  ok: boolean;
  duration_ms: number;
};

export async function recordUsage(db: Db, row: UsageRow): Promise<void> {
  const { error } = await db.from('mcp_usage').insert(row);
  if (error) throw error;
}
