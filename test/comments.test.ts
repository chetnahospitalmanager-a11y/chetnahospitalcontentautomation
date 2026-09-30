import './setup.ts';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { finishReply, recoverInterruptedCommentReplies, syncComments } from '../src/comments.ts';
import { getCommentByRef, listCommentRows, transitionComment } from '../src/db.ts';
import { createApp } from '../src/web/app.ts';

const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString().replace('.000Z', '+0000');

// ---- fake Graph API ----
const fbComments: Record<string, unknown>[] = [
  { id: 'fc1', message: 'What are the OPD timings for cardiology?', created_time: ago(2), from: { id: 'u1', name: 'Sunil' } },
  { id: 'fc2', message: 'I have chest pain right now what should I do', created_time: ago(1), from: { id: 'u2', name: 'Kavita' } },
  { id: 'fc3', message: '@Rahul see this', created_time: ago(3), from: { id: 'u3', name: 'Priya' } },
  { id: 'fc4', message: 'Buy cheap followers www.spam.example', created_time: ago(4), from: { id: 'u4', name: 'Spammer' } },
  { id: 'fc5', message: 'Already answered', created_time: ago(5), from: { id: 'u5', name: 'Anil' }, comments: { data: [{ from: { id: 'page1' } }] } },
  { id: 'fc6', message: 'Our own note', created_time: ago(5), from: { id: 'page1', name: 'Chetna Hospital' } },
  { id: 'fc7', message: 'Very old comment', created_time: ago(24 * 20), from: { id: 'u7', name: 'Old' } },
];
const igComments: Record<string, unknown>[] = [
  { id: 'ic1', text: 'Great doctors and staff', username: 'meera_k', timestamp: ago(2) },
  { id: 'ic2', text: 'thanks', username: 'chetnahospital', timestamp: ago(1) },
];
const posts: { path: string; params: Record<string, string> }[] = [];
let failNextReply = false;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  if (url.hostname === 'generativelanguage.googleapis.com') {
    const body = JSON.parse(String(init!.body));
    const prompt: string = body.contents[0].parts[0].text;
    const pick = (): object => {
      if (prompt.includes('Rewrite the reply')) return { category: 'praise', needs_reply: false, reply: 'Rewritten: thank you for your question. [BOOKING_LINK]' };
      if (prompt.includes('OPD timings')) return { category: 'question', needs_reply: true, reply: 'Thank you for asking! Please contact us for timings. You can book here: [BOOKING_LINK] https://evil.example' };
      if (prompt.includes('chest pain')) return { category: 'emergency', needs_reply: false, reply: 'Please come to our emergency department immediately; it is open 24x7.' };
      if (prompt.includes('@Rahul')) return { category: 'other', needs_reply: false, reply: 'Thank you! 🙏' };
      if (prompt.includes('cheap followers')) return { category: 'spam', needs_reply: false, reply: '' };
      if (prompt.includes('Great doctors')) return { category: 'praise', needs_reply: true, reply: 'Thank you so much, Meera! Book any time via [BOOKING_LINK]' };
      return { category: 'other', needs_reply: true, reply: 'Thank you.' };
    };
    return json({ candidates: [{ content: { parts: [{ text: JSON.stringify(pick()) }] } }] });
  }

  if (url.hostname === 'graph.facebook.com') {
    const path = url.pathname.replace(/^\/v[\d.]+\//, '');
    if (init?.method === 'POST') {
      const params = Object.fromEntries(new URLSearchParams(String(init.body)));
      assert.equal(params.access_token, 'tok');
      delete params.access_token;
      if (failNextReply && /\/(comments|replies)$/.test(path)) {
        failNextReply = false;
        return json({ error: { message: 'Temporary Meta error' } }, 500);
      }
      posts.push({ path, params });
      return json({ id: 'new1', success: true });
    }
    if (path === 'page1/published_posts') return json({ data: [{ id: 'post1', message: 'World Heart Day\nTake care', permalink_url: 'https://fb/post1' }] });
    if (path === 'post1/comments') {
      assert.equal(url.searchParams.get('filter'), 'toplevel');
      return json({ data: fbComments });
    }
    if (path === 'ig1') return json({ username: 'chetnahospital' });
    if (path === 'ig1/media') return json({ data: [{ id: 'm1', caption: 'Knee care tips', permalink: 'https://ig/m1', timestamp: ago(30) }] });
    if (path === 'm1/comments') return json({ data: igComments });
  }
  if (!url.href.startsWith('http://127.0.0.1')) throw new Error(`Unexpected network call in tests: ${url}`);
  return realFetch(input, init);
}) as typeof fetch;

let server: Server;
let base = '';
let cookie = '';
before(async () => {
  process.env.GEMINI_API_KEY = 'fake';
  process.env.META_PAGE_ID = 'page1';
  process.env.META_PAGE_ACCESS_TOKEN = 'tok';
  process.env.META_IG_USER_ID = 'ig1';
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const r = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
    body: new URLSearchParams({ password: 'test-password' }),
    redirect: 'manual',
  });
  cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
});
after(() => {
  server.close();
  globalThis.fetch = realFetch;
});

async function form(path: string, data: Record<string, string>) {
  const html = await (await fetch(`${base}/comments`, { headers: { cookie } })).text();
  const csrf = html.match(/name="_csrf" value="([^"]+)"/)![1];
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base, cookie },
    body: new URLSearchParams({ _csrf: csrf, ...data }),
    redirect: 'manual',
  });
}
const row = async (p: 'facebook' | 'instagram', id: string) => (await getCommentByRef(p, id))!;

test('booking placeholder becomes a WhatsApp link on Facebook and a bio pointer on Instagram', () => {
  assert.equal(finishReply('facebook', 'Book here: [BOOKING_LINK]'), 'Book here: https://wa.me/910000000000');
  assert.equal(finishReply('instagram', 'Book here: [BOOKING_LINK]'), 'Book here: the WhatsApp link in our bio');
  assert.equal(finishReply('facebook', 'Visit https://evil.example today'), 'Visit today', 'model-written links are removed');
});

test('sync picks up new comments from others, skips answered/own/old ones, and classifies them', async () => {
  const s = await syncComments();
  assert.deepEqual(s.checked, ['Facebook', 'Instagram']);
  assert.equal(s.newComments, 5); // fc1-fc4 + ic1
  assert.equal(s.drafted, 5);
  assert.deepEqual(s.errors, []);
  for (const id of ['fc5', 'fc6', 'fc7']) assert.equal(await getCommentByRef('facebook', id), null, id);
  assert.equal(await getCommentByRef('instagram', 'ic2'), null, 'our own Instagram comment');

  const q = await row('facebook', 'fc1');
  assert.equal(q.category, 'question');
  assert.equal(q.needsReply, true);
  assert.match(q.reply, /You can book here: https:\/\/wa\.me\/910000000000$/);
  assert.equal(q.postText, 'World Heart Day');

  const e = await row('facebook', 'fc2');
  assert.equal(e.category, 'emergency');
  assert.equal(e.needsReply, true, 'emergencies always need a reply, whatever Gemini said');

  assert.equal((await row('facebook', 'fc3')).needsReply, false);
  assert.equal((await row('facebook', 'fc4')).category, 'spam');
  assert.match((await row('instagram', 'ic1')).reply, /the WhatsApp link in our bio/);
});

test('a second sync adds nothing', async () => {
  const s = await syncComments();
  assert.equal(s.newComments, 0);
  assert.equal(s.drafted, 0);
});

test('the page puts emergencies first and tucks away comments that need no reply', async () => {
  const html = await (await fetch(`${base}/comments`, { headers: { cookie } })).text();
  assert.match(html, /Needs a reply \(3\)/);
  assert.ok(html.indexOf('chest pain') < html.indexOf('OPD timings'), 'emergency above the question');
  assert.match(html, /Possible emergency/);
  assert.match(html, /Probably no reply needed \(2\)/);
  assert.match(html, /Post reply on Instagram/);
});

test('posting replies uses the right endpoint on each platform, and never twice', async () => {
  const fb = await row('facebook', 'fc1');
  let r = await form(`/comments/${fb.id}/post`, {});
  assert.equal(r.status, 303);
  assert.equal((await row('facebook', 'fc1')).status, 'replied');
  assert.deepEqual(posts.at(-1), { path: 'fc1/comments', params: { message: fb.reply } });

  const ig = await row('instagram', 'ic1');
  await form(`/comments/${ig.id}/post`, {});
  assert.deepEqual(posts.at(-1), { path: 'ic1/replies', params: { message: ig.reply } });

  const before = posts.length;
  r = await form(`/comments/${fb.id}/post`, {});
  assert.equal(r.status, 400);
  assert.equal(posts.length, before);
});

test('a failed reply shows the error and can be retried', async () => {
  const c = await row('facebook', 'fc2');
  failNextReply = true;
  await form(`/comments/${c.id}/post`, {});
  let after = await row('facebook', 'fc2');
  assert.equal(after.status, 'failed');
  assert.match(after.error, /Temporary Meta error/);
  await form(`/comments/${c.id}/post`, {});
  after = await row('facebook', 'fc2');
  assert.equal(after.status, 'replied');
});

test('spam can be hidden', async () => {
  const c = await row('facebook', 'fc4');
  const r = await form(`/comments/${c.id}/hide`, {});
  assert.equal(r.status, 303);
  assert.deepEqual(posts.at(-1), { path: 'fc4', params: { is_hidden: 'true' } });
  assert.equal((await row('facebook', 'fc4')).status, 'hidden');
});

test('editing a reply re-checks wording; a medical claim needs the wording box ticked', async () => {
  const c = await row('facebook', 'fc3');
  await form(`/comments/${c.id}/save`, { reply: 'Our treatment guarantees a cure!' });
  const saved = await row('facebook', 'fc3');
  assert.ok(saved.warnings.length >= 2);
  const r = await form(`/comments/${c.id}/post`, {});
  assert.equal(r.status, 400);
  assert.match(await r.text(), /I have checked the wording/);
});

test('rewriting keeps the original classification', async () => {
  const c = await row('facebook', 'fc3');
  await form(`/comments/${c.id}/revise`, { feedback: 'friendlier' });
  const after = await row('facebook', 'fc3');
  assert.match(after.reply, /^Rewritten:/);
  assert.equal(after.category, 'other');
  assert.equal(after.needsReply, false);
});

test('a comment answered in the Meta app meanwhile is not answered again', async () => {
  fbComments[2].comments = { data: [{ from: { id: 'page1' } }] }; // fc3
  const s = await syncComments();
  assert.equal(s.repliedElsewhere, 1);
  assert.equal((await row('facebook', 'fc3')).status, 'replied_elsewhere');
});

test('a reply interrupted by a restart is flagged to check before re-posting (Meta would duplicate it)', async () => {
  igComments.push({ id: 'ic3', text: 'Is parking available?', username: 'dev', timestamp: ago(1) });
  await syncComments();
  const c = await row('instagram', 'ic3');
  assert.ok(await transitionComment(c.id, ['draft'], 'posting'));
  await recoverInterruptedCommentReplies();
  const after = await row('instagram', 'ic3');
  assert.equal(after.status, 'failed');
  assert.match(after.error, /may already be there/);
  assert.equal((await listCommentRows({ status: ['posting'] })).length, 0);
});

test('comments cron endpoint needs the secret', async () => {
  const r = await fetch(`${base}/cron/comments`, { method: 'POST' });
  assert.equal(r.status, 403);
});
