import { execFileSync } from 'node:child_process';
import { mkdir, utimes, writeFile } from 'node:fs/promises';
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
    // runtime 的子程序 stdin 是 socket：pip 開 /dev/stdin 會 ENXIO（2026-10-31 正式站實測），先由 cat 寫成檔案
    expect(install.argv.join(' ')).not.toContain('/dev/stdin');
    expect(install.argv.join(' ')).toContain('cat > .agenthub-venv/requirements.txt');
    expect(install.argv.join(' ')).toContain('-r .agenthub-venv/requirements.txt');
  });

  it('安裝指令在真的 bash 裡、stdin 不是一般檔案時也讀得到 requirements（不靠開 /dev/stdin）', async () => {
    const dir = await workDir();
    let script = '';
    await ensureConsultantEnv({
      workDir: dir, requirements: 'six\n',
      run: async (argv, input) => {
        if (argv.join(' ').includes('pip install')) script = argv[2];
        void input;
        return { code: 1, stdout: '', stderr: '' };
      },
    });
    // 把 python3 與 pip 換成假的，只驗證 requirements 檔案的內容從 stdin 寫進去
    const fake = script.replace('python3 -m venv --system-site-packages .agenthub-venv', 'mkdir -p .agenthub-venv/bin')
      .replace(/timeout -k 5 \d+ \.agenthub-venv\/bin\/pip install [^&]*-r (\S+)/, 'cat $1');
    const out = execFileSync('bash', ['-c', fake], { cwd: dir, input: 'six\n' }).toString();
    expect(out).toBe('six\n');
  });
});

describe('ensureConsultantEnv：暫時性失敗、逾時與同時安裝', () => {
  it('失敗紀錄超過一小時就重試（網路之類的暫時問題不會永久壞掉）', async () => {
    const dir = await workDir();
    const calls: string[][] = [];
    await ensureConsultantEnv({ workDir: dir, requirements: 'six\n', run: fakeRun(dir, { ok: false, stderr: 'network down' }, calls) });
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(path.join(dir, '.agenthub-venv', '.requirements-failed'), old, old);
    const r = await ensureConsultantEnv({ workDir: dir, requirements: 'six\n', run: fakeRun(dir, { ok: true }, calls) });
    expect(r.bin).toBeDefined();
    expect(installs(calls)).toBe(2);
  });

  it('安裝指令本身帶逾時（逾時會真的終止 pip），逾時的結束碼回報成超過時間', async () => {
    const dir = await workDir();
    const seen: string[] = [];
    const r = await ensureConsultantEnv({
      workDir: dir, requirements: 'scipy\n',
      run: async (argv) => { seen.push(argv.join(' ')); return { code: argv.join(' ').includes('pip install') ? 124 : 0, stdout: '', stderr: '' }; },
    });
    expect(seen.find((c) => c.includes('pip install'))).toContain('timeout -k 5 180 ');
    expect(r.failure).toContain('安裝超過 180 秒');
  });

  it('同一位顧問同時兩個對話：只安裝一次，兩邊拿到同一個結果', async () => {
    const dir = await workDir();
    const calls: string[][] = [];
    const inner = fakeRun(dir, { ok: true }, calls);
    const slow: Run = async (argv, input) => { await new Promise((r) => setTimeout(r, 50)); return inner(argv, input); };
    const [a, b] = await Promise.all([
      ensureConsultantEnv({ workDir: dir, requirements: 'six\n', run: slow }),
      ensureConsultantEnv({ workDir: dir, requirements: 'six\n', run: slow }),
    ]);
    expect(a).toEqual(b);
    expect(a.bin).toBeDefined();
    expect(installs(calls)).toBe(1);
  });
});

describe('consultantRequirements', () => {
  it('依 skill 資料夾名稱排序合併；沒有任何 requirements.txt 回空字串', async () => {
    const { agentsRoot } = await tmpRoots();
    const skills = path.join(agentsRoot, 'skills-x');
    await mkdir(path.join(skills, 'b-skill'), { recursive: true });
    await mkdir(path.join(skills, 'a-skill'), { recursive: true });
    await mkdir(path.join(skills, 'c-skill'), { recursive: true });
    const metas = [{ path: 'b-skill' }, { path: 'a-skill' }, { path: 'c-skill' }];
    expect(await consultantRequirements(skills, metas)).toBe('');
    await writeFile(path.join(skills, 'b-skill', 'requirements.txt'), 'pandas\n');
    await writeFile(path.join(skills, 'a-skill', 'requirements.txt'), 'numpy');
    expect(await consultantRequirements(skills, metas)).toBe('numpy\npandas\n');
    expect(await consultantRequirements(path.join(agentsRoot, 'no-such-dir'), metas)).toBe('');
  });

  it('依 skill 的 path 讀（zip 根目錄、巢狀都和上架檢查一致）；不是 skill 的資料夾不讀', async () => {
    const { agentsRoot } = await tmpRoots();
    const skills = path.join(agentsRoot, 'skills-y');
    await mkdir(path.join(skills, 'pack', 'quant'), { recursive: true });
    await mkdir(path.join(skills, 'tools'), { recursive: true });
    await writeFile(path.join(skills, 'requirements.txt'), 'six\n');
    await writeFile(path.join(skills, 'pack', 'quant', 'requirements.txt'), 'scipy\n');
    await writeFile(path.join(skills, 'tools', 'requirements.txt'), '--index-url https://evil.example\n');
    expect(await consultantRequirements(skills, [{ path: 'pack/quant' }, { path: '' }])).toBe('six\nscipy\n');
  });

  it('每份去掉 UTF-8 BOM、CRLF 換成 LF（合併後 BOM 在中間 pip 會失敗）', async () => {
    const { agentsRoot } = await tmpRoots();
    const skills = path.join(agentsRoot, 'skills-z');
    await mkdir(path.join(skills, 'a'), { recursive: true });
    await mkdir(path.join(skills, 'b'), { recursive: true });
    await writeFile(path.join(skills, 'a', 'requirements.txt'), '﻿numpy\r\n');
    await writeFile(path.join(skills, 'b', 'requirements.txt'), '﻿pandas\r\nsix');
    expect(await consultantRequirements(skills, [{ path: 'a' }, { path: 'b' }])).toBe('numpy\npandas\nsix\n');
  });
});
