import { describe, expect, it } from 'vitest';
import { McpToolError } from '@chrischall/mcp-utils';
import {
  attachmentCounts,
  authorName,
  decodeCursor,
  encodeCursor,
  isoTime,
  localDate,
  normalizeTimes,
  prune,
  shiftDate,
  stripMarkup,
} from '../src/tools/shared.js';

describe('isoTime', () => {
  it('renders epoch ms as ISO; anything else is undefined', () => {
    expect(isoTime(1_794_000_000_000)).toBe(new Date(1_794_000_000_000).toISOString());
    expect(isoTime(0)).toBeUndefined();
    expect(isoTime('2026-01-01')).toBeUndefined();
    expect(isoTime(undefined)).toBeUndefined();
  });
});

describe('normalizeTimes', () => {
  it('rewrites every epoch-ms *_at value to ISO, deeply, and leaves the rest', () => {
    const out = normalizeTimes({
      created_at: 1_794_000_000_000,
      participated_at: 1, // not an epoch-ms timestamp
      start_at: '20261101', // strings stay
      nested: [{ updated_at: 1_794_003_600_000, n: 5 }],
      name: 'x',
      nil: null,
    });
    expect(out).toEqual({
      created_at: new Date(1_794_000_000_000).toISOString(),
      participated_at: 1,
      start_at: '20261101',
      nested: [{ updated_at: new Date(1_794_003_600_000).toISOString(), n: 5 }],
      name: 'x',
      nil: null,
    });
  });
});

describe('stripMarkup', () => {
  it('drops BAND inline tags but keeps their text', () => {
    expect(stripMarkup('Hi <band:refer user_no="1">Sam</band:refer>, see <band:hashtag>game</band:hashtag>!')).toBe(
      'Hi Sam, see game!',
    );
  });
  it('turns <br> into newlines, decodes the basic entities, and trims', () => {
    expect(stripMarkup('  a<br>b<br/>c &amp; d &lt;e&gt; &quot;f&quot; &#39;g&#39;  ')).toBe('a\nb\nc & d <e> "f" \'g\'');
  });
  it('passes non-strings through as undefined', () => {
    expect(stripMarkup(undefined)).toBeUndefined();
    expect(stripMarkup(3)).toBeUndefined();
  });
});

describe('cursor', () => {
  it('round-trips BAND paging params', () => {
    const params = { after: '123', limit: '20', band_no: '9' };
    expect(decodeCursor(encodeCursor(params)!)).toEqual(params);
    // non-string values come back as their JSON text (BAND reads them as query strings)
    expect(decodeCursor(encodeCursor({ n: 5, o: { a: 1 } })!)).toEqual({ n: '5', o: '{"a":1}' });
  });
  it('no next page → no cursor', () => {
    expect(encodeCursor(null)).toBeUndefined();
    expect(encodeCursor(undefined)).toBeUndefined();
  });
  it('a garbled cursor is an actionable error', () => {
    for (const bad of ['%%%', Buffer.from('[1,2]').toString('base64url'), Buffer.from('"s"').toString('base64url')]) {
      expect(() => decodeCursor(bad)).toThrow(McpToolError);
    }
  });
});

describe('dates', () => {
  it('localDate is the calendar date in the zone', () => {
    const at = Date.UTC(2026, 10, 11, 3, 0); // 03:00Z = 22:00 previous day in New York
    expect(localDate(at, 'America/New_York')).toBe('2026-11-10');
    expect(localDate(at, 'UTC')).toBe('2026-11-11');
  });
  it('shiftDate adds days across month/year ends', () => {
    expect(shiftDate('2026-12-15', 60)).toBe('2027-02-13');
  });
});

describe('small projections', () => {
  it('authorName, prune, attachmentCounts', () => {
    expect(authorName({ name: 'A' })).toBe('A');
    expect(authorName(undefined)).toBeUndefined();
    expect(prune({ a: 1, b: undefined, c: null, d: false, e: 0 })).toEqual({ a: 1, d: false, e: 0 });
    // feed shape (arrays) and get_post shape (keyed objects) both count
    expect(attachmentCounts({ photo: [{}, {}], file: { a: {}, b: {} }, video: {}, dropbox_file: [] })).toEqual({ photo: 2, file: 2 });
    expect(attachmentCounts({ video: [] })).toBeUndefined();
    expect(attachmentCounts(undefined)).toBeUndefined();
    expect(attachmentCounts({ photo: 'x' })).toBeUndefined();
  });
});
