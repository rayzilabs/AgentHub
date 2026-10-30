import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { SkillMeta } from './types';

/**
 * 顧問各自的 Python 套件：創作者在 skill 資料夾放 requirements.txt（上架時已檢查格式與 PyPI），
 * runtime 以該顧問的沙盒帳號建立 <工作目錄>/.agenthub-venv 並安裝，之後顧問的 python3 就是這個環境。
 * 以內容雜湊決定是否重裝：裝過的不重裝；失敗過的同一份一小時內不重試（等創作者改內容，或暫時的問題過去）。
 */
export type EnvResult = { bin?: string; failure?: string };
type Run = (argv: string[], input?: string) => Promise<{ code: number | null; stdout: string; stderr: string }>;

const VENV = '.agenthub-venv';
const OK_FILE = '.requirements-sha256';
const FAILED_FILE = '.requirements-failed';
/** 安裝在 runtime 開始回應前；Vercel 轉送對話的路由最多等 300 秒，要留時間給對話本身 */
export const INSTALL_TIMEOUT_S = 180;
/** 網路或 PyPI 暫時出問題時，過了這段時間再試 */
export const FAILED_RETRY_MS = 60 * 60 * 1000;
const SUMMARY_MAX = 2_000;

/** 顧問各 skill 的 requirements.txt（路徑與上架檢查相同），依 skill 路徑排序串接；沒有就回空字串 */
export async function consultantRequirements(skillsDir: string, skills: Pick<SkillMeta, 'path'>[]): Promise<string> {
  let merged = '';
  for (const p of skills.map((s) => s.path).sort()) {
    const raw = await readFile(path.join(skillsDir, p, 'requirements.txt'), 'utf8').catch(() => null);
    // BOM 只有在檔案開頭 pip 才會忽略；合併後會跑到中間，所以逐份去掉
    const text = raw?.replace(/^﻿/, '').replace(/\r\n/g, '\n');
    if (text?.trim()) merged += text.endsWith('\n') ? text : `${text}\n`;
  }
  return merged;
}

const read = (file: string) => readFile(file, 'utf8').catch(() => null);

/** 同一位顧問同時有兩個對話時共用同一次安裝，避免互相 rm -rf */
const inflight = new Map<string, Promise<EnvResult>>();

export function ensureConsultantEnv(opts: { workDir: string; requirements: string; run: Run }): Promise<EnvResult> {
  const pending = inflight.get(opts.workDir);
  if (pending) return pending;
  const p = ensureOnce(opts).finally(() => inflight.delete(opts.workDir));
  inflight.set(opts.workDir, p);
  return p;
}

async function ensureOnce({ workDir, requirements, run }: { workDir: string; requirements: string; run: Run }): Promise<EnvResult> {
  if (!requirements.trim()) return {};
  const sha = createHash('sha256').update(requirements).digest('hex');
  const venv = path.join(workDir, VENV);
  const bin = path.join(venv, 'bin');

  if ((await read(path.join(venv, OK_FILE)))?.trim() === sha) return { bin };
  const failedPath = path.join(venv, FAILED_FILE);
  const failed = await read(failedPath);
  if (failed && failed.split('\n', 1)[0] === sha) {
    const age = Date.now() - (await stat(failedPath)).mtimeMs;
    if (age < FAILED_RETRY_MS) return { failure: failed.slice(sha.length + 1) };
  }

  // timeout 會真的終止 pip（連同它編譯套件的子行程），不留在背景佔記憶體
  const result = await run(
    ['bash', '-c', `rm -rf ${VENV} && python3 -m venv --system-site-packages ${VENV} && timeout -k 5 ${INSTALL_TIMEOUT_S} ${VENV}/bin/pip install --disable-pip-version-check -q -r /dev/stdin`],
    requirements,
  );

  if (result.code === 0) {
    await run(['bash', '-c', `mkdir -p ${VENV} && rm -f ${VENV}/${FAILED_FILE} && cat > ${VENV}/${OK_FILE}`], sha);
    return { bin };
  }
  const summary = result.code === 124
    ? `安裝超過 ${INSTALL_TIMEOUT_S} 秒`
    : `${result.stderr}${result.stdout}`.trim().slice(-SUMMARY_MAX) || '安裝失敗';
  await run(['bash', '-c', `mkdir -p ${VENV} && rm -f ${VENV}/${OK_FILE} && cat > ${VENV}/${FAILED_FILE}`], `${sha}\n${summary}`);
  return { failure: summary };
}
