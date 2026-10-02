import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { parseSkillsZip, SkillZipError } from '@/lib/skills-zip';

const zip = (files: Record<string, string>) =>
  zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));

const skill = (name: string, description: string, body = '內容') =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;

function problemsOf(bytes: Uint8Array): string[] {
  try {
    parseSkillsZip(bytes);
  } catch (e) {
    if (e instanceof SkillZipError) return e.problems;
    throw e;
  }
  throw new Error('應該要丟出 SkillZipError');
}

describe('parseSkillsZip', () => {
  it('每個含 SKILL.md 的資料夾算一個 skill，path 是資料夾路徑', () => {
    expect(parseSkillsZip(zip({
      'skills/contract/SKILL.md': skill('contract-review', '審查合約風險'),
      'skills/contract/checklist.md': '清單',
      'skills/dcf/SKILL.md': skill('dcf', '現金流折現估值'),
    }))).toEqual([
      { name: 'contract-review', description: '審查合約風險', path: 'skills/contract' },
      { name: 'dcf', description: '現金流折現估值', path: 'skills/dcf' },
    ]);
  });

  it('SKILL.md 在 zip 根目錄時 path 為空字串', () => {
    expect(parseSkillsZip(zip({ 'SKILL.md': skill('solo', '單一 skill') }))).toEqual([
      { name: 'solo', description: '單一 skill', path: '' },
    ]);
  });

  it('忽略 __MACOSX 與 ._ 開頭的檔案', () => {
    expect(parseSkillsZip(zip({
      'a/SKILL.md': skill('a', 'A'),
      '__MACOSX/a/._SKILL.md': 'garbage',
      'a/._SKILL.md': 'garbage',
    }))).toHaveLength(1);
  });

  it('description 可以是 YAML 多行字串', () => {
    const text = '---\nname: multi\ndescription: >\n  第一行\n  第二行\n---\n';
    expect(parseSkillsZip(zip({ 'm/SKILL.md': text }))[0].description).toBe('第一行 第二行');
  });

  it('沒有任何 SKILL.md', () => {
    expect(problemsOf(zip({ 'readme.md': 'x' }))).toEqual(['zip 裡找不到任何 SKILL.md']);
  });

  it('逐項列出缺少的欄位與重名', () => {
    expect(problemsOf(zip({
      'a/SKILL.md': '沒有 frontmatter',
      'b/SKILL.md': '---\nname: b\n---\n',
      'c/SKILL.md': skill('dup', 'C'),
      'd/SKILL.md': skill('dup', 'D'),
    }))).toEqual([
      'a/SKILL.md：開頭缺少 --- 包住的設定區（name、description）',
      'b/SKILL.md：缺少 description',
      'd/SKILL.md：name「dup」和 c/SKILL.md 重複',
    ]);
  });

  it('不是 zip 檔', () => {
    expect(problemsOf(strToU8('not a zip'))).toEqual(['檔案不是有效的 zip']);
  });
});
