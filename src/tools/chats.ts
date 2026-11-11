// Band chats: the channel list and one channel's sync. BAND's web API does not
// serve chat message history, so only each channel's latest message is shown.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { UNTRUSTED_DESCRIPTION_SUFFIX, toolAnnotations } from '@chrischall/mcp-utils';
import type { BandClient } from '../client.js';
import { ENDPOINTS } from '../endpoints.js';
import { LOOKUP } from './hints.js';
import { authorName, bandNoParam, bandView, prune, respond, stripMarkup, type Rec } from './shared.js';

const NO_HISTORY = 'Chat message history is not available through this API — only the latest message.';

/** A channel's latest message, compact; a placeholder with no text → undefined. */
function latest(m: unknown): Rec | undefined {
  if (typeof m !== 'object' || m === null) return undefined;
  const msg = m as Rec;
  const text = stripMarkup(msg.message ?? msg.content ?? msg.body);
  if (!text) return undefined;
  return prune({ from: authorName(msg.creator as Rec | undefined), text, at: msg.created_at });
}

function compactChannel(c: Rec): Rec {
  return prune({
    channel_id: c.channel_id,
    name: c.name,
    band: authorName(c.band as Rec | undefined),
    participant_count: c.participant_count,
    new_message_count: c.new_message_count,
    default: c.is_default_channel,
    updated_at: c.updated_at,
    latest_message: latest(c.latest_message),
  });
}

export function registerChatTools(server: McpServer, client: BandClient): void {
  server.registerTool(
    'band_list_chats',
    {
      description:
        "List a BAND group's chat channels — name, participants, unread count, last activity and latest message. " +
        `${NO_HISTORY} ${UNTRUSTED_DESCRIPTION_SUFFIX}`,
      annotations: toolAnnotations({ title: 'List band chats', readOnly: true, openWorld: true }),
      _meta: LOOKUP,
      inputSchema: z.object({
        band_no: bandNoParam,
        view: bandView('compact keeps id, name, counts, last activity and latest message; full adds participants and settings.'),
      }),
    },
    async ({ band_no, view }) => {
      const data = await client.get<{ channels?: Rec[] }>(ENDPOINTS.CHAT_CHANNELS, { band_no });
      return respond(view, { channels: data.channels ?? [] }, (d) => ({ channels: d.channels.map(compactChannel) }), 'get_chat_channels');
    },
  );

  server.registerTool(
    'band_get_chat',
    {
      description:
        'Read one BAND chat channel — its band, participants, unread state and latest message. ' +
        `${NO_HISTORY} ${UNTRUSTED_DESCRIPTION_SUFFIX}`,
      annotations: toolAnnotations({ title: 'Get a band chat', readOnly: true, openWorld: true }),
      _meta: LOOKUP,
      inputSchema: z.object({
        channel_id: z.string().trim().min(1).describe('The chat channel id — from band_list_chats.'),
        view: bandView('compact keeps the channel summary and participant names; full keeps every field.'),
      }),
    },
    async ({ channel_id, view }) => {
      const data = await client.get<{ channel?: Rec }>(ENDPOINTS.CHAT_SYNC, { channel_id, resolution_type: 4 });
      return respond(
        view,
        data,
        (d) => {
          const c = d.channel ?? {};
          const participants = Array.isArray(c.participants) ? (c.participants as Rec[]) : [];
          return {
            ...compactChannel(c),
            participants: participants.map((p) => authorName(p)).filter((n): n is string => n !== undefined),
          };
        },
        'sync_chat_channel',
      );
    },
  );
}
