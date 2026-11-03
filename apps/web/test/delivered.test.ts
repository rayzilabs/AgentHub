import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { filesInMessage } from '@/lib/agent-output';

const f = (id: string) => ({ file_id: id, name: `${id}.docx`, folder: 'ETF 資金流顧問/2026-W43', size: 1024 });

describe('filesInMessage', () => {
  it('收集派工與討論交付的檔案並去重', () => {
    const message = {
      id: 'a', role: 'assistant',
      parts: [
        { type: 'text', text: '好' },
        { type: 'tool-assign_task', state: 'output-available', output: { consultant_id: 'c1', name: 'A', status: 'done', files: [f('1'), f('2')] } },
        { type: 'tool-convene_discussion', state: 'output-available', output: { topic: 't', round: 1, finished: true, speeches: [
          { consultant_id: 'c1', name: 'A', round: 1, status: 'done', text: '', files: [f('2'), f('3')] },
          { consultant_id: 'c2', name: 'B', round: 1, status: 'done', text: '' },
        ] } },
        { type: 'tool-assign_task', state: 'input-available', input: {} },
      ],
    } as unknown as UIMessage;
    expect(filesInMessage(message).map((x) => x.file_id)).toEqual(['1', '2', '3']);
  });
});
