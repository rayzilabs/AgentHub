import path from 'node:path';
import { formatMemoryIndex, type MemoryIndex } from '../tools/memory';
import type { SharedFile } from '../sync';
import type { AgentInstance } from '../types';

export const SUMMARY_HEADINGS = ['## 各面向建議', '## 共識方案', '## 仍有分歧'] as const;

const MEMORY_RULES = [
  '記憶規則：',
  '- 記憶分四類：user（使用者是誰：角色、背景、偏好）、feedback（使用者對你工作方式的指示，包含糾正與認可）、project（這個專案進行中的事實、目標、限制、期限）、reference（外部資源的位置）。',
  '- 只記使用者明確說過的事實、偏好與指示。你自己或其他 agent 推論出的內容、派工與討論的內容不要記。',
  '- 寫之前先看索引有沒有相同主題的記憶，有就用同一個名稱以 memory_write 更新，不要新增重複的；發現記憶錯了或過時就更新，或用 memory_delete 刪除。',
  '- 一筆記憶一件事。名稱用簡短的英文小寫加連字號；summary 寫一行說明，讓之後看索引就能判斷相不相關。',
  '- feedback 與 project 類的內容寫成：事實，接著「為什麼：」與「怎麼用：」各一行。',
  '- 「明天」「下週」這類相對日期換成絕對日期（以上面的「今天」為準）。',
  '- 能從專案檔案或這次對話直接得知的東西不要記。',
].join('\n');

const TAIPEI_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' });
const TAIPEI_WEEKDAY = new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', weekday: 'long' });

function todaySection(now: Date): string {
  return [
    '## 今天',
    `今天是 ${TAIPEI_DATE.format(now)}（${TAIPEI_WEEKDAY.format(now)}），台灣時間。提到今天、期限、年資或資料截至哪一天時，以這個日期為準，不要自己猜。`,
  ].join('\n');
}

/** prompt 裡最多列出幾個共用檔案，其餘請 agent 自己用 ls -R 看 */
export const SHARED_FILES_LISTED = 50;

function filesSection(sharedRoot: string, sharedFiles: SharedFile[]): string {
  if (!sharedFiles.length) return ['## 專案檔案', '（目前沒有專案檔案）'].join('\n');
  const lines = sharedFiles.slice(0, SHARED_FILES_LISTED).map((f) => `- ${path.join(sharedRoot, ...f.path.split('/'))}`);
  const more = sharedFiles.length - SHARED_FILES_LISTED;
  if (more > 0) lines.push(`- …還有 ${more} 個檔案，用 bash 執行 ls -R ${sharedRoot} 查看`);
  return ['## 專案檔案', ...lines].join('\n');
}

function memorySection(memories: MemoryIndex): string {
  return ['## 記憶', '以下是記憶索引。需要細節時用 memory_read 讀內容。', formatMemoryIndex(memories), MEMORY_RULES].join('\n');
}

export type ConsultantPromptInput = {
  instance: AgentInstance;
  workDir: string;
  sharedRoot: string;
  sharedFiles: SharedFile[];
  memories: MemoryIndex;
  mcpWarnings: string[];
  /** requirements.txt 的套件沒裝好時的錯誤摘要 */
  envFailure?: string;
  /** 沒裝好的那份 requirements */
  envPackages?: string[];
  now: Date;
};

export function buildConsultantInstructions(p: ConsultantPromptInput): string {
  const skills = p.instance.skills.length
    ? [
        ...p.instance.skills.map((s) => `- ${s.name}：${s.description}`),
        '工作內容和上面某個 skill 相符時，這是必要步驟：先用 skill 工具載入它，再開始回答或使用其他工具。不要只憑名稱和說明猜內容。',
      ].join('\n')
    : '（沒有 skill）';

  const sections = [
    p.instance.system_prompt.trim(),
    todaySection(p.now),
    [
      '## 工作環境',
      `- 你的工作目錄：${p.workDir}。bash 指令和相對路徑都以這裡為基準。`,
      `- 專案共用檔案放在 ${p.sharedRoot}，所有 agent 都能讀寫。`,
      '- 工具回傳 download_url 時，用 bash 以 curl 下載到工作目錄再處理，不要把大量資料貼進回覆。',
      '- 做出要給使用者的檔案（報告、圖表、表格）時，用 deliver_file 交付，使用者才拿得到；只寫進工作目錄或共用資料夾的檔案，使用者看不到。',
    ].join('\n'),
    filesSection(p.sharedRoot, p.sharedFiles),
    ['## 你的 skills', skills].join('\n'),
    [
      '## 資料說明',
      '回答用到數字或資料時，註明資料來源與資料截至哪一天。用了工具以外的資料，或數字是你自己估計、假設出來的，要明講。',
      '回覆裡的數字只能來自工具結果、你執行程式的輸出，或使用者提供的資料。表格裡沒有算出來的格子寫「未計算」（或拿掉那一欄），不要估計補齊；需要的話再執行程式算出來。',
    ].join('\n'),
    memorySection(p.memories),
  ];
  if (p.mcpWarnings.length) {
    sections.push(['## 目前無法使用的工具', ...p.mcpWarnings.map((w) => `- ${w}`)].join('\n'));
  }
  if (p.envFailure) {
    sections.push([
      '## 套件安裝失敗',
      `這些套件沒有裝好：${p.envPackages?.length ? p.envPackages.join('、') : '（requirements.txt 裡的套件）'}。不要假設它們存在；需要時告知使用者這位顧問的環境不完整。`,
      `pip 的錯誤訊息：${p.envFailure}`,
    ].join('\n'));
  }
  return sections.join('\n\n');
}

export type ManagerPromptInput = {
  consultants: AgentInstance[];
  memories: MemoryIndex;
  sharedRoot: string;
  sharedFiles: SharedFile[];
  now: Date;
};

export function buildManagerInstructions(p: ManagerPromptInput): string {
  return [
    '你是這個專案的主管，直接面對使用者。你沒有自己的專業 skill：專業問題一律交給顧問處理；簡單的寒暄或釐清需求可以直接回答。',
    todaySection(p.now),
    ['## 你的顧問', ...p.consultants.map((c) => `- ${c.name}（id: ${c.id}）：${c.description || '（沒有介紹）'}`)].join('\n'),
    [
      '## 怎麼分工',
      '- 只需要單一專業時，用 assign_task 把任務交給最合適的顧問，任務說明要寫清楚背景與要交付的內容。',
      '- 步驟之間有先後依賴（後一步要用前一步的結果，例如先選出標的再做計算）時，用 assign_task 依序派工，把前一步的關鍵結果（數字、清單或共用資料夾裡的檔名）寫進下一步的任務說明。',
      '- 需要跨專業權衡時（例如法律風險與工程成本互相牽制），用 convene_discussion 召開討論，邀請相關顧問參加。討論第一輪大家同時發言、看不到彼此的結果，所以需要先算出結果才能討論時，先用 assign_task 取得結果，再把結果寫進討論題目。',
      '- 拿到顧問的結果後，整理成給使用者的回覆，不要只是轉貼。回覆只能使用顧問回報的數字與結論，顧問沒有提供的門檻、比例或數字不要自行補上。',
      '- 顧問回報裡關於資料的說明（資料來源、資料截至哪一天、用了工具以外的資料或自己的假設、限制與免責聲明）要保留在給使用者的回覆裡，可以精簡合併，但不能刪掉。',
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
