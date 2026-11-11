// Bands and their members.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { UNTRUSTED_DESCRIPTION_SUFFIX, toolAnnotations } from '@chrischall/mcp-utils';
import type { BandClient } from '../client.js';
import { ENDPOINTS } from '../endpoints.js';
import { LOOKUP, familyMeta } from './hints.js';
import { bandNoParam, bandView, prune, respond } from './shared.js';

interface BandRecord {
  band_no?: number;
  name?: string;
  member_count?: number;
  [key: string]: unknown;
}

interface Member {
  user_no?: number;
  name?: string;
  role?: string;
  me?: boolean;
  online?: boolean;
  created_at?: unknown;
  [key: string]: unknown;
}

export const BAND_LIST_FIELDS = 'band.band_no,band.name,band.member_count,band.cover';

export function registerBandTools(server: McpServer, client: BandClient): void {
  server.registerTool(
    'band_list_bands',
    {
      description:
        'List the BAND (band.us) groups you belong to — teams, clubs, classes, families — with each band_no ' +
        '(pass it to every other band_ tool), name and member count. Start here. ' +
        UNTRUSTED_DESCRIPTION_SUFFIX,
      annotations: toolAnnotations({ title: 'List my bands', readOnly: true, openWorld: true }),
      _meta: familyMeta('lookup', { aliases: ['band', 'my bands', 'my groups'] }),
      inputSchema: z.object({ view: bandView('compact keeps band_no, name and member_count; full adds the cover image.') }),
    },
    async ({ view }) => {
      const data = await client.get<Array<{ band?: BandRecord }> | null>(ENDPOINTS.BAND_LIST, {
        fields: BAND_LIST_FIELDS,
        include_restricted: false,
      });
      const rows = Array.isArray(data) ? data : [];
      return respond(
        view,
        { bands: rows },
        (d) => ({
          bands: d.bands.map(({ band: b }) => prune({ band_no: b?.band_no, name: b?.name, member_count: b?.member_count })),
        }),
        'get_band_list_with_filter',
      );
    },
  );

  server.registerTool(
    'band_get_band',
    {
      description:
        "One BAND group's details: name, type, whether it is open or secret, member count, leader, web link and " +
        'whether chat is on. ' +
        UNTRUSTED_DESCRIPTION_SUFFIX,
      annotations: toolAnnotations({ title: 'Get a band', readOnly: true, openWorld: true }),
      _meta: LOOKUP,
      inputSchema: z.object({
        band_no: bandNoParam,
        view: bandView('compact keeps the essentials; full adds every setting and per-section update times.'),
      }),
    },
    async ({ band_no, view }) => {
      const data = await client.get<{ band?: BandRecord }>(ENDPOINTS.BAND_INFO, { band_no });
      return respond(
        view,
        data.band ?? {},
        (b) =>
          prune({
            band_no: b.band_no,
            name: b.name,
            type: b.type,
            open_type: b.open_type,
            member_count: b.member_count,
            leader_name: b.leader_name,
            description: b.description,
            web_url: b.web_url,
            chat_enabled: b.chat_enabled,
          }),
        'get_band_information',
      );
    },
  );

  server.registerTool(
    'band_list_members',
    {
      description:
        "List a BAND group's members — name, role (leader / coleader / member), whether online, when they joined, " +
        'and which one is you — optionally filtered by a name fragment. ' +
        UNTRUSTED_DESCRIPTION_SUFFIX,
      annotations: toolAnnotations({ title: 'List band members', readOnly: true, openWorld: true }),
      _meta: familyMeta('lookup', { aliases: ['band members', 'who is in the band'] }),
      inputSchema: z.object({
        band_no: bandNoParam,
        name: z.string().trim().min(1).optional().describe('Case-insensitive name fragment to filter by.'),
        view: bandView('compact keeps user_no, name, role, online, me and joined_at; full adds profile images.'),
      }),
    },
    async ({ band_no, name, view }) => {
      const data = await client.get<{ member_count?: number; members?: Member[] }>(ENDPOINTS.MEMBERS, { band_no });
      const needle = name?.toLowerCase();
      const members = (data.members ?? []).filter((m) => !needle || String(m.name ?? '').toLowerCase().includes(needle));
      return respond(
        view,
        { member_count: data.member_count, members },
        (d) =>
          prune({
            member_count: d.member_count,
            members: d.members.map((m) =>
              prune({ user_no: m.user_no, name: m.name, role: m.role, online: m.online, me: m.me || undefined, joined_at: m.created_at }),
            ),
          }),
        'get_members_of_band',
      );
    },
  );
}
