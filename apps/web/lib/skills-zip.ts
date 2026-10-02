import { strFromU8, unzipSync } from 'fflate';
import { parse as parseYaml } from 'yaml';

export type SkillMeta = { name: string; description: string; path: string };

export class SkillZipError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join('\n'));
  }
}

/** 設定區接受 Windows 換行（CRLF）。 */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;
const BOM = /^\uFEFF/;

function isJunk(file: string): boolean {
  return file.startsWith('__MACOSX/') || file.split('/').pop()!.startsWith('._');
}

export function parseSkillsZip(bytes: Uint8Array): SkillMeta[] {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new SkillZipError(['檔案不是有效的 zip']);
  }

  const skillFiles = Object.keys(files)
    .filter((f) => !isJunk(f) && (f === 'SKILL.md' || f.endsWith('/SKILL.md')))
    .sort();
  if (skillFiles.length === 0) throw new SkillZipError(['zip 裡找不到任何 SKILL.md']);

  const problems: string[] = [];
  const skills: SkillMeta[] = [];
  const seen = new Map<string, string>();

  for (const file of skillFiles) {
    // 去掉 Windows 編輯器常加的 UTF-8 BOM（TextDecoder 通常已去掉，沒有 TextDecoder 時 fflate 不會）
    const match = strFromU8(files[file]).replace(BOM, '').match(FRONTMATTER);
    if (!match) {
      problems.push(`${file}：開頭缺少 --- 包住的設定區（name、description）`);
      continue;
    }
    let meta: Record<string, unknown>;
    try {
      meta = (parseYaml(match[1]) ?? {}) as Record<string, unknown>;
    } catch {
      problems.push(`${file}：設定區不是有效的 YAML`);
      continue;
    }
    const name = typeof meta.name === 'string' ? meta.name.trim() : '';
    const description = typeof meta.description === 'string' ? meta.description.trim() : '';
    const missing = [!name && 'name', !description && 'description'].filter(Boolean);
    if (missing.length) {
      problems.push(`${file}：缺少 ${missing.join('、')}`);
      continue;
    }
    const duplicateOf = seen.get(name);
    if (duplicateOf) {
      problems.push(`${file}：name「${name}」和 ${duplicateOf} 重複`);
      continue;
    }
    seen.set(name, file);
    skills.push({ name, description, path: file.slice(0, Math.max(0, file.length - '/SKILL.md'.length)) });
  }

  if (problems.length) throw new SkillZipError(problems);
  return skills;
}
