import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import { errorText } from '../errors';
import type { Sandbox } from '../sandbox';
import type { SkillMeta } from '../types';
import { runBash, truncate } from './bash';

export const SKILL_OUTPUT_LIMIT = 60_000;
export const SKILL_COMMAND_TIMEOUT_MS = 30_000;

/** 只去掉檔案開頭那一段設定區，本文裡的 --- 分隔線保留 */
const FRONTMATTER = /^﻿?---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/;
const PLACEHOLDER = /\$\{CLAUDE_SKILL_DIR\}|\$ARGUMENTS\[(\d+)\]|\$ARGUMENTS|\$(\d+)/g;
const COMMAND = /!`([^`\n]+)`/g;

export function splitArgs(args: string): string[] {
  return [...args.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
}

/** 與 Claude Code 相同的替換規則；一次替換完，參數內容不會再被當成佔位符 */
export function expandSkill(body: string, o: { dir: string; args: string }): string {
  const list = splitArgs(o.args);
  const expanded = body.replace(PLACEHOLDER, (whole, indexed?: string, positional?: string) => {
    if (whole === '${CLAUDE_SKILL_DIR}') return o.dir;
    if (whole === '$ARGUMENTS') return o.args;
    return list[Number(indexed ?? positional)] ?? '';
  });
  return /\$ARGUMENTS/.test(body) || !o.args ? expanded : `${expanded}\n\nARGUMENTS: ${o.args}`;
}

async function runCommands(text: string, sandbox: Sandbox, dir: string, timeoutMs: number): Promise<string> {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(COMMAND)) {
    const r = await runBash(sandbox, m[1], dir, timeoutMs);
    const result = r.timedOut ? '[指令失敗：逾時]' : r.exitCode !== 0 ? `[指令失敗：結束碼 ${r.exitCode}]` : r.output.trim();
    out += text.slice(last, m.index) + result;
    last = m.index + m[0].length;
  }
  return out + text.slice(last);
}

export async function loadSkill(o: {
  skills: SkillMeta[];
  skillsDir: string;
  sandbox: Sandbox;
  name: string;
  args?: string;
  commandTimeoutMs?: number;
}): Promise<{ content: string } | { error: string }> {
  const skill = o.skills.find((s) => s.name === o.name);
  if (!skill) return { error: `找不到 skill「${o.name}」。可用的 skills：${o.skills.map((s) => s.name).join('、')}` };

  const dir = path.join(o.skillsDir, skill.path);
  let raw: string;
  try {
    raw = await readFile(path.join(dir, 'SKILL.md'), 'utf8');
  } catch (e) {
    return { error: `讀不到 skill「${o.name}」的 SKILL.md：${errorText(e)}` };
  }
  const body = raw.replace(FRONTMATTER, '').replace(/^(\r?\n)+/, '');
  const expanded = expandSkill(body, { dir, args: o.args ?? '' });
  // 指令在參數替換之後執行（與 Claude Code 相同），以顧問的沙盒帳號在 skill 資料夾裡跑
  const text = await runCommands(expanded, o.sandbox, dir, o.commandTimeoutMs ?? SKILL_COMMAND_TIMEOUT_MS);
  return { content: truncate(`這個 skill 的資料夾：${dir}（SKILL.md 裡的相對路徑都以這裡為準）\n\n${text}`, SKILL_OUTPUT_LIMIT) };
}

export function skillTool(o: { skills: SkillMeta[]; skillsDir: string; sandbox: Sandbox }) {
  return tool({
    description:
      '載入 skill 的完整說明。工作和「你的 skills」裡某個 skill 相符時，必須先呼叫這個工具，再開始回答或使用其他工具；同一次對話已經載入過的 skill 不要重複載入。',
    inputSchema: z.object({
      name: z.string().describe('skill 名稱，照「你的 skills」列出的寫'),
      args: z.string().optional().describe('選填：交給 skill 的參數，例如公司名稱或檔名'),
    }),
    execute: ({ name, args }) => loadSkill({ ...o, name, args }),
  });
}
