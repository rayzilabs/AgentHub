import { execSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
execSync('node scripts/build.mjs', { stdio: 'inherit', cwd: fileURLToPath(new URL('..', import.meta.url)) });

const bundle = await readFile(fileURLToPath(new URL('../dist/main.js', import.meta.url)));
const version = execSync('git rev-parse --short HEAD').toString().trim();
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });

for (const path of ['main.js', `main-${version}.js`]) {
  const { error } = await db.storage.from('runtime').upload(path, bundle, { contentType: 'text/javascript', upsert: true });
  if (error) throw error;
  console.log(`已上傳 runtime/${path}（${bundle.length} bytes）`);
}
