import { afterEach, describe, expect, it } from 'vitest';
import { parseToolResult, type TestHarness } from '@chrischall/mcp-utils/test';
import { createHmac } from 'node:crypto';
import { excerpt, registerWriteTools } from '../src/tools/writes.js';
import { NOW_MS, SECRET, bandSessionJwt, fixture, ok, textOf, toolHarness, untrustedPayload, type SentRequest } from './helpers.js';

// Placeholder bands, posts and text only — never a real band, member or id.

let harness: TestHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

interface Preview {
  status: string;
  confirmToken: string;
  preview: Record<string, unknown> & { action: string };
}

const isPost = (s: SentRequest) => s.method === 'POST';

/** Phase 1 (preview), then phase 2 with the token — and `phase2Args` overriding the args when given. */
async function twoPhase(name: string, args: Record<string, unknown>, script: unknown[], phase2Args?: Record<string, unknown>) {
  const t = await toolHarness(registerWriteTools, script);
  harness = t.harness;
  const first = parseToolResult<Preview>(await t.harness.callTool(name, args));
  const phase1 = t.sent.slice();
  const result = await t.harness.callTool(name, { ...(phase2Args ?? args), confirmToken: first.confirmToken });
  return { preview: first, phase1, result, sent: t.sent.slice(phase1.length) };
}

/** md the way BAND checks it: HMAC-SHA256 over `path?query` with the base64url-decoded secret. */
function expectedMd(s: SentRequest): string {
  return createHmac('sha256', Buffer.from(SECRET, 'base64url')).update(`${s.path}?${s.query.toString()}`).digest('base64');
}

describe('band_create_post', () => {
  const args = { band_no: 100001, content: 'Practice moved to 6pm — bring water.' };

  it('previews without POSTing, naming the band and the content', async () => {
    const t = await toolHarness(registerWriteTools, [fixture('bandinfo')]);
    harness = t.harness;
    const first = parseToolResult<Preview>(await t.harness.callTool('band_create_post', args));
    expect(first.status).toBe('confirmation-required');
    expect(typeof first.confirmToken).toBe('string');
    expect(t.sent.filter(isPost)).toEqual([]);
    expect(t.sent.map((s) => s.path)).toEqual(['/v2.3.0/get_band_information']);
    const shown = JSON.stringify(first.preview);
    expect(shown).toContain('sample name 2');
    expect(shown).toContain('Practice moved to 6pm');
  });

  it('with the token POSTs the exact form body to create_post, signed over path?ts=', async () => {
    const { phase1, sent, result } = await twoPhase('band_create_post', args, [
      fixture('bandinfo'),
      fixture('bandinfo'),
      ok({ post: { post_no: 4242, band_no: 100001 } }),
    ]);
    expect(phase1.filter(isPost)).toEqual([]);
    const post = sent.find(isPost)!;
    expect(post.path).toBe('/v2.0.2/create_post');
    expect([...post.query.keys()]).toEqual(['ts']);
    expect(post.query.get('ts')).toBe(String(NOW_MS));
    expect(post.md).toBe(expectedMd(post));
    expect(post.body).toBe(
      'band_no=100001&content=Practice+moved+to+6pm+%E2%80%94+bring+water.&set_band_notice=false&set_major_band_notice=false' +
        '&set_linked_band_notice=&copiable_state=&should_disable_comment=false&band_notice_unset_at=&purpose=create',
    );
    expect(sent.filter(isPost)).toHaveLength(1);
    expect(untrustedPayload(result)).toMatchObject({ created: true, band_no: 100001, post_no: 4242 });
  });

  it('reads post_no from a bare answer too, and leaves it out when BAND sends none', async () => {
    const bare = await twoPhase('band_create_post', args, [fixture('bandinfo'), fixture('bandinfo'), ok({ post_no: 7 })]);
    expect(untrustedPayload(bare.result)).toMatchObject({ created: true, post_no: 7 });
    await harness?.close();
    const none = await twoPhase('band_create_post', args, [fixture('bandinfo'), fixture('bandinfo'), ok(null)]);
    const payload = untrustedPayload(none.result);
    expect(payload.created).toBe(true);
    expect(payload).not.toHaveProperty('post_no');
  });

  it('a token minted for other content does not post', async () => {
    const { result, sent } = await twoPhase(
      'band_create_post',
      args,
      [fixture('bandinfo'), fixture('bandinfo'), ok({ post_no: 1 })],
      { ...args, content: 'Something else entirely' },
    );
    expect(sent.filter(isPost)).toEqual([]);
    expect(result.isError ?? JSON.parse(textOf(result)).status === 'confirmation-required').toBeTruthy();
  });

  it('a token minted for another band does not post', async () => {
    const { result, sent } = await twoPhase(
      'band_create_post',
      args,
      [fixture('bandinfo'), fixture('bandinfo'), ok({ post_no: 1 })],
      { ...args, band_no: 100003 },
    );
    expect(sent.filter(isPost)).toEqual([]);
    expect(result.isError ?? JSON.parse(textOf(result)).status === 'confirmation-required').toBeTruthy();
  });

  it('surfaces a BAND error from the POST', async () => {
    const { result } = await twoPhase('band_create_post', args, [
      fixture('bandinfo'),
      fixture('bandinfo'),
      { result_code: 1000, result_data: { message: 'This band does not exist.' } },
    ]);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('This band does not exist.');
    expect(textOf(result)).toContain('result_code 1000');
  });

  it('a band BAND cannot find fails before any preview', async () => {
    const t = await toolHarness(registerWriteTools, [fixture('notfound')]);
    harness = t.harness;
    const result = await t.harness.callTool('band_create_post', args);
    expect(result.isError).toBe(true);
    expect(t.sent.filter(isPost)).toEqual([]);
  });

  it('previews with the band number when BAND sends no name', async () => {
    const t = await toolHarness(registerWriteTools, [ok({ band: {} })]);
    harness = t.harness;
    const first = parseToolResult<Preview>(await t.harness.callTool('band_create_post', args));
    expect(JSON.stringify(first.preview)).toContain('band 100001');
  });

  it('rejects blank content', async () => {
    const t = await toolHarness(registerWriteTools, []);
    harness = t.harness;
    const result = await t.harness.callTool('band_create_post', { band_no: 100001, content: '   ' });
    expect(result.isError).toBe(true);
    expect(t.sent).toEqual([]);
  });
});

describe('account binding', () => {
  it('a token previewed as one BAND account is refused once the browser is signed in as another', async () => {
    let userNo = 1;
    const t = await toolHarness(registerWriteTools, [fixture('bandinfo'), fixture('bandinfo')], {
      cookies: async () => ({ band_session: bandSessionJwt(86_400, { userNo }) }),
    });
    harness = t.harness;
    const args = { band_no: 100001, content: 'hello' };
    const first = parseToolResult<Preview>(await t.harness.callTool('band_create_post', args));
    userNo = 2;
    t.client.session.invalidate(t.client.session.peek()!);
    const second = await t.harness.callTool('band_create_post', { ...args, confirmToken: first.confirmToken });
    expect(t.sent.filter(isPost)).toEqual([]);
    expect(textOf(second)).toMatch(/DRAFT_CHANGED|changed|account/i);
  });
});

describe('band_create_comment', () => {
  const args = { band_no: 100001, post_no: 555, body: 'Count me in!' };

  it('previews without POSTing, naming the band, the post and the comment', async () => {
    const t = await toolHarness(registerWriteTools, [fixture('bandinfo')]);
    harness = t.harness;
    const first = parseToolResult<Preview>(await t.harness.callTool('band_create_comment', args));
    expect(first.status).toBe('confirmation-required');
    expect(t.sent.filter(isPost)).toEqual([]);
    const shown = JSON.stringify(first.preview);
    expect(shown).toContain('sample name 2');
    expect(shown).toContain('555');
    expect(shown).toContain('Count me in!');
  });

  it('with the token POSTs the exact form body to create_comment', async () => {
    const { sent, result } = await twoPhase('band_create_comment', args, [
      fixture('bandinfo'),
      fixture('bandinfo'),
      ok({ comment: { comment_id: 9001 } }),
    ]);
    const post = sent.find(isPost)!;
    expect(post.path).toBe('/v2.3.0/create_comment');
    expect([...post.query.keys()]).toEqual(['ts']);
    expect(post.md).toBe(expectedMd(post));
    expect(post.body).toBe(
      'band_no=100001&member_type=membership&body=Count+me+in%21&photos=&file=&video=' +
        '&content_key=%7B%22content_type%22%3A%22post%22%2C%22post_no%22%3A555%7D&is_secret=false&resolution_type=4',
    );
    expect(untrustedPayload(result)).toMatchObject({ commented: true, band_no: 100001, post_no: 555, comment_id: 9001 });
  });

  it('reads comment_id from a bare answer, and leaves it out when BAND sends none', async () => {
    const bare = await twoPhase('band_create_comment', args, [fixture('bandinfo'), fixture('bandinfo'), ok({ comment_id: 3 })]);
    expect(untrustedPayload(bare.result)).toMatchObject({ commented: true, comment_id: 3 });
    await harness?.close();
    const none = await twoPhase('band_create_comment', args, [fixture('bandinfo'), fixture('bandinfo'), ok(null)]);
    expect(untrustedPayload(none.result)).not.toHaveProperty('comment_id');
  });

  it('a token minted for another post does not comment', async () => {
    const { result, sent } = await twoPhase(
      'band_create_comment',
      args,
      [fixture('bandinfo'), fixture('bandinfo'), ok({ comment_id: 1 })],
      { ...args, post_no: 556 },
    );
    expect(sent.filter(isPost)).toEqual([]);
    expect(result.isError ?? JSON.parse(textOf(result)).status === 'confirmation-required').toBeTruthy();
  });

  it('surfaces a BAND error from the POST', async () => {
    const { result } = await twoPhase('band_create_comment', args, [
      fixture('bandinfo'),
      fixture('bandinfo'),
      { result_code: 1000, result_data: { message: 'The post was deleted.' } },
    ]);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('The post was deleted.');
  });
});

describe('excerpt', () => {
  it('keeps short text and cuts long text at 200 characters with an ellipsis', () => {
    expect(excerpt('short')).toBe('short');
    const long = 'é'.repeat(250);
    expect(excerpt(long)).toBe(`${'é'.repeat(200)}…`);
  });
});
