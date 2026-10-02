import path from 'node:path';
import { formatMemoryBlock, type MemoryRow } from '../tools/memory';
import type { AgentInstance } from '../types';

export type ConsultantPromptInput = {
  instance: AgentInstance;
  workDir: string;
  skillsDir: string;
  sharedRoot: string;
  sharedFiles: string[];
  memories: MemoryRow[];
  mcpWarnings: string[];
};

export function buildConsultantInstructions(p: ConsultantPromptInput): string {
  const files = p.sharedFiles.length
    ? p.sharedFiles.map((f) => `- ${path.join(p.sharedRoot, f)}`).join('\n')
    : '（目前沒有專案檔案）';
  const skills = p.instance.skills.length
    ? [
        ...p.instance.skills.map(
          (s) => `- ${s.name}：${s.description}（完整說明：${path.join(p.skillsDir, s.path, 'SKILL.md')}）`,
        ),
        '使用某個 skill 之前，先用 read_file 讀它的 SKILL.md，再照著做。',
      ].join('\n')
    : '（沒有 skill）';

  const sections = [
    p.instance.system_prompt.trim(),
    [
      '## 工作環境',
      `- 你的工作目錄：${p.workDir}。bash 指令和相對路徑都以這裡為基準。`,
      `- 專案共用檔案放在 ${p.sharedRoot}，所有 agent 都能讀寫。`,
    ].join('\n'),
    ['## 專案檔案', files].join('\n'),
    ['## 你的 skills', skills].join('\n'),
    [
      '## 記憶',
      formatMemoryBlock(p.memories),
      '只有使用者明確說過的事實與偏好，才用 remember 記下來。你自己或其他 agent 推論出的內容不要記。',
    ].join('\n'),
  ];
  if (p.mcpWarnings.length) {
    sections.push(['## 目前無法使用的工具', ...p.mcpWarnings.map((w) => `- ${w}`)].join('\n'));
  }
  return sections.join('\n\n');
}
