import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * 顧問各自的 Python 套件：創作者在 skill 資料夾放 requirements.txt（上架時已檢查格式與 PyPI），
 * runtime 以該顧問的沙盒帳號建立 <工作目錄>/.agenthub-venv 並安裝，之後顧問的 python3 就是這個環境。
 * 以內容雜湊決定是否重裝：裝過的不重裝；失敗過的同一份也不在每次對話重試（等創作者改了內容再試）。
 */
export type EnvResult = { bin?: string; failure?: string };
type Run = (argv: string[], input?: string) => Promise<{ code: number | null; stdout: string; stderr: string }>;

const VENV = '.agenthub-venv';
const OK_FILE = '.requirements-sha256';
const FAILED_FILE = '.requirements-failed';
/** 安裝在 runtime 開始回應前；Vercel 轉送對話的路由最多等 300 秒，要留時間給對話本身 */
export const INSTALL_TIMEOUT_MS = 180_000;
const SUMMARY_MAX = 2_000;

/** 顧問所有 skill 的 requirements.txt，依 skill 資料夾名稱排序串接；沒有就回空字串 */
export async function consultantRequirements(skillsDir: string): Promise<string> {
  const dirs = await readdir(skillsDir, { withFileTypes: true }).catch(() => []);
  let merged = '';
  for (const d of dirs.filter((x) => x.isDirectory()).map((x) => x.name).sort()) {
    const text = await readFile(path.join(skillsDir, d, 'requirements.txt'), 'utf8').catch(() => null);
    if (text?.trim()) merged += text.endsWith('\n') ? text : `${text}\n`;
  }
  return merged;
}

const read = (file: string) => readFile(file, 'utf8').catch(() => null);

export async function ensureConsultantEnv(opts: { workDir: string; requirements: string; run: Run; timeoutMs?: number }): Promise<EnvResult> {
  const { workDir, requirements, run } = opts;
  if (!requirements.trim()) return {};
  const sha = createHash('sha256').update(requirements).digest('hex');
  const venv = path.join(workDir, VENV);
  const bin = path.join(venv, 'bin');

  if ((await read(path.join(venv, OK_FILE)))?.trim() === sha) return { bin };
  const failed = await read(path.join(venv, FAILED_FILE));
  if (failed && failed.split('\n', 1)[0] === sha) return { failure: failed.slice(sha.length + 1) };

  const timeoutMs = opts.timeoutMs ?? INSTALL_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    run(['bash', '-c', `rm -rf ${VENV} && python3 -m venv --system-site-packages ${VENV} && ${VENV}/bin/pip install --disable-pip-version-check -q -r /dev/stdin`], requirements),
    new Promise<{ code: null; stdout: string; stderr: string }>((resolve) => {
      timer = setTimeout(() => resolve({ code: null, stdout: '', stderr: `安裝超過 ${Math.round(timeoutMs / 1000)} 秒` }), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));

  if (result.code === 0) {
    await run(['bash', '-c', `mkdir -p ${VENV} && rm -f ${VENV}/${FAILED_FILE} && cat > ${VENV}/${OK_FILE}`], sha);
    return { bin };
  }
  const summary = `${result.stderr}${result.stdout}`.trim().slice(-SUMMARY_MAX) || '安裝失敗';
  await run(['bash', '-c', `mkdir -p ${VENV} && rm -f ${VENV}/${OK_FILE} && cat > ${VENV}/${FAILED_FILE}`], `${sha}\n${summary}`);
  return { failure: summary };
}
