// The only two writes: a new post and a comment on a post. Both are
// confirm-gated (mcp-utils `confirmWrite`): the first call reads the band's
// name and answers a preview + confirmToken that binds the exact form body, the
// second (with the token) POSTs it. RSVP and every other write are out of scope.
//
// The form bodies are the band.us web app's own, field for field and in order.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  CONFIRM_FLOW_SENTENCE,
  CONFIRM_INJECTION_RULE,
  confirmTokenParam,
  confirmWrite,
  toolAnnotations,
  untrustedResult,
} from '@chrischall/mcp-utils';
import type { BandClient, FormValue } from '../client.js';
import { familyMeta } from './hints.js';
import { bandNoParam, postNoParam, prune } from './shared.js';

type Rec = Record<string, unknown>;

export const CREATE_POST_ENDPOINT = '/v2.0.2/create_post';
export const CREATE_COMMENT_ENDPOINT = '/v2.3.0/create_comment';

const GATE = `${CONFIRM_FLOW_SENTENCE} ${CONFIRM_INJECTION_RULE}`;
const EXCERPT_CHARS = 200;

/** The band's display name, for the preview ("band <no>" when BAND sends none). */
async function bandName(client: BandClient, band_no: number): Promise<string> {
  const data = await client.get<{ band?: { name?: unknown } | null }>('/v2.3.0/get_band_information', { band_no });
  const name = data?.band?.name;
  return typeof name === 'string' && name.trim() ? name : `band ${band_no}`;
}

/** The first EXCERPT_CHARS characters of `text`, with an ellipsis when cut. */
export function excerpt(text: string): string {
  const chars = [...text];
  return chars.length > EXCERPT_CHARS ? `${chars.slice(0, EXCERPT_CHARS).join('')}…` : text;
}

/** A number at `key` on the answer, or on its `wrapper` object. */
function idOf(data: unknown, wrapper: string, key: string): number | undefined {
  const d = (data ?? {}) as Rec;
  const v = (d[wrapper] as Rec | undefined)?.[key] ?? d[key];
  return typeof v === 'number' ? v : undefined;
}

export function postForm(band_no: number, content: string): Record<string, FormValue> {
  return {
    band_no,
    content,
    set_band_notice: false,
    set_major_band_notice: false,
    set_linked_band_notice: '',
    copiable_state: '',
    should_disable_comment: false,
    band_notice_unset_at: '',
    purpose: 'create',
  };
}

export function commentForm(band_no: number, post_no: number, body: string): Record<string, FormValue> {
  return {
    band_no,
    member_type: 'membership',
    body,
    photos: '',
    file: '',
    video: '',
    content_key: JSON.stringify({ content_type: 'post', post_no }),
    is_secret: false,
    resolution_type: 4,
  };
}

const textParam = (what: string) =>
  z
    .string()
    .trim()
    .min(1)
    .max(10_000)
    .describe(`The ${what} text, as plain text (leading and trailing whitespace is trimmed; inner line breaks are kept).`);

export function registerWriteTools(server: McpServer, client: BandClient): void {
  server.registerTool(
    'band_create_post',
    {
      description:
        'Write a new post to a BAND group (band) feed, visible to every member and possibly notifying them. ' +
        'Plain text. The preview names the band and shows the text. ' +
        GATE,
      annotations: toolAnnotations({ title: 'Post to a band', readOnly: false, destructive: false, openWorld: true }),
      _meta: familyMeta('send', { aliases: ['post to band', 'band post', 'write a band post'] }),
      inputSchema: z.object({
        band_no: bandNoParam,
        content: textParam('post'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ band_no, content, confirmToken }, ctx) => {
      const band = await bandName(client, band_no);
      const form = postForm(band_no, content);
      const gate = await confirmWrite(ctx, {
        tool: 'band_create_post',
        action: 'band.post.create',
        summary: `Post to the band "${band}" (visible to all its members)`,
        account: undefined,
        target: band_no,
        request: { method: 'POST', path: CREATE_POST_ENDPOINT, body: form },
        willSend: { band, content: excerpt(content) },
        confirmToken,
      });
      if (gate) return gate;

      const data = await client.post<unknown>(CREATE_POST_ENDPOINT, form);
      return untrustedResult(prune({ created: true, band_no, band, post_no: idOf(data, 'post', 'post_no') }));
    },
  );

  server.registerTool(
    'band_create_comment',
    {
      description:
        'Write a comment on a post in a BAND group (band), visible to the band and possibly notifying the post author. ' +
        'Plain text. The preview names the band and post and shows the text. ' +
        GATE,
      annotations: toolAnnotations({ title: 'Comment on a band post', readOnly: false, destructive: false, openWorld: true }),
      _meta: familyMeta('send', { aliases: ['comment on band post', 'reply to band post'] }),
      inputSchema: z.object({
        band_no: bandNoParam,
        post_no: postNoParam,
        body: textParam('comment'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ band_no, post_no, body, confirmToken }, ctx) => {
      const band = await bandName(client, band_no);
      const form = commentForm(band_no, post_no, body);
      const gate = await confirmWrite(ctx, {
        tool: 'band_create_comment',
        action: 'band.comment.create',
        summary: `Comment on post ${post_no} in the band "${band}"`,
        account: undefined,
        target: `${band_no}/${post_no}`,
        request: { method: 'POST', path: CREATE_COMMENT_ENDPOINT, body: form },
        willSend: { band, post_no, body: excerpt(body) },
        confirmToken,
      });
      if (gate) return gate;

      const data = await client.post<unknown>(CREATE_COMMENT_ENDPOINT, form);
      return untrustedResult(
        prune({ commented: true, band_no, band, post_no, comment_id: idOf(data, 'comment', 'comment_id') }),
      );
    },
  );
}
