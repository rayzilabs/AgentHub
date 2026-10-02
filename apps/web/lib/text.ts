import type { UIMessage } from 'ai';

export function textOf(m: UIMessage | undefined): string {
  if (!m) return '';
  return m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
}
