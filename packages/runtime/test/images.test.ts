import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createImageRegistry, detectImage } from '../src/images';
import { createSandbox } from '../src/sandbox';
import { readFileTool } from '../src/tools/files';
import { seedProject, seedUser, testDb, tmpRoots } from './helpers';

const db = testDb();
const local = createSandbox();
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3, 4]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const opts = (toolCallId: string) => ({ toolCallId, messages: [] }) as never;
type ReadTool = ReturnType<typeof readFileTool>;
const run = async (t: ReadTool, p: string, id: string) => (await t.execute!({ path: p }, opts(id))) as { content: string };

async function setup(name = 'shot.png', bytes: Uint8Array = PNG) {
  const projectId = await seedProject(db, await seedUser(db));
  const { sharedRoot, agentsRoot } = await tmpRoots();
  await mkdir(sharedRoot, { recursive: true });
  await writeFile(path.join(sharedRoot, name), bytes);
  const { error } = await db.storage.from('project-files').upload(`${projectId}/${name}`, Buffer.from(bytes), { contentType: 'image/png' });
  if (error) throw error;
  return { projectId, sharedRoot, agentsRoot, images: createImageRegistry(db, projectId, sharedRoot) };
}

describe('detectImage', () => {
  it('依檔頭判斷格式', () => {
    expect(detectImage(PNG)).toBe('image/png');
    expect(detectImage(JPEG)).toBe('image/jpeg');
    expect(detectImage(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(detectImage(new TextEncoder().encode('GIF89a'))).toBe('image/gif');
    expect(detectImage(new TextEncoder().encode('hello world'))).toBeNull();
  });
});

describe('ImageRegistry.resolve', () => {
  it('與 Storage 相同才回簽名網址，urlFor 用雜湊查得到；內容不同回 null', async () => {
    const { images } = await setup();
    const url = await images.resolve('shot.png', PNG);
    expect(url).toContain('/object/sign/project-files/');
    expect(images.urlFor(sha(PNG))).toBe(url);
    const changed = PNG.slice();
    changed[19] = 9;
    expect(await images.resolve('shot.png', changed)).toBeNull();
    // 快取以內容雜湊為準（同內容已確認與 Storage 一致）；Storage 上沒有的內容才回 null
    expect(await images.resolve('nope.png', JPEG)).toBeNull();
  });
});

describe('read_file 讀圖片', () => {
  it('共用資料夾裡與上傳版本相同的圖片：execute 只回文字，toModelOutput 帶圖片', async () => {
    const { sharedRoot, images } = await setup();
    const t = readFileTool(sharedRoot, local, images);
    const out = await run(t, path.join(sharedRoot, 'shot.png'), 'c1');
    expect(out).toEqual({ content: `圖片：shot.png（image/png，${PNG.length} bytes）` });
    const model = await t.toModelOutput!({ toolCallId: 'c1', input: { path: 'x' }, output: out } as never);
    expect(model.type).toBe('content');
    const parts = (model as { value: { type: string; mediaType?: string; data?: { type: string; data: Uint8Array } }[] }).value;
    expect(parts[0]).toEqual({ type: 'text', text: out.content });
    expect(parts[1].mediaType).toBe('image/png');
    expect(Buffer.from(parts[1].data!.data).equals(Buffer.from(PNG))).toBe(true);
  });

  it('同名但內容被換掉的圖片：無法檢視', async () => {
    const { sharedRoot, images } = await setup();
    await writeFile(path.join(sharedRoot, 'shot.png'), JPEG);
    expect((await run(readFileTool(sharedRoot, local, images), path.join(sharedRoot, 'shot.png'), 'c2')).content).toContain('無法檢視');
  });

  it('工作目錄裡的圖片（不在共用資料夾）：無法檢視', async () => {
    const { agentsRoot, images } = await setup();
    const dir = path.join(agentsRoot, 'a1');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'chart.png'), PNG);
    expect((await run(readFileTool(dir, local, images), 'chart.png', 'c3')).content).toContain('無法檢視');
  });

  it('超過 20 MB 的圖片：無法檢視', async () => {
    const { sharedRoot, images } = await setup();
    const big = new Uint8Array(20 * 1024 * 1024 + 1);
    big.set(PNG);
    await writeFile(path.join(sharedRoot, 'big.png'), big);
    expect((await run(readFileTool(sharedRoot, local, images), path.join(sharedRoot, 'big.png'), 'c4')).content).toContain('無法檢視');
  });

  it('沒有提供 images 時，圖片也回無法檢視；文字檔照舊', async () => {
    const { sharedRoot } = await setup();
    await writeFile(path.join(sharedRoot, 'a.txt'), '你好');
    const t = readFileTool(sharedRoot, local);
    expect((await run(t, path.join(sharedRoot, 'shot.png'), 'c5')).content).toContain('無法檢視');
    expect(await run(t, path.join(sharedRoot, 'a.txt'), 'c6')).toEqual({ content: '你好' });
  });
});
