# BAND web API — protocol notes

What band-mcp relies on, observed from the band.us web app's own requests and
verified live against a real account. BAND publishes no documentation for this
API; it may change without notice. No cookie, key, band, member or post id from
a real account appears in this repo — every value below is a placeholder.

## Hosts

| Host | What | Reached by |
|---|---|---|
| `https://www.band.us/` | the web app | the user's browser only |
| `https://auth.band.us/` | session + signing key (`/s/login/getKey`) | the user's browser only (through the bridge) |
| `https://api-us.band.us/` | the JSON API every tool calls | this server (plain Node `fetch`) |

Only the US API host is used.

## Session bootstrap

Two things come from the user's signed-in `https://www.band.us/` tab through
the fetchproxy bridge (ContextMint Bridge), lifted together and single-flight:

1. **Cookies** `band_session`, `ai`, `as`, `di`, `BBC`, `language` — exactly
   this cookie scope is declared to the bridge. `band_session` is a JWT whose
   `exp` claim gives the session lifetime (a few days).
2. **The signing key**, from
   `GET https://auth.band.us/s/login/getKey?_t=<ms>&callback=authCallBack_<ms>`.
   - It must be fetched **through the tab**: from Node it answers an empty
     `secretKey`.
   - The callback name must be `authCallBack_<_t>` or the body is empty.
   - The body is JavaScript (JSONP). The fields are read with regexes:
     `secretKey: '<…>'`, `isJwtType: true|false`, `timeCorrection: <ms>`,
     `authenticateState: "<…>"`. Anything but `USER` means not signed in.

The session is cached in memory. It is lifted again when within 10 minutes of
the JWT's `exp`, or once after a `300` answer (below). The server never calls
`auth.band.us/_auth/refresh.jsonp`: rotating the token from Node could sign the
browser out, and the browser renews its own session when the user visits
band.us.

## Signing a request

Every request is `GET|POST https://api-us.band.us<path>?ts=<ms>[&<query>]`:

- `ts` = `Date.now() + clockSkew`, where clockSkew = getKey's `timeCorrection`
  minus the local clock at the moment getKey was fetched.
- `ts` is the first query parameter. The query is percent-encoded, with `'`
  encoded as `%27`. JSON-valued params are sent as their JSON text.
- Header `md` = base64( HMAC-SHA256( key, `<path>?<query>` ) ), over exactly the
  path and query as sent. `key` = base64url-decode(`secretKey`) when
  `isJwtType` is true, else the UTF-8 bytes of `secretKey`.
- For POST the body is `application/x-www-form-urlencoded` and is **not** part
  of the signature; the URL is `<path>?ts=<ms>`.

Other headers: `akey` (the web app's static, public application key),
`language: en`, `DEVICE-TIME-ZONE-ID: <IANA zone>`,
`DEVICE-TIME-ZONE-MS-OFFSET: <offset in ms, e.g. -18000000>`, and `cookie`.

## Responses

Always HTTP 200 with `{ "result_code": <n>, "result_data": … }`.

| `result_code` | Meaning | Handling |
|---|---|---|
| `1` | ok | `result_data` is the answer |
| `300` | not authorized (expired session or stale key) | drop the session, lift it again, retry once; a second `300` is a session error. A session lifted for that same call is not re-lifted (the browser would hand back the same one), and concurrent `300`s share one re-lift |
| `1000` | deleted / not found | tool error |
| `200`, `251` | "Temporary/Unknown error" — usually a bad or missing parameter | tool error |

Any other code is a tool error carrying `result_data.message`.

An answer that is not this envelope at all (an outage page, a proxy error) is
a tool error for a read. For a write it is reported as *outcome unknown*: the
POST may have been applied before something else answered, so the user is told
to re-read the post or comments before retrying.

## Read endpoints

| Endpoint | Params | Answer |
|---|---|---|
| `/v2.1.0/get_profile` | — | the signed-in user (healthcheck probe) |
| `/v1.2.0/get_news_count` | `without_post_news=false`, `without_album_news=false`, `with_chat_message_count=true`, `feed_version=2` (all required) | `new_feed_count`, `new_chat_message_count`, `news_count` |
| `/v2.1.0/get_band_list_with_filter` | `fields=band.band_no,band.name,band.member_count,band.cover`, `include_restricted=false` (both required) | an ARRAY of `{ band: {…} }` |
| `/v2.3.0/get_band_information` | `band_no` | `{ band }` |
| `/v2.0.0/get_members_of_band` | `band_no` | `{ member_count, members: [{ name, role, user_no, me, online, created_at, … }] }` |
| `/v2.0.0/get_posts_and_announcements` | `band_no`, `resolution_type=4`, + the previous page's `next_params` | `{ items: [{ type: "post" \| "announcement", post \| announcement }], paging: { next_params } }` |
| `/v2.0.0/get_post` | `band_no`, `post_no` | `{ post }` |
| `/v2.3.0/get_comments` | `band_no`, `content_key={"content_type":"post","post_no":N}` | `{ items, paging, total }` |
| `/v2.0.0/get_band_notices` | `band_no`, `limit` | the band's notices |
| `/v2.0.0/search_posts` | `band_no`, `query` | `{ items, paging, post_total, comment_total }` |
| `/v1.6.0/get_schedules` | `band_no`, `start_at=YYYYMMDD`, `future_end_at=YYYYMMDD`, `calendars=[{"is_default":true}]` (`[]` returns nothing; omitted is an error) | `{ items: [{ schedule_id, name, description, start_at, end_at, is_all_day, schedule_type, subscribed_calendar }] }` |
| `/v1.6.0/get_schedule` | `band_no`, `schedule_id` | the event |
| `/v2.0.0/get_chat_channels` | `band_no` | `{ channels: [{ channel_id, name, participant_count, new_message_count, updated_at, … }] }` |
| `/v2.0.3/sync_chat_channel` | `channel_id`, `resolution_type=4` | `{ channel: { …, latest_message, participants } }` |

Paging: `paging.next_params` is an object (or `null` on the last page). The
server hands it out as an opaque cursor (base64url JSON) and spreads its keys
back into the next request's query.

Times (`created_at`, `updated_at`) are epoch milliseconds. Post and comment
text carries BAND inline markup such as `<band:refer user_no="…">Name</band:refer>`
and `<band:hashtag>…</band:hashtag>`; the compact view keeps the inner text.

**Chat history** is not exposed by any endpoint found: `sync_chat_channel`
returns only the latest message.

## Write endpoints

POST, form-urlencoded body, URL `<path>?ts=<ms>`, `md` over that URL. Fields
are sent in this order:

- `/v2.0.2/create_post` — `band_no`, `content`, `set_band_notice=false`,
  `set_major_band_notice=false`, `set_linked_band_notice=`,
  `copiable_state=`, `should_disable_comment=false`, `band_notice_unset_at=`,
  `purpose=create`.
- `/v2.3.0/create_comment` — `band_no`, `member_type=membership`, `body`,
  `photos=`, `file=`, `video=`, `content_key={"content_type":"post","post_no":N}`,
  `is_secret=false`, `resolution_type=4`.

Content is plain text (BAND may interpret its own inline markup). RSVP and
every other write are out of scope.
