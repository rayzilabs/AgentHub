import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { TemplateInputSchema, type TemplateInput } from '@/lib/schemas';

export type DemoAgent = { slug: string; input: TemplateInput; skillsZip: Uint8Array };

const DEFAULT_ROOT = fileURLToPath(new URL('../demo/agents', import.meta.url));

async function collect(dir: string, prefix = ''): Promise<Record<string, Uint8Array>> {
  const out: Record<string, Uint8Array> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(out, await collect(full, rel));
    else out[rel] = new Uint8Array(await readFile(full));
  }
  return out;
}

export async function loadDemoAgents(root = DEFAULT_ROOT): Promise<DemoAgent[]> {
  const slugs = (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  return Promise.all(
    slugs.map(async (slug) => {
      const dir = path.join(root, slug);
      const input = TemplateInputSchema.parse(JSON.parse(await readFile(path.join(dir, 'agent.json'), 'utf8')));
      const skillsZip = zipSync(await collect(path.join(dir, 'skills')));
      return { slug, input, skillsZip };
    }),
  );
}
