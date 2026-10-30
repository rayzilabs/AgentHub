import { createHash } from 'node:crypto';
import type { Db } from './db';

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
export type ImageData = { mediaType: ImageMediaType; bytes: Uint8Array };

export const SIGNED_URL_TTL_S = 3600;
const BUCKET = 'project-files';

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);

/** 依檔頭判斷圖片格式（不看副檔名） */
export function detectImage(head: Uint8Array): ImageMediaType | null {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  if (startsWith(head, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  return null;
}

export const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/**
 * 一個 run 一份：讓 read_file 讀到的共用資料夾圖片能交給模型，又不讓圖片本身塞進經過 Vercel 的請求。
 * read_file 讀到圖片 → resolve 確認與 Storage 上傳版本逐位元組相同才簽網址（顧問可能在共用資料夾放同名檔案）；
 * 送出模型請求前，image-rewrite 用 urlFor 把同一張圖的 inlineData 換成這個網址。
 */
export type ImageRegistry = {
  sharedRoot: string;
  resolve(name: string, bytes: Uint8Array): Promise<string | null>;
  urlFor(sha256: string): string | undefined;
  keep(toolCallId: string, image: ImageData): void;
  imageFor(toolCallId: string): ImageData | undefined;
};

export function createImageRegistry(db: Db, projectId: string, sharedRoot: string): ImageRegistry {
  const urls = new Map<string, string>();
  const images = new Map<string, ImageData>();
  const bucket = db.storage.from(BUCKET);
  return {
    sharedRoot,
    async resolve(name, bytes) {
      const hash = sha256Hex(bytes);
      const known = urls.get(hash);
      if (known) return known;
      const objectPath = `${projectId}/${name}`;
      const { data: blob, error } = await bucket.download(objectPath);
      if (error || !blob || sha256Hex(new Uint8Array(await blob.arrayBuffer())) !== hash) return null;
      const { data, error: signError } = await bucket.createSignedUrl(objectPath, SIGNED_URL_TTL_S);
      if (signError || !data) return null;
      urls.set(hash, data.signedUrl);
      return data.signedUrl;
    },
    urlFor: (hash) => urls.get(hash),
    keep: (id, image) => { images.set(id, image); },
    imageFor: (id) => images.get(id),
  };
}
