'use client';

import { useState } from 'react';
import type { ToolEvent } from '@/lib/agent-output';
import { elapsedOf, foldSteps, formatElapsed, INTERRUPTED, isRunningState, settleStep, toolLabel } from '@/lib/progress';
import { useNow } from './use-now';

export function ToolStep({ step, now }: { step: ToolEvent; now: number }) {
  const running = isRunningState(step.state);
  const failed = step.state === 'output-error';
  const interrupted = step.state === INTERRUPTED;
  const ms = elapsedOf(step, now);
  return (
    <li className="flex items-baseline gap-2 text-sm">
      <span aria-hidden className={`w-4 shrink-0 text-center ${failed ? 'text-seal' : running || interrupted ? 'text-muted' : 'text-sage'}`}>
        {running ? <span className="dot-busy" /> : failed ? '✕' : interrupted ? '–' : '✓'}
      </span>
      <span className="sr-only">{running ? '執行中：' : failed ? '失敗：' : interrupted ? '中斷：' : '完成：'}</span>
      <span className="shrink-0 font-medium">{toolLabel(step.tool)}{interrupted && <span className="font-normal text-muted">（中斷）</span>}</span>
      {step.description && <span className="min-w-0 flex-1 truncate text-muted">{step.description}</span>}
      {ms !== undefined && (
        <span className="ml-auto shrink-0 tabular-nums text-muted">{formatElapsed(ms)}{running ? '…' : ''}</span>
      )}
    </li>
  );
}

/**
 * 顧問的工具步驟：每次呼叫一行，超過 8 步只顯示最新 5 步。
 * ended：上層（派工、發言）已結束，還沒有結果的步驟是被中止的，不再顯示執行中
 */
export function ToolSteps({ tools, ended }: { tools?: ToolEvent[]; ended: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const steps = (tools ?? []).map((t) => settleStep(t, ended));
  const now = useNow(steps.some((t) => isRunningState(t.state)));
  if (!steps.length) return null;
  const { hidden, visible } = expanded ? { hidden: 0, visible: steps } : foldSteps(steps);
  return (
    <div className="mt-3">
      {hidden > 0 && (
        <button type="button" onClick={() => setExpanded(true)} className="mb-1 text-sm text-link hover:underline">
          前面還有 {hidden} 步
        </button>
      )}
      <ol className="space-y-1">
        {visible.map((step, i) => <ToolStep key={hidden + i} step={step} now={now} />)}
      </ol>
    </div>
  );
}
