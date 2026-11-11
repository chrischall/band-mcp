// The band calendar: events in a date range, and one event.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { McpToolError, UNTRUSTED_DESCRIPTION_SUFFIX, toolAnnotations } from '@chrischall/mcp-utils';
import type { BandClient } from '../client.js';
import { ENDPOINTS } from '../endpoints.js';
import { LOOKUP, familyMeta } from './hints.js';
import { authorName, bandNoParam, bandView, localDate, prune, respond, shiftDate, type Rec } from './shared.js';

/** The default window: today … today + DEFAULT_DAYS. */
export const DEFAULT_DAYS = 60;

const dateParam = (what: string) =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'a date as YYYY-MM-DD')
    .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), 'a real calendar date')
    .optional()
    .describe(what);

/** One event, compact. */
export function compactEvent(e: Rec): Rec {
  return prune({
    schedule_id: e.schedule_id,
    name: e.name,
    description: e.description,
    start_at: e.start_at,
    end_at: e.end_at,
    all_day: e.is_all_day,
    type: e.schedule_type,
    calendar: authorName(e.subscribed_calendar as Rec | undefined),
    band: authorName(e.band as Rec | undefined),
  });
}

const ymd = (date: string) => date.replaceAll('-', '');

export function registerEventTools(server: McpServer, client: BandClient): void {
  server.registerTool(
    'band_list_events',
    {
      description:
        "List a BAND group's calendar events (games, practices, meetings) between two dates — name, start and end, " +
        `all-day flag and calendar. Defaults to today through ${DEFAULT_DAYS} days ahead, in your time zone. ` +
        UNTRUSTED_DESCRIPTION_SUFFIX,
      annotations: toolAnnotations({ title: 'List band events', readOnly: true, openWorld: true }),
      _meta: familyMeta('whats-on', { when: { start: 'from', end: 'to' }, aliases: ['band calendar', 'band events', 'band schedule'] }),
      inputSchema: z.object({
        band_no: bandNoParam,
        from: dateParam('First day, YYYY-MM-DD (default today).'),
        to: dateParam(`Last day, YYYY-MM-DD (default ${DEFAULT_DAYS} days after from).`),
        view: bandView('compact keeps id, name, description, times, all-day flag, type and calendar; full keeps every field.'),
      }),
    },
    async ({ band_no, from, to, view }) => {
      const start = from ?? localDate(client.now(), client.timeZone);
      const end = to ?? shiftDate(start, DEFAULT_DAYS);
      if (end < start) {
        throw new McpToolError(`The range ends (${end}) before it starts (${start}).`, { hint: 'Pass to on or after from.' });
      }
      const data = await client.get<{ items?: Rec[] | null }>(ENDPOINTS.SCHEDULES, {
        band_no,
        start_at: ymd(start),
        future_end_at: ymd(end),
        calendars: [{ is_default: true }],
      });
      return respond(
        view,
        { from: start, to: end, ...data },
        (d) => ({ from: d.from, to: d.to, events: (d.items ?? []).map(compactEvent) }),
        'get_schedules',
      );
    },
  );

  server.registerTool(
    'band_get_event',
    {
      description: 'Read one BAND calendar event — name, description, start and end, calendar. ' + UNTRUSTED_DESCRIPTION_SUFFIX,
      annotations: toolAnnotations({ title: 'Get a band event', readOnly: true, openWorld: true }),
      _meta: LOOKUP,
      inputSchema: z.object({
        band_no: bandNoParam,
        schedule_id: z.string().trim().min(1).describe('The event id (schedule_id) — from band_list_events.'),
        view: bandView('compact keeps the essentials; full keeps every field.'),
      }),
    },
    async ({ band_no, schedule_id, view }) => {
      const data = await client.get<Rec>(ENDPOINTS.SCHEDULE, { band_no, schedule_id });
      return respond(view, data, compactEvent, 'get_schedule');
    },
  );
}
