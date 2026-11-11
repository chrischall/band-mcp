// What's new across all your bands: unread feed, chat and news counts.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { minifiedResult, toolAnnotations } from '@chrischall/mcp-utils';
import type { BandClient } from '../client.js';
import { familyMeta } from './hints.js';

export function registerNewsTools(server: McpServer, client: BandClient): void {
  server.registerTool(
    'band_whats_new',
    {
      description:
        "What's new on BAND across all your bands: how many new feed posts, unread chat messages and news " +
        'notifications are waiting. Follow up with band_list_posts or band_list_chats for the details.',
      annotations: toolAnnotations({ title: "BAND: what's new", readOnly: true, openWorld: true }),
      _meta: familyMeta('whats-new', { aliases: ['band updates', 'band notifications'] }),
      inputSchema: z.object({}),
    },
    async () => {
      const data = await client.get('/v1.2.0/get_news_count', {
        without_post_news: false,
        without_album_news: false,
        with_chat_message_count: true,
        feed_version: 2,
      });
      return minifiedResult(data);
    },
  );
}
