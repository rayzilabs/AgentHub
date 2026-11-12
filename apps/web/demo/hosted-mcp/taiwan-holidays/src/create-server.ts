// 工具定義改寫自上游 imsyuan/taiwan-holidays 的 mcp/src/index.ts（MIT）：拿掉 Cloudflare 專用的 McpAgent 外殼，
// 也拿掉和人資無關的旅遊工具（find_travel_windows、build_travel_links）。工具名稱、說明、參數與回傳格式不變。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { addWorkdays, countWorkdays, nextMakeupWorkday, optimizeLeave } from './engine/index';
import { loadCalendars } from './data';

const calendarsByYear = loadCalendars();
const allDays = Object.values(calendarsByYear)
  .flat()
  .sort((a, b) => a.date.localeCompare(b.date));

const rangeShape = z.object({ start: z.string(), end: z.string() }).optional().describe('Optional inclusive date range, YYYY-MM-DD');

function reply(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

export function createServer(): McpServer {
  const server = new McpServer({ name: 'taiwan-workday', version: '1.0.0' });
  server.registerTool(
    'count_workdays',
    {
      description: 'Count working days, holidays, and makeup workdays in an inclusive date range. Makeup workdays count as working days.',
      inputSchema: { start: z.string(), end: z.string() },
    },
    async ({ start, end }) => reply(countWorkdays(allDays, start, end)),
  );
  server.registerTool(
    'add_workdays',
    {
      description: 'Return the date N working days from a start date (start date not counted; negative N walks backward).',
      inputSchema: { from: z.string(), workdays: z.number().int() },
    },
    async ({ from, workdays }) => reply(addWorkdays(allDays, from, workdays)),
  );
  server.registerTool(
    'next_makeup_workday',
    {
      description: 'Find the next makeup workday on or after a base date, or all makeup workdays within a range.',
      inputSchema: { from: z.string().optional(), range: rangeShape },
    },
    async ({ from, range }) => reply(nextMakeupWorkday(allDays, { from, range })),
  );
  server.registerTool(
    'optimize_leave',
    {
      description: 'Given a year and available annual-leave days, return leave plans ranked by days-off-per-leave-day efficiency.',
      inputSchema: { year: z.number().int(), annualLeaveDays: z.number().int(), range: rangeShape },
    },
    async ({ year, annualLeaveDays, range }) => reply(optimizeLeave(calendarsByYear, { year, annualLeaveDays, range })),
  );
  return server;
}
