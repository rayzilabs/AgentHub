import path from 'node:path';
import { formatMemoryBlock, type MemoryRow } from '../tools/memory';
import type { AgentInstance } from '../types';

export const SUMMARY_HEADINGS = ['## 各面向建議', '## 共識方案', '## 仍有分歧'] as const;

const MEMORY_RULE = '只有使用者明確說過的事實與偏好，才用 remember 記下來。你自己或其他 agent 推論出的內容不要記。';

function filesSection(sharedRoot: string, sharedFiles: string[]): string {
  const files = sharedFiles.length
    ? sharedFiles.map((f) => `- ${path.join(sharedRoot, f)}`).join('\n')
    : '（目前沒有專案檔案）';
  return ['## 專案檔案', files].join('\n');
}

function memorySection(memories: MemoryRow[]): string {
  return ['## 記憶', formatMemoryBlock(memories), MEMORY_RULE].join('\n');
}

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
    filesSection(p.sharedRoot, p.sharedFiles),
    ['## 你的 skills', skills].join('\n'),
    memorySection(p.memories),
  ];
  if (p.mcpWarnings.length) {
    sections.push(['## 目前無法使用的工具', ...p.mcpWarnings.map((w) => `- ${w}`)].join('\n'));
  }
  return sections.join('\n\n');
}

export type ManagerPromptInput = {
  consultants: AgentInstance[];
  memories: MemoryRow[];
  sharedRoot: string;
  sharedFiles: string[];
};

export function buildManagerInstructions(p: ManagerPromptInput): string {
  return [
    '你是這個專案的主管，直接面對使用者。你沒有自己的專業 skill：專業問題一律交給顧問處理；簡單的寒暄或釐清需求可以直接回答。',
    ['## 你的顧問', ...p.consultants.map((c) => `- ${c.name}（id: ${c.id}）：${c.description || '（沒有介紹）'}`)].join('\n'),
    [
      '## 怎麼分工',
      '- 只需要單一專業時，用 assign_task 把任務交給最合適的顧問，任務說明要寫清楚背景與要交付的內容。',
      '- 步驟之間有先後依賴（後一步要用前一步的結果，例如先選出標的再做計算）時，用 assign_task 依序派工，把前一步的關鍵結果（數字、清單或共用資料夾裡的檔名）寫進下一步的任務說明。',
      '- 需要跨專業權衡時（例如法律風險與工程成本互相牽制），用 convene_discussion 召開討論，邀請相關顧問參加。討論第一輪大家同時發言、看不到彼此的結果，所以需要先算出結果才能討論時，先用 assign_task 取得結果，再把結果寫進討論題目。',
      '- 拿到顧問的結果後，整理成給使用者的回覆，不要只是轉貼。回覆只能使用顧問回報的數字與結論，顧問沒有提供的門檻、比例或數字不要自行補上。',
    ].join('\n'),
    [
      '## 討論後的總結格式',
      '召開討論後，最終回覆必須依序包含以下三段：',
      ...SUMMARY_HEADINGS,
      '「仍有分歧」要明確列出顧問之間沒有達成共識的地方，沒有分歧就寫「無」。不可以假裝大家都同意。',
      '最終總結要精簡：約 600 字以內，用條列重點。',
    ].join('\n'),
    filesSection(p.sharedRoot, p.sharedFiles),
    memorySection(p.memories),
  ].join('\n\n');
}
