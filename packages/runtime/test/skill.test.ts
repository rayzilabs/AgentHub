import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSandbox } from '../src/sandbox';
import { expandSkill, loadSkill, splitArgs } from '../src/tools/skill';
import type { SkillMeta } from '../src/types';
import { tmpRoots } from './helpers';

const local = createSandbox();

/** 在暫存的 skills 資料夾裡寫好每個 skill 的 SKILL.md 與其他檔案 */
async function skillsFixture(files: Record<string, string>) {
  const { agentsRoot } = await tmpRoots();
  const skillsDir = path.join(path.dirname(agentsRoot), 'skills', 'a1');
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(skillsDir, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return skillsDir;
}

const md = (name: string, body: string) => `---\nname: ${name}\ndescription: ${name} 的說明\n---\n\n${body}`;

describe('splitArgs', () => {
  it('以空白切分，雙引號內視為一個參數', () => {
    expect(splitArgs('a  "b c" d')).toEqual(['a', 'b c', 'd']);
    expect(splitArgs('')).toEqual([]);
  });
});

describe('expandSkill', () => {
  it('替換 ${CLAUDE_SKILL_DIR}、$ARGUMENTS[N]、$N、$ARGUMENTS', () => {
    expect(expandSkill('${CLAUDE_SKILL_DIR}/a.py $ARGUMENTS[1] $0 | $ARGUMENTS', { dir: '/s/x', args: 'p "q r"' }))
      .toBe('/s/x/a.py q r p | p "q r"');
  });

  it('超出範圍的 $N 保留原文，金額不會被吃掉；$ARGUMENTS[N] 超出範圍換成空字串', () => {
    expect(expandSkill('門檻 NT$5,000，停損 $100，[$ARGUMENTS[5]]', { dir: '/s', args: 'a' }))
      .toBe('門檻 NT$5,000，停損 $100，[]');
    expect(expandSkill("awk '{print $1}' x.csv", { dir: '/s', args: '' })).toBe("awk '{print $1}' x.csv");
  });

  it('本文沒有 $ARGUMENTS 而有參數時，最後加上 ARGUMENTS 行；沒參數則不加', () => {
    expect(expandSkill('做事', { dir: '/s', args: '台積電' })).toBe('做事\n\nARGUMENTS: 台積電');
    expect(expandSkill('做事', { dir: '/s', args: '' })).toBe('做事');
  });
});

describe('loadSkill', () => {
  const skills: SkillMeta[] = [
    { name: 'dcf', description: '估值', path: 'dcf' },
    { name: 'cmd', description: '指令', path: 'tools/cmd' },
    { name: 'bad', description: '失敗', path: 'bad' },
  ];

  it('回傳資料夾說明行加上去掉 frontmatter 的本文，本文裡的 --- 保留', async () => {
    const skillsDir = await skillsFixture({ 'dcf/SKILL.md': md('dcf', '# DCF\n\n---\n結尾') });
    const dir = path.join(skillsDir, 'dcf');
    expect(await loadSkill({ skills, skillsDir, sandbox: local, name: 'dcf' })).toEqual({
      content: `這個 skill 的資料夾：${dir}（SKILL.md 裡的相對路徑都以這裡為準）\n\n# DCF\n\n---\n結尾`,
    });
  });

  it('接受 BOM 與 Windows 換行的 frontmatter', async () => {
    const skillsDir = await skillsFixture({ 'dcf/SKILL.md': `﻿${md('dcf', '本文')}`.replace(/\n/g, '\r\n') });
    const r = (await loadSkill({ skills, skillsDir, sandbox: local, name: 'dcf' })) as { content: string };
    expect(r.content.endsWith('\n\n本文')).toBe(true);
    expect(r.content).not.toContain('name: dcf');
  });

  it('執行 !`指令`，以 skill 資料夾為工作目錄，參數先替換再執行', async () => {
    const skillsDir = await skillsFixture({
      'tools/cmd/SKILL.md': md('cmd', '值：!`cat data.txt`，參數：!`echo $0`'),
      'tools/cmd/data.txt': '42\n',
    });
    const r = (await loadSkill({ skills, skillsDir, sandbox: local, name: 'cmd', args: '台積電' })) as { content: string };
    expect(r.content).toContain('值：42，參數：台積電');
  });

  it('指令失敗換成 [指令失敗：…]，工具本身不失敗', async () => {
    const skillsDir = await skillsFixture({ 'bad/SKILL.md': md('bad', 'A !`exit 3` B') });
    const r = (await loadSkill({ skills, skillsDir, sandbox: local, name: 'bad' })) as { content: string };
    expect(r.content).toContain('A [指令失敗：結束碼 3] B');
  });

  it('指令逾時換成 [指令失敗：逾時]', async () => {
    const skillsDir = await skillsFixture({ 'bad/SKILL.md': md('bad', 'A !`sleep 5` B') });
    const r = (await loadSkill({ skills, skillsDir, sandbox: local, name: 'bad', commandTimeoutMs: 200 })) as { content: string };
    expect(r.content).toContain('A [指令失敗：逾時] B');
  });

  it('找不到名稱時回傳錯誤並列出可用名稱', async () => {
    const skillsDir = await skillsFixture({});
    expect(await loadSkill({ skills, skillsDir, sandbox: local, name: 'nope' }))
      .toEqual({ error: '找不到 skill「nope」。可用的 skills：dcf、cmd、bad' });
  });

  it('SKILL.md 讀不到時回傳錯誤', async () => {
    const skillsDir = await skillsFixture({});
    const r = (await loadSkill({ skills, skillsDir, sandbox: local, name: 'dcf' })) as { error: string };
    expect(r.error).toMatch(/^讀不到 skill「dcf」的 SKILL\.md：/);
  });

  it('超過 60000 字元截斷', async () => {
    const skillsDir = await skillsFixture({ 'dcf/SKILL.md': md('dcf', 'x'.repeat(70_000)) });
    const r = (await loadSkill({ skills, skillsDir, sandbox: local, name: 'dcf' })) as { content: string };
    expect(r.content).toContain('已截斷');
    expect(r.content.length).toBeLessThan(61_000);
  });
});
