import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { consultantRequirements, ensureConsultantEnv } from '../src/requirements';
import { tmpRoots } from './helpers';

type Run = Parameters<typeof ensureConsultantEnv>[0]['run'];

/** 安裝指令照情境假裝成功或失敗；其他指令（寫紀錄檔）真的在 workDir 執行 */
function fakeRun(workDir: string, install: { ok: boolean; stderr?: string }, calls: string[][]): Run {
  return async (argv, input) => {
    calls.push(argv);
    if (argv.join(' ').includes('pip install')) return { code: install.ok ? 0 : 1, stdout: '', stderr: install.stderr ?? '' };
    execFileSync(argv[0], argv.slice(1), { cwd: workDir, input: input ?? '' });
    return { code: 0, stdout: '', stderr: '' };
  };
}

const installs = (calls: string[][]) => calls.filter((c) => c.join(' ').includes('pip install')).length;

async function workDir() {
  const { agentsRoot } = await tmpRoots();
  const dir = path.join(agentsRoot, 'a1');
  await mkdir(dir, { recursive: true });
  return dir;
}

describe('ensureConsultantEnv', () => {
  it('沒有 requirements：不建環境、不執行指令', async () => {
    const dir = await workDir();
    const calls: string[][] = [];
    expect(await ensureConsultantEnv({ workDir: dir, requirements: '', run: fakeRun(dir, { ok: true }, calls) })).toEqual({});
    expect(calls).toEqual([]);
  });

  it('第一次安裝成功回 bin；同一份第二次不再安裝；內容改了重裝', async () => {
    const dir = await workDir();
    const calls: string[][] = [];
    const run = fakeRun(dir, { ok: true }, calls);
    const bin = path.join(dir, '.agenthub-venv', 'bin');
    expect(await ensureConsultantEnv({ workDir: dir, requirements: 'requests==2.32.3\n', run })).toEqual({ bin });
    expect(await ensureConsultantEnv({ workDir: dir, requirements: 'requests==2.32.3\n', run })).toEqual({ bin });
    expect(installs(calls)).toBe(1);
    await ensureConsultantEnv({ workDir: dir, requirements: 'requests==2.31.0\n', run });
    expect(installs(calls)).toBe(2);
  });

  it('安裝失敗回 failure（stderr 摘要）；同一份下次直接回 failure 不重試；改了內容會重試', async () => {
    const dir = await workDir();
    const calls: string[][] = [];
    const failing = fakeRun(dir, { ok: false, stderr: 'ERROR: No matching distribution found for nope' }, calls);
    const first = await ensureConsultantEnv({ workDir: dir, requirements: 'nope\n', run: failing });
    expect(first.bin).toBeUndefined();
    expect(first.failure).toContain('No matching distribution found for nope');
    expect(await ensureConsultantEnv({ workDir: dir, requirements: 'nope\n', run: failing })).toEqual(first);
    expect(installs(calls)).toBe(1);
    const fixed = await ensureConsultantEnv({ workDir: dir, requirements: 'requests\n', run: fakeRun(dir, { ok: true }, calls) });
    expect(fixed.bin).toBeDefined();
    expect(installs(calls)).toBe(2);
  });

  it('安裝以 requirements 內容當 stdin、在 workDir 建 --system-site-packages 的環境', async () => {
    const dir = await workDir();
    const seen: { argv: string[]; input?: string }[] = [];
    await ensureConsultantEnv({
      workDir: dir, requirements: 'numpy\n',
      run: async (argv, input) => { seen.push({ argv, input }); return { code: argv.join(' ').includes('pip install') ? 1 : 0, stdout: '', stderr: 'x' }; },
    });
    const install = seen.find((s) => s.argv.join(' ').includes('pip install'))!;
    expect(install.argv.join(' ')).toContain('python3 -m venv --system-site-packages .agenthub-venv');
    expect(install.input).toBe('numpy\n');
  });
});

describe('consultantRequirements', () => {
  it('依 skill 資料夾名稱排序合併；沒有任何 requirements.txt 回空字串', async () => {
    const { agentsRoot } = await tmpRoots();
    const skills = path.join(agentsRoot, 'skills-x');
    await mkdir(path.join(skills, 'b-skill'), { recursive: true });
    await mkdir(path.join(skills, 'a-skill'), { recursive: true });
    await mkdir(path.join(skills, 'c-skill'), { recursive: true });
    expect(await consultantRequirements(skills)).toBe('');
    await writeFile(path.join(skills, 'b-skill', 'requirements.txt'), 'pandas\n');
    await writeFile(path.join(skills, 'a-skill', 'requirements.txt'), 'numpy');
    expect(await consultantRequirements(skills)).toBe('numpy\npandas\n');
    expect(await consultantRequirements(path.join(agentsRoot, 'no-such-dir'))).toBe('');
  });
});
