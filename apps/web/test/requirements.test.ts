import { strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { checkOnPyPI, parseRequirements, requirementsProblems } from '@/lib/requirements';

const pypi = (async (url: string | URL | Request) => {
  const u = String(url);
  if (u.includes('/nope/')) return new Response('', { status: 404 });
  return Response.json({ releases: { '2.31.0': [], '2.32.3': [] } });
}) as typeof fetch;

describe('parseRequirements', () => {
  it('接受名稱、extras、版本條件、註解、空行、CRLF、BOM；名稱照 PEP 503 正規化', () => {
    const r = parseRequirements('﻿# 註解\r\nnumpy\r\nPandas>=2.0,<3\r\nrequests[socks]==2.32.3\r\nscikit_learn\r\n\r\n');
    expect(r.problems).toEqual([]);
    expect(r.requirements.map((x) => [x.normalized, x.pinned ?? null, x.line])).toEqual([
      ['numpy', null, 2], ['pandas', null, 3], ['requests', '2.32.3', 4], ['scikit-learn', null, 5],
    ]);
  });

  it('拒絕選項、網址、@、路徑、環境標記，並指出行號', () => {
    for (const bad of ['-e git+https://x/y.git', '--index-url https://x', 'pkg @ https://x/p.whl', './local', 'pkg; python_version<"3.8"', 'git+https://x/y', 'numpy===1']) {
      expect(parseRequirements(`numpy\n${bad}`).problems[0]).toMatch(/^第 2 行/);
    }
  });

  it('超過 50 行或 4096 bytes 拒絕', () => {
    expect(parseRequirements(Array.from({ length: 51 }, (_, i) => `p${i}`).join('\n')).problems[0]).toContain('50');
    expect(parseRequirements(`p${'x'.repeat(4100)}`).problems[0]).toContain('4096');
  });
});

describe('checkOnPyPI', () => {
  it('存在的套件與版本沒有問題；不存在的套件、不存在的版本各自回報', async () => {
    expect(await checkOnPyPI(parseRequirements('requests==2.32.3\nnumpy').requirements, pypi)).toEqual([]);
    expect((await checkOnPyPI(parseRequirements('nope').requirements, pypi))[0]).toContain('PyPI 上找不到');
    expect((await checkOnPyPI(parseRequirements('requests==9.9.9').requirements, pypi))[0]).toContain('9.9.9');
  });

  it('連不上 PyPI：請創作者稍後再試', async () => {
    const down = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
    expect((await checkOnPyPI(parseRequirements('requests').requirements, down))[0]).toContain('稍後再試');
  });
});

describe('requirementsProblems', () => {
  it('問題前綴 skill 名稱與檔名；沒有 requirements.txt 的 skill 不檢查', async () => {
    const files = {
      'calc/SKILL.md': strToU8('---\nname: calc\ndescription: d\n---\n'),
      'calc/requirements.txt': strToU8('nope\n'),
      'plain/SKILL.md': strToU8('---\nname: plain\ndescription: d\n---\n'),
    };
    const skills = [{ name: 'calc', description: 'd', path: 'calc' }, { name: 'plain', description: 'd', path: 'plain' }];
    const problems = await requirementsProblems(files, skills, pypi);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^calc\/requirements\.txt：.*PyPI 上找不到/);
  });

  it('zip 根目錄的 skill（path 為空字串）讀 requirements.txt', async () => {
    const files = { 'SKILL.md': strToU8('x'), 'requirements.txt': strToU8('-e .\n') };
    const problems = await requirementsProblems(files, [{ name: 'root', description: 'd', path: '' }], pypi);
    expect(problems[0]).toMatch(/^requirements\.txt：第 1 行/);
  });
});
