// The band feed: posts and announcements, single posts with their comments,
// notices, and post search.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { UNTRUSTED_DESCRIPTION_SUFFIX, toolAnnotations } from '@chrischall/mcp-utils';
import type { BandClient } from '../client.js';
import { ENDPOINTS } from '../endpoints.js';
import { LOOKUP, familyMeta } from './hints.js';
import {
  attachmentCounts,
  authorName,
  bandNoParam,
  bandView,
  cursorParam,
  nextCursorOf,
  pagingParams,
  postNoParam,
  prune,
  respond,
  stripMarkup,
  type Paged,
  type Rec,
} from './shared.js';

/** One post, compact: markup stripped, author by name, attachment counts. */
export function compactPost(p: Rec): Rec {
  return prune({
    post_no: p.post_no,
    band: authorName(p.band as Rec | undefined),
    author: authorName(p.author as Rec | undefined),
    created_at: p.created_at,
    content: stripMarkup(p.content),
    notice: p.is_major_notice === true || undefined,
    comment_count: p.comment_count,
    emotion_count: p.emotion_count,
    read_count: p.read_count,
    attachments: attachmentCounts(p.attachment),
    web_url: p.web_url,
  });
}

/** One comment, compact. */
export function compactComment(c: Rec): Rec {
  return prune({
    comment_id: c.comment_id,
    author: authorName(c.author as Rec | undefined),
    body: stripMarkup(c.body),
    created_at: c.created_at,
    photo_count: Array.isArray(c.photos) && c.photos.length > 0 ? c.photos.length : undefined,
  });
}

/** A feed item: `{type, post|announcement}`. */
function compactFeedItem(item: Rec): Rec {
  if (item.type === 'post' && item.post) return { type: 'post', ...compactPost(item.post as Rec) };
  if (item.type === 'announcement' && item.announcement) {
    const a = item.announcement as Rec;
    return prune({ type: 'announcement', announcement_id: a.announcement_id, text: stripMarkup(a.fallback_message), created_at: a.created_at });
  }
  return { type: item.type };
}

/** A list item that is a post, either bare or wrapped as `{post}`. */
const postOf = (item: Rec): Rec => compactPost((item.post as Rec | undefined) ?? item);

const contentKey = (post_no: number) => ({ content_type: 'post', post_no });

export function registerPostTools(server: McpServer, client: BandClient): void {
  server.registerTool(
    'band_list_posts',
    {
      description:
        "Read a BAND group's feed, newest first: posts (author, text, comment and reaction counts, attachments) and " +
        'band announcements. Pages with next_cursor. ' +
        UNTRUSTED_DESCRIPTION_SUFFIX,
      annotations: toolAnnotations({ title: 'Read band posts', readOnly: true, openWorld: true }),
      _meta: familyMeta('whats-new', { aliases: ['band posts', 'band feed', 'group posts'] }),
      inputSchema: z.object({
        band_no: bandNoParam,
        include_announcements: z.boolean().default(true).describe('Include band announcements alongside posts (default true).'),
        cursor: cursorParam,
        view: bandView('compact strips inline markup and keeps counts; full keeps every field (photos, files, emotions).'),
      }),
    },
    async ({ band_no, include_announcements, cursor, view }) => {
      const paging = pagingParams(cursor);
      const data = await client.get<Paged>(ENDPOINTS.FEED, { band_no, resolution_type: 4, ...paging });
      const items = (data.items ?? []).filter((i) => include_announcements || i.type !== 'announcement');
      return respond(
        view,
        { items, next_cursor: nextCursorOf(data) },
        (d) => prune({ items: d.items.map(compactFeedItem), next_cursor: d.next_cursor }),
        'get_posts_and_announcements',
      );
    },
  );

  server.registerTool(
    'band_get_post',
    {
      description:
        'Read one BAND post in full — its text, author, read count and attachments — and, by default, its comments. ' +
        UNTRUSTED_DESCRIPTION_SUFFIX,
      annotations: toolAnnotations({ title: 'Read a band post', readOnly: true, openWorld: true }),
      _meta: LOOKUP,
      inputSchema: z.object({
        band_no: bandNoParam,
        post_no: postNoParam,
        include_comments: z.boolean().default(true).describe('Also read the first page of comments (default true).'),
        view: bandView('compact strips markup and summarizes attachments; full keeps every field of the post and comments.'),
      }),
    },
    async ({ band_no, post_no, include_comments, view }) => {
      const data = await client.get<{ post?: Rec }>(ENDPOINTS.POST, { band_no, post_no });
      const comments = include_comments
        ? await client.get<Paged & { total?: number }>(ENDPOINTS.COMMENTS, { band_no, content_key: contentKey(post_no) })
        : undefined;
      return respond(
        view,
        prune({ post: data.post ?? {}, comments }),
        (d) =>
          prune({
            post: compactPost(d.post as Rec),
            comments: d.comments ? (d.comments.items ?? []).map(compactComment) : undefined,
            comment_total: d.comments?.total,
            next_comments_cursor: d.comments ? nextCursorOf(d.comments) : undefined,
          }),
        'get_post',
      );
    },
  );

  server.registerTool(
    'band_list_comments',
    {
      description:
        "List the comments on one BAND post — author, text, time, photo count — paging with next_cursor. " +
        UNTRUSTED_DESCRIPTION_SUFFIX,
      annotations: toolAnnotations({ title: 'List post comments', readOnly: true, openWorld: true }),
      _meta: LOOKUP,
      inputSchema: z.object({
        band_no: bandNoParam,
        post_no: postNoParam,
        cursor: cursorParam,
        view: bandView('compact keeps author name, text, time and photo count; full keeps every field.'),
      }),
    },
    async ({ band_no, post_no, cursor, view }) => {
      const paging = pagingParams(cursor);
      const data = await client.get<Paged & { total?: number }>(ENDPOINTS.COMMENTS, {
        band_no,
        content_key: contentKey(post_no),
        ...paging,
      });
      return respond(
        view,
        data,
        (d) => prune({ total: d.total, comments: (d.items ?? []).map(compactComment), next_cursor: nextCursorOf(d) }),
        'get_comments',
      );
    },
  );

  server.registerTool(
    'band_list_notices',
    {
      description:
        "List a BAND group's notices — the posts leaders pinned as important announcements. " + UNTRUSTED_DESCRIPTION_SUFFIX,
      annotations: toolAnnotations({ title: 'List band notices', readOnly: true, openWorld: true }),
      _meta: familyMeta('whats-new', { aliases: ['band notices', 'band announcements'] }),
      inputSchema: z.object({
        band_no: bandNoParam,
        limit: z.number().int().min(1).max(100).default(20).describe('How many notices, 1–100 (default 20).'),
        view: bandView('compact strips markup and keeps counts; full keeps every field.'),
      }),
    },
    async ({ band_no, limit, view }) => {
      const data = await client.get<Paged>(ENDPOINTS.NOTICES, { band_no, limit });
      return respond(view, data, (d) => ({ notices: (d.items ?? []).map(postOf) }), 'get_band_notices');
    },
  );

  server.registerTool(
    'band_search_posts',
    {
      description:
        'Search one BAND group’s posts by keyword and return the matching posts (author, text, counts) with the ' +
        'post and comment hit totals. ' +
        UNTRUSTED_DESCRIPTION_SUFFIX,
      annotations: toolAnnotations({ title: 'Search band posts', readOnly: true, openWorld: true }),
      _meta: LOOKUP,
      inputSchema: z.object({
        band_no: bandNoParam,
        query: z.string().trim().min(1).describe('Words to search for.'),
        cursor: cursorParam,
        view: bandView('compact strips markup and keeps counts; full keeps every field.'),
      }),
    },
    async ({ band_no, query, cursor, view }) => {
      const paging = pagingParams(cursor);
      const data = await client.get<Paged & { post_total?: number; comment_total?: number }>(ENDPOINTS.SEARCH_POSTS, {
        band_no,
        query,
        ...paging,
      });
      return respond(
        view,
        data,
        (d) =>
          prune({
            post_total: d.post_total,
            comment_total: d.comment_total,
            posts: (d.items ?? []).map(postOf),
            next_cursor: nextCursorOf(d),
          }),
        'search_posts',
      );
    },
  );
}
