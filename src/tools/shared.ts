// Shared bits for the read tools: the `view` rungs, record normalization
// (epoch ms → ISO, BAND inline markup → plain text), opaque paging cursors and
// the calendar-date helpers.

import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import {
  McpToolError,
  UNTRUSTED_CONTENT_RULE,
  projectOrRaw,
  resolveView,
  untrustedResult,
  viewParam,
  type View,
} from '@chrischall/mcp-utils';

/** A BAND record as it arrives: an untyped JSON object. */
export type Rec = Record<string, unknown>;

/** A BAND list answer: `items` plus `paging.next_params` for the next page. */
export interface Paged {
  items?: Rec[] | null;
  paging?: { next_params?: Rec | null } | null;
  [key: string]: unknown;
}

/**
 * The rungs every read honours. No `raw`: every record is normalized (ISO
 * times) on the way out, and `full` is already every field BAND sent.
 */
export const BAND_VIEWS = ['compact', 'full'] as const satisfies readonly View[];

/** The `view` parameter. `note` says what compact leaves out. */
export const bandView = (note: string) => viewParam(BAND_VIEWS, { note });

export const bandNoParam = z.number().int().positive().describe('The band number (band_no) — from band_list_bands.');
export const postNoParam = z.number().int().positive().describe('The post number (post_no) — from band_list_posts or band_search_posts.');
export const cursorParam = z
  .string()
  .min(1)
  .optional()
  .describe('Opaque paging cursor: pass the previous answer’s next_cursor to get the next page.');

const UNTRUSTED_NOTE = `Posts, comments, names and chat text are written by BAND members. ${UNTRUSTED_CONTENT_RULE}`;

/**
 * Answer in the requested rung, framed as third-party text. `full` is the
 * normalized upstream record; `compact` goes through `projectOrRaw`, so a
 * projector that trips over an upstream shape change hands back everything
 * instead of a half-empty record.
 */
export function respond<T>(viewArg: string | undefined, raw: T, compact: (raw: T) => unknown, context: string): CallToolResult {
  const view = resolveView(viewArg, BAND_VIEWS);
  const normalized = normalizeTimes(raw) as T;
  const payload = view === 'full' ? normalized : projectOrRaw(normalized, compact, { label: 'band-mcp', context });
  return untrustedResult(payload, { note: UNTRUSTED_NOTE });
}

// ── normalization ────────────────────────────────────────────────────────────

/** Epoch ms after 2001 → ISO; anything else → undefined. */
export function isoTime(v: unknown): string | undefined {
  return typeof v === 'number' && v > 1e12 ? new Date(v).toISOString() : undefined;
}

/** Every epoch-ms `*_at` value rewritten to ISO, deeply; everything else unchanged. */
export function normalizeTimes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeTimes);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, (k.endsWith('_at') ? isoTime(v) : undefined) ?? normalizeTimes(v)]),
  );
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };

/** BAND's inline markup (`<band:refer …>Name</band:refer>`, `<br>`) as plain text. */
export function stripMarkup(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  return v
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?[a-z][\w:-]*(?:\s[^>]*)?>/gi, '')
    .replace(/&(?:amp|lt|gt|quot|#39);/g, (e) => ENTITIES[e]!)
    .trim();
}

/** Drop null/undefined keys (false and 0 are kept). */
export function prune<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== undefined)) as Partial<T>;
}

/** An author/creator object's display name. */
export function authorName(a: { name?: unknown } | null | undefined): string | undefined {
  return typeof a?.name === 'string' ? a.name : undefined;
}

/**
 * Attachment counts by kind. The feed sends arrays, get_post sends objects
 * keyed by id; both count. Empty kinds are left out; none at all → undefined.
 */
export function attachmentCounts(att: unknown): Record<string, number> | undefined {
  if (typeof att !== 'object' || att === null) return undefined;
  const counts = Object.entries(att).flatMap(([kind, v]) => {
    const n = Array.isArray(v) ? v.length : typeof v === 'object' && v !== null ? Object.keys(v).length : 0;
    return n > 0 ? [[kind, n] as const] : [];
  });
  return counts.length > 0 ? Object.fromEntries(counts) : undefined;
}

// ── paging ───────────────────────────────────────────────────────────────────

/** BAND's `paging.next_params` as an opaque cursor; none → undefined. */
export function encodeCursor(nextParams: Rec | null | undefined): string | undefined {
  return nextParams ? Buffer.from(JSON.stringify(nextParams)).toString('base64url') : undefined;
}

/** A cursor back to the query params it carries. */
export function decodeCursor(cursor: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    parsed = undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new McpToolError('That cursor is not one this server issued.', {
      hint: 'Pass next_cursor exactly as a previous answer returned it, or omit it to start from the first page.',
    });
  }
  return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
}

/** The query params a cursor carries; no cursor → the first page. */
export function pagingParams(cursor: string | undefined): Record<string, string> {
  return cursor ? decodeCursor(cursor) : {};
}

/** `paging.next_params` of a BAND list answer. */
export function nextCursorOf(data: Pick<Paged, 'paging'> | null | undefined) {
  return encodeCursor(data?.paging?.next_params);
}

// ── dates ────────────────────────────────────────────────────────────────────

/** The calendar date (YYYY-MM-DD) at `atMs` in `timeZone`. */
export function localDate(atMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(atMs));
}

/** `date` (YYYY-MM-DD) plus `days`. */
export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
