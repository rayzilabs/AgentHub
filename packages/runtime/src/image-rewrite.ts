import { createHash } from 'node:crypto';

type Part = { inlineData?: { mimeType: string; data: string }; functionResponse?: { parts?: Part[] } };
type Body = { contents?: { parts?: Part[] }[] };

/**
 * 模型請求送往平台代理前，把工具回傳（functionResponse.parts）裡認得的圖片換成簽名網址。
 *
 * 為什麼在這裡改：AI SDK 對 Gemini 3＋Vertex 的工具回傳只直接傳 gs:// 網址，https 網址一律先下載成 base64；
 * 每一步又都重送整段歷史，圖片會讓經過 Vercel 的請求超過 4.5 MB。Vertex 本身接受工具回傳裡的 https 網址
 * （會自己下載），模型看到的仍是圖片。認不得的圖片原樣保留。
 */
export function rewriteImageParts(body: string, urlFor: (sha256: string) => string | undefined): string {
  let parsed: Body;
  try {
    parsed = JSON.parse(body) as Body;
  } catch {
    return body;
  }
  let changed = false;
  for (const content of parsed.contents ?? []) {
    for (const part of content.parts ?? []) {
      const inner = part.functionResponse?.parts;
      if (!inner) continue;
      for (let i = 0; i < inner.length; i++) {
        const data = inner[i].inlineData;
        if (!data) continue;
        const url = urlFor(createHash('sha256').update(Buffer.from(data.data, 'base64')).digest('hex'));
        if (!url) continue;
        inner[i] = { fileData: { mimeType: data.mimeType, fileUri: url } } as Part;
        changed = true;
      }
    }
  }
  return changed ? JSON.stringify(parsed) : body;
}

export function imageFetch(urlFor: (sha256: string) => string | undefined, base: typeof fetch = fetch): typeof fetch {
  return (input, init) => {
    if (init?.method === 'POST' && typeof init.body === 'string') {
      return base(input, { ...init, body: rewriteImageParts(init.body, urlFor) });
    }
    return base(input, init);
  };
}
