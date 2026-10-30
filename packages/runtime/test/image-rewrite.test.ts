import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { imageFetch, rewriteImageParts } from '../src/image-rewrite';

const KNOWN = Buffer.from('known-image-bytes');
const OTHER = Buffer.from('other-image-bytes');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const urlFor = (h: string) => (h === sha(KNOWN) ? 'https://s.example/object/sign/x?token=t' : undefined);

const body = JSON.stringify({
  contents: [
    { role: 'user', parts: [{ text: '問題' }, { inlineData: { mimeType: 'image/png', data: KNOWN.toString('base64') } }] },
    { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'a.png' } } }] },
    { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { content: '圖片：a.png' }, parts: [
      { inlineData: { mimeType: 'image/png', data: KNOWN.toString('base64') } },
      { inlineData: { mimeType: 'image/jpeg', data: OTHER.toString('base64') } },
    ] } }] },
  ],
});

describe('rewriteImageParts', () => {
  it('工具回傳裡認得的 inlineData 換成 fileData，其他原樣', () => {
    const out = JSON.parse(rewriteImageParts(body, urlFor));
    const parts = out.contents[2].parts[0].functionResponse.parts;
    expect(parts[0]).toEqual({ fileData: { mimeType: 'image/png', fileUri: 'https://s.example/object/sign/x?token=t' } });
    expect(parts[1]).toEqual({ inlineData: { mimeType: 'image/jpeg', data: OTHER.toString('base64') } });
    // 只動工具回傳：使用者訊息裡的 inlineData 不改
    expect(out.contents[0].parts[1].inlineData.data).toBe(KNOWN.toString('base64'));
    expect(out.contents[2].parts[0].functionResponse.response).toEqual({ content: '圖片：a.png' });
  });

  it('沒有可換的就回傳原字串；不是 JSON 原樣回傳', () => {
    expect(rewriteImageParts(body, () => undefined)).toBe(body);
    expect(rewriteImageParts('not json', urlFor)).toBe('not json');
  });
});

describe('imageFetch', () => {
  it('POST 的字串 body 先改寫再交給原本的 fetch；其他請求原樣', async () => {
    const seen: { url: string; body: unknown }[] = [];
    const base = (async (url: string, init?: RequestInit) => {
      seen.push({ url, body: init?.body });
      return new Response('ok');
    }) as typeof fetch;
    const f = imageFetch(urlFor, base);
    await f('https://p.example/models/m:streamGenerateContent', { method: 'POST', body });
    const sent = JSON.parse(String(seen[0].body));
    expect(sent.contents[2].parts[0].functionResponse.parts[0].fileData.fileUri).toBe('https://s.example/object/sign/x?token=t');
    await f('https://p.example/x', { method: 'GET' });
    expect(seen[1].body).toBeUndefined();
  });
});
