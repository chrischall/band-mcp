import { afterEach, describe, expect, it } from 'vitest';
import type { TestHarness } from '@chrischall/mcp-utils/test';
import { registerBandTools } from '../src/tools/bands.js';
import { registerChatTools } from '../src/tools/chats.js';
import { registerEventTools } from '../src/tools/events.js';
import { registerNewsTools } from '../src/tools/news.js';
import { registerPostTools } from '../src/tools/posts.js';
import { encodeCursor } from '../src/tools/shared.js';
import type { BandClient } from '../src/client.js';
import type { McpServer } from '@modelcontextprotocol/server';
import { NOW_MS, fixture, ok, textOf, toolHarness, untrustedPayload } from './helpers.js';

let harness: TestHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

type Registrar = (server: McpServer, client: BandClient) => void;

async function call(register: Registrar, name: string, args: Record<string, unknown>, script: unknown[], opts?: { now?: number }) {
  await harness?.close();
  const t = await toolHarness(register, script, opts);
  harness = t.harness;
  const result = await t.harness.callTool(name, args);
  return { result, sent: t.sent, jwt: t.jwt };
}

const iso = (ms: number) => new Date(ms).toISOString();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

describe('band_list_bands', () => {
  it('asks for the required fields and lists band_no + name', async () => {
    const { result, sent } = await call(registerBandTools, 'band_list_bands', {}, [fixture('bands')]);
    expect(sent[0]!.path).toBe('/v2.1.0/get_band_list_with_filter');
    expect(sent[0]!.query.get('fields')).toBe('band.band_no,band.name,band.member_count,band.cover');
    expect(sent[0]!.query.get('include_restricted')).toBe('false');
    expect(untrustedPayload(result)).toEqual({
      bands: [
        { band_no: 100001, name: 'sample name 2' },
        { band_no: 100003, name: 'sample name 4' },
      ],
    });
  });

  it('full keeps every field; a non-array answer lists nothing', async () => {
    const full = await call(registerBandTools, 'band_list_bands', { view: 'full' }, [fixture('bands')]);
    expect(untrustedPayload<Any>(full.result).bands[0]).toEqual({ band: { band_no: 100001, name: 'sample name 2' } });
    const empty = await call(registerBandTools, 'band_list_bands', {}, [ok(null)]);
    expect(untrustedPayload(empty.result)).toEqual({ bands: [] });
  });
});

describe('band_get_band', () => {
  it('compact keeps the essentials', async () => {
    const { result, sent } = await call(registerBandTools, 'band_get_band', { band_no: 100001 }, [fixture('bandinfo')]);
    expect(sent[0]!.path).toBe('/v2.3.0/get_band_information');
    expect(sent[0]!.query.get('band_no')).toBe('100001');
    expect(untrustedPayload(result)).toEqual({
      band_no: 100001,
      name: 'sample name 2',
      type: 'group',
      open_type: 'secret',
      member_count: 59,
      leader_name: 'sample leader_name 4',
      web_url: 'https://example.invalid/web_url',
      chat_enabled: true,
    });
  });

  it('full normalizes the timestamps', async () => {
    const { result } = await call(registerBandTools, 'band_get_band', { band_no: 100001, view: 'full' }, [fixture('bandinfo')]);
    const band = untrustedPayload<Any>(result);
    expect(band.member_group_updated_at).toBe(iso(1794061200000));
    expect(band.properties.is_member_list_enabled).toBe(true);
  });

  it('a not-found surfaces BAND’s message as a tool error', async () => {
    const { result } = await call(registerBandTools, 'band_get_band', { band_no: 1 }, [fixture('notfound')]);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/result_code 1000/);
  });
});

describe('band_list_members', () => {
  it('lists members compactly; me only when true', async () => {
    const { result, sent } = await call(registerBandTools, 'band_list_members', { band_no: 7 }, [fixture('members')]);
    expect(sent[0]!.path).toBe('/v2.0.0/get_members_of_band');
    expect(untrustedPayload(result)).toEqual({
      member_count: 59,
      members: [
        { user_no: 100001, name: 'sample name 2', role: 'member', online: true, me: true, joined_at: iso(1794007200000) },
        { user_no: 100004, name: 'sample name 5', role: 'leader', online: false, joined_at: iso(1794018000000) },
        { user_no: 100007, name: 'sample name 8', role: 'coleader', online: false, joined_at: iso(1794028800000) },
      ],
    });
  });

  it('filters by a case-insensitive name fragment; full keeps every field', async () => {
    const { result } = await call(registerBandTools, 'band_list_members', { band_no: 7, name: 'NAME 5' }, [fixture('members')]);
    expect(untrustedPayload<Any>(result).members.map((m: Any) => m.user_no)).toEqual([100004]);
    const full = await call(registerBandTools, 'band_list_members', { band_no: 7, view: 'full', name: 'name 8' }, [fixture('members')]);
    const p = untrustedPayload<Any>(full.result);
    expect(p.members).toHaveLength(1);
    expect(p.members[0].profile_image_url).toBe('https://example.invalid/profile_image_url');
    const empty = await call(registerBandTools, 'band_list_members', { band_no: 7 }, [ok({})]);
    expect(untrustedPayload(empty.result)).toEqual({ members: [] });
  });
});

describe('band_list_posts', () => {
  it('lists posts and announcements, compact, with markup stripped', async () => {
    const env = fixture('feed') as Any;
    env.result_data.items[1].post.content = 'Hey <band:refer user_no="1">You</band:refer>';
    env.result_data.paging.next_params = { after: '5', limit: '20' };
    const { result, sent } = await call(registerPostTools, 'band_list_posts', { band_no: 9 }, [env]);
    expect(sent[0]!.path).toBe('/v2.0.0/get_posts_and_announcements');
    expect(sent[0]!.query.get('band_no')).toBe('9');
    expect(sent[0]!.query.get('resolution_type')).toBe('4');
    const p = untrustedPayload<Any>(result);
    expect(p.items).toHaveLength(3);
    expect(p.items[0]).toEqual({
      type: 'announcement',
      announcement_id: 5,
      text: 'sample fallback_message 8',
      created_at: iso(1794036000000),
    });
    expect(p.items[1]).toMatchObject({
      type: 'post',
      post_no: 5,
      author: 'sample name 30',
      content: 'Hey You',
      comment_count: 0,
      emotion_count: 2,
      created_at: iso(1794093600000),
      attachments: { file: 1 },
    });
    expect(p.next_cursor).toBe(encodeCursor({ after: '5', limit: '20' }));
  });

  it('include_announcements:false drops announcements; cursor spreads its params', async () => {
    const cursor = encodeCursor({ after: '5', limit: '20' })!;
    const { result, sent } = await call(registerPostTools, 'band_list_posts', { band_no: 9, include_announcements: false, cursor }, [fixture('feed')]);
    expect(sent[0]!.query.get('after')).toBe('5');
    expect(sent[0]!.query.get('limit')).toBe('20');
    const p = untrustedPayload<Any>(result);
    expect(p.items.map((i: Any) => i.type)).toEqual(['post']);
    expect(p.next_cursor).toBeUndefined();
  });

  it('full keeps the records whole (times normalized); bad cursor is an error', async () => {
    const { result } = await call(registerPostTools, 'band_list_posts', { band_no: 9, view: 'full' }, [fixture('feed')]);
    const p = untrustedPayload<Any>(result);
    expect(p.items[1].post.band.name).toBe('sample name 22');
    expect(p.items[1].post.created_at).toBe(iso(1794093600000));
    const bad = await call(registerPostTools, 'band_list_posts', { band_no: 9, cursor: '%%' }, []);
    expect(bad.result.isError).toBe(true);
    expect(bad.sent).toHaveLength(0);
  });

  it('tolerates a feed with no items and unknown item types', async () => {
    const { result } = await call(registerPostTools, 'band_list_posts', { band_no: 9 }, [ok({ items: [{ type: 'ad' }] })]);
    expect(untrustedPayload(result)).toEqual({ items: [{ type: 'ad' }] });
    const none = await call(registerPostTools, 'band_list_posts', { band_no: 9 }, [ok({})]);
    expect(untrustedPayload(none.result)).toEqual({ items: [] });
  });
});

describe('band_get_post', () => {
  it('reads the post and, by default, its comments', async () => {
    const { result, sent } = await call(registerPostTools, 'band_get_post', { band_no: 9, post_no: 5 }, [fixture('post'), fixture('comments')]);
    expect(sent[0]!.path).toBe('/v2.0.0/get_post');
    expect(sent[0]!.query.get('post_no')).toBe('5');
    expect(sent[1]!.path).toBe('/v2.3.0/get_comments');
    expect(JSON.parse(sent[1]!.query.get('content_key')!)).toEqual({ content_type: 'post', post_no: 5 });
    const p = untrustedPayload<Any>(result);
    expect(p.post).toMatchObject({
      post_no: 5,
      band: 'sample name 9',
      author: 'sample name 16',
      content: 'sample content 7',
      read_count: 27,
      attachments: { file: 1 },
      web_url: 'https://example.invalid/web_url',
    });
    expect(p.comments).toEqual([
      { comment_id: 1, author: 'sample name 4', body: 'sample body 1', created_at: iso(1794028800000), photo_count: 1 },
    ]);
    expect(p.comment_total).toBe(1);
  });

  it('include_comments:false makes one call; full keeps everything', async () => {
    const one = await call(registerPostTools, 'band_get_post', { band_no: 9, post_no: 5, include_comments: false }, [fixture('post')]);
    expect(one.sent).toHaveLength(1);
    expect(untrustedPayload<Any>(one.result).comments).toBeUndefined();
    const full = await call(registerPostTools, 'band_get_post', { band_no: 9, post_no: 5, view: 'full' }, [fixture('post'), fixture('comments')]);
    const p = untrustedPayload<Any>(full.result);
    expect(p.post.author.member_key).toBe('sample member_key 18');
    expect(p.comments.items[0].author.name).toBe('sample name 4');
  });

  it('a deleted post is an error', async () => {
    const { result } = await call(registerPostTools, 'band_get_post', { band_no: 9, post_no: 5 }, [fixture('notfound')]);
    expect(result.isError).toBe(true);
  });
});

describe('band_list_comments', () => {
  it('lists comments with paging', async () => {
    const env = fixture('comments') as Any;
    env.result_data.paging.next_params = { last_paging_value: '1' };
    const { result, sent } = await call(registerPostTools, 'band_list_comments', { band_no: 9, post_no: 5 }, [env]);
    expect(sent[0]!.query.get('band_no')).toBe('9');
    const p = untrustedPayload<Any>(result);
    expect(p.total).toBe(1);
    expect(p.comments[0].body).toBe('sample body 1');
    expect(p.next_cursor).toBe(encodeCursor({ last_paging_value: '1' }));
    const next = await call(registerPostTools, 'band_list_comments', { band_no: 9, post_no: 5, cursor: p.next_cursor, view: 'full' }, [fixture('comments')]);
    expect(next.sent[0]!.query.get('last_paging_value')).toBe('1');
    expect(untrustedPayload<Any>(next.result).items[0].comment_id).toBe(1);
    const empty = await call(registerPostTools, 'band_list_comments', { band_no: 9, post_no: 5 }, [ok({})]);
    expect(untrustedPayload(empty.result)).toEqual({ comments: [] });
  });
});

describe('band_list_notices', () => {
  it('reads notices with a limit', async () => {
    const { result, sent } = await call(registerPostTools, 'band_list_notices', { band_no: 9 }, [fixture('notices')]);
    expect(sent[0]!.path).toBe('/v2.0.0/get_band_notices');
    expect(sent[0]!.query.get('limit')).toBe('20');
    expect(untrustedPayload(result)).toEqual({ notices: [] });
  });

  it('projects notice items as posts (wrapped or bare)', async () => {
    const post = (fixture('post') as Any).result_data.post;
    const { result } = await call(registerPostTools, 'band_list_notices', { band_no: 9, limit: 5 }, [ok({ items: [{ post }, post] })]);
    const p = untrustedPayload<Any>(result);
    expect(p.notices.map((n: Any) => n.post_no)).toEqual([5, 5]);
    const full = await call(registerPostTools, 'band_list_notices', { band_no: 9, view: 'full' }, [fixture('notices')]);
    expect(untrustedPayload<Any>(full.result).count).toBe(0);
  });
});

describe('band_search_posts', () => {
  it('searches with the query (null items → none)', async () => {
    const { result, sent } = await call(registerPostTools, 'band_search_posts', { band_no: 9, query: "coach's" }, [fixture('search')]);
    expect(sent[0]!.path).toBe('/v2.0.0/search_posts');
    expect(sent[0]!.query.get('query')).toBe("coach's");
    expect(untrustedPayload(result)).toEqual({ post_total: 0, comment_total: 0, posts: [] });
  });

  it('projects hits', async () => {
    const post = (fixture('post') as Any).result_data.post;
    const { result } = await call(registerPostTools, 'band_search_posts', { band_no: 9, query: 'x' }, [
      ok({ items: [{ post }], post_total: 1, comment_total: 0, paging: { next_params: { page: '2' } } }),
    ]);
    const p = untrustedPayload<Any>(result);
    expect(p.posts[0].post_no).toBe(5);
    expect(p.next_cursor).toBe(encodeCursor({ page: '2' }));
    const full = await call(registerPostTools, 'band_search_posts', { band_no: 9, query: 'x', view: 'full' }, [fixture('search')]);
    expect(untrustedPayload<Any>(full.result).items).toBeNull();
  });
});

describe('band_list_events', () => {
  // 2026-11-11T15:00Z: today in New York is 2026-11-11.
  const NOW = Date.UTC(2026, 10, 11, 15, 0);

  it('defaults to today … +60 days in the user zone, on the default calendar', async () => {
    const { result, sent } = await call(registerEventTools, 'band_list_events', { band_no: 9 }, [fixture('schedules')], { now: NOW });
    expect(sent[0]!.path).toBe('/v1.6.0/get_schedules');
    expect(sent[0]!.query.get('start_at')).toBe('20261111');
    expect(sent[0]!.query.get('future_end_at')).toBe('20270110');
    expect(JSON.parse(sent[0]!.query.get('calendars')!)).toEqual([{ is_default: true }]);
    const p = untrustedPayload<Any>(result);
    expect(p.from).toBe('2026-11-11');
    expect(p.to).toBe('2027-01-10');
    expect(p.events).toHaveLength(3);
    expect(p.events[0]).toEqual({
      schedule_id: 'sample schedule_id 8',
      name: 'sample name 1',
      description: 'sample description 2',
      start_at: 'sample start_at 6',
      end_at: 'sample end_at 7',
      all_day: true,
      type: 'subscribed_calendar',
      calendar: 'sample name 3',
    });
  });

  it('takes an explicit range; rejects a reversed one before calling BAND', async () => {
    const { sent } = await call(registerEventTools, 'band_list_events', { band_no: 9, from: '2026-01-02', to: '2026-03-04' }, [ok({})], { now: NOW });
    expect(sent[0]!.query.get('start_at')).toBe('20260102');
    expect(sent[0]!.query.get('future_end_at')).toBe('20260304');
    const bad = await call(registerEventTools, 'band_list_events', { band_no: 9, from: '2026-03-04', to: '2026-01-02' }, []);
    expect(bad.result.isError).toBe(true);
    expect(bad.sent).toHaveLength(0);
    const bad2 = await call(registerEventTools, 'band_list_events', { band_no: 9, from: '2026-13-40' }, []);
    expect(bad2.result.isError).toBe(true);
  });

  it('only `from` → +60 days from it; full keeps the records', async () => {
    const { result, sent } = await call(registerEventTools, 'band_list_events', { band_no: 9, from: '2026-12-15', view: 'full' }, [fixture('schedules')], { now: NOW });
    expect(sent[0]!.query.get('future_end_at')).toBe('20270213');
    expect(untrustedPayload<Any>(result).items[0].secret_sharers).toEqual([]);
  });
});

describe('band_get_event', () => {
  it('reads one event', async () => {
    const { result, sent } = await call(registerEventTools, 'band_get_event', { band_no: 9, schedule_id: 'abc' }, [fixture('schedule')]);
    expect(sent[0]!.path).toBe('/v1.6.0/get_schedule');
    expect(sent[0]!.query.get('schedule_id')).toBe('abc');
    expect(untrustedPayload(result)).toMatchObject({ schedule_id: 'sample schedule_id 8', name: 'sample name 2', band: 'sample name 10' });
    const full = await call(registerEventTools, 'band_get_event', { band_no: 9, schedule_id: 'abc', view: 'full' }, [fixture('schedule')]);
    expect(untrustedPayload<Any>(full.result).band.band_no).toBe(100009);
  });
});

describe('band_list_chats', () => {
  it('lists chat channels', async () => {
    const env = fixture('chats') as Any;
    env.result_data.channels[0].latest_message = { creator: { name: 'P' }, message: 'hello', created_at: 1794003600000 };
    const { result, sent } = await call(registerChatTools, 'band_list_chats', { band_no: 9 }, [env]);
    expect(sent[0]!.path).toBe('/v2.0.0/get_chat_channels');
    expect(untrustedPayload(result)).toEqual({
      channels: [
        {
          channel_id: 'sample channel_id 22',
          name: 'sample name 1',
          band: 'sample name 19',
          participant_count: 59,
          new_message_count: 0,
          default: true,
          updated_at: iso(1794003600000),
          latest_message: { from: 'P', text: 'hello', at: iso(1794003600000) },
        },
      ],
    });
  });

  it('a placeholder latest_message is dropped; full keeps all; empty → none', async () => {
    const { result } = await call(registerChatTools, 'band_list_chats', { band_no: 9 }, [fixture('chats')]);
    expect(untrustedPayload<Any>(result).channels[0].latest_message).toBeUndefined();
    const full = await call(registerChatTools, 'band_list_chats', { band_no: 9, view: 'full' }, [fixture('chats')]);
    expect(untrustedPayload<Any>(full.result).channels[0].participants).toHaveLength(3);
    const empty = await call(registerChatTools, 'band_list_chats', { band_no: 9 }, [ok({})]);
    expect(untrustedPayload(empty.result)).toEqual({ channels: [] });
  });
});

describe('band_get_chat', () => {
  it('syncs one channel and names its participants (no history)', async () => {
    const { result, sent } = await call(registerChatTools, 'band_get_chat', { channel_id: 'c1' }, [fixture('chatsync')]);
    expect(sent[0]!.path).toBe('/v2.0.3/sync_chat_channel');
    expect(sent[0]!.query.get('channel_id')).toBe('c1');
    expect(sent[0]!.query.get('resolution_type')).toBe('4');
    const p = untrustedPayload<Any>(result);
    expect(p).toMatchObject({ channel_id: 'sample channel_id 24', band: 'sample name 20', participant_count: 59 });
    expect(p.participants).toEqual(['sample name 6', 'sample name 11', 'sample name 16']);
    const full = await call(registerChatTools, 'band_get_chat', { channel_id: 'c1', view: 'full' }, [fixture('chatsync')]);
    expect(untrustedPayload<Any>(full.result).channel.channel_id).toBe('sample channel_id 24');
    const none = await call(registerChatTools, 'band_get_chat', { channel_id: 'c1' }, [ok({})]);
    expect(untrustedPayload(none.result)).toEqual({ participants: [] });
  });
});

describe('band_whats_new', () => {
  it('sends the four required flags and returns the counts', async () => {
    const { result, sent } = await call(registerNewsTools, 'band_whats_new', {}, [fixture('news')]);
    expect(sent[0]!.path).toBe('/v1.2.0/get_news_count');
    expect(Object.fromEntries(sent[0]!.query)).toMatchObject({
      without_post_news: 'false',
      without_album_news: 'false',
      with_chat_message_count: 'true',
      feed_version: '2',
    });
    expect(JSON.parse(textOf(result))).toEqual({ new_feed_count: 4, new_chat_message_count: 0, news_count: 2 });
  });

  it('never leaks the session cookie', async () => {
    const { result, jwt } = await call(registerNewsTools, 'band_whats_new', {}, [fixture('news')], { now: NOW_MS });
    expect(textOf(result)).not.toContain(jwt);
  });
});

describe('sparse upstream shapes', () => {
  it('bands: a row without a band, a band answer without a band', async () => {
    const list = await call(registerBandTools, 'band_list_bands', {}, [ok([{}])]);
    expect(untrustedPayload(list.result)).toEqual({ bands: [{}] });
    const one = await call(registerBandTools, 'band_get_band', { band_no: 1 }, [ok({})]);
    expect(untrustedPayload(one.result)).toEqual({});
  });

  it('members: a nameless member never matches a name filter', async () => {
    const { result } = await call(registerBandTools, 'band_list_members', { band_no: 1, name: 'x' }, [ok({ members: [{ user_no: 1 }] })]);
    expect(untrustedPayload(result)).toEqual({ members: [] });
  });

  it('posts: notice flag, empty/missing photos, wrapper-less feed items, missing post', async () => {
    const env = ok({
      items: [
        { type: 'post', post: { post_no: 1, is_major_notice: true } },
        { type: 'post' },
        { type: 'announcement' },
      ],
    });
    const feed = await call(registerPostTools, 'band_list_posts', { band_no: 1 }, [env]);
    expect(untrustedPayload(feed.result)).toEqual({ items: [{ type: 'post', post_no: 1, notice: true }, { type: 'post' }, { type: 'announcement' }] });
    const post = await call(registerPostTools, 'band_get_post', { band_no: 1, post_no: 1 }, [
      ok({}),
      ok({ items: [{ comment_id: 1, photos: [] }, { comment_id: 2, photos: 'x' }] }),
    ]);
    expect(untrustedPayload(post.result)).toEqual({ post: {}, comments: [{ comment_id: 1 }, { comment_id: 2 }] });
    const noItems = await call(registerPostTools, 'band_get_post', { band_no: 1, post_no: 1 }, [ok({ post: {} }), ok({})]);
    expect(untrustedPayload(noItems.result)).toEqual({ post: {}, comments: [] });
  });

  it('notices without items → none', async () => {
    const { result } = await call(registerPostTools, 'band_list_notices', { band_no: 1 }, [ok({})]);
    expect(untrustedPayload(result)).toEqual({ notices: [] });
  });

  it('search pages with a cursor', async () => {
    const cursor = encodeCursor({ page: '2' })!;
    const { sent } = await call(registerPostTools, 'band_search_posts', { band_no: 1, query: 'x', cursor }, [fixture('search')]);
    expect(sent[0]!.query.get('page')).toBe('2');
  });
});
