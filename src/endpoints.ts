// Every BAND API endpoint this server calls, in one place. Each must also be
// documented in docs/BAND-API.md (tests/docs.test.ts checks).

export const ENDPOINTS = {
  BAND_LIST: '/v2.1.0/get_band_list_with_filter',
  BAND_INFO: '/v2.3.0/get_band_information',
  MEMBERS: '/v2.0.0/get_members_of_band',
  FEED: '/v2.0.0/get_posts_and_announcements',
  POST: '/v2.0.0/get_post',
  COMMENTS: '/v2.3.0/get_comments',
  NOTICES: '/v2.0.0/get_band_notices',
  SEARCH_POSTS: '/v2.0.0/search_posts',
  SCHEDULES: '/v1.6.0/get_schedules',
  SCHEDULE: '/v1.6.0/get_schedule',
  CHAT_CHANNELS: '/v2.0.0/get_chat_channels',
  CHAT_SYNC: '/v2.0.3/sync_chat_channel',
  NEWS_COUNT: '/v1.2.0/get_news_count',
  PROFILE: '/v2.1.0/get_profile',
  CREATE_POST: '/v2.0.2/create_post',
  CREATE_COMMENT: '/v2.3.0/create_comment',
} as const;
