import './setup.ts';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { replyWarnings } from '../src/compliance.ts';
import { getReviewByName, listReviewRows } from '../src/db.ts';
import { syncReviews } from '../src/reviews.ts';
import { createApp } from '../src/web/app.ts';

// ---- fake Google Business Profile API + Gemini ----
const days = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
type FakeReview = { name: string; reviewer: { displayName: string }; starRating: string; comment?: string; createTime: string; updateTime: string; reviewReply?: { comment: string } };
const reviews: Record<string, FakeReview[]> = {
  'locations/1': [
    { name: 'accounts/9/locations/1/reviews/a', reviewer: { displayName: 'Asha K' }, starRating: 'FIVE', comment: 'Very caring staff.', createTime: days(1), updateTime: days(1) },
    { name: 'accounts/9/locations/1/reviews/b', reviewer: { displayName: 'Ravi P' }, starRating: 'ONE', comment: 'Waited 3 hours at reception.', createTime: days(2), updateTime: days(2) },
    { name: 'accounts/9/locations/1/reviews/c', reviewer: { displayName: 'Old Answered' }, starRating: 'FOUR', comment: 'Good.', createTime: days(3), updateTime: days(3), reviewReply: { comment: 'Thanks!' } },
    { name: 'accounts/9/locations/1/reviews/d', reviewer: { displayName: 'Too Old' }, starRating: 'TWO', comment: 'Meh.', createTime: days(200), updateTime: days(200) },
  ],
  'locations/2': [{ name: 'accounts/9/locations/2/reviews/e', reviewer: { displayName: 'Meera' }, starRating: 'FIVE', createTime: days(1), updateTime: days(1) }],
};
const puts: { url: string; body: { comment: string } }[] = [];
let failNextPut = false;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (url.startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 'at', expires_in: 3600 });
  if (url.startsWith('https://mybusinessaccountmanagement.googleapis.com/v1/accounts')) return json({ accounts: [{ name: 'accounts/9' }] });
  if (url.includes('mybusinessbusinessinformation.googleapis.com/v1/accounts/9/locations'))
    return json({ locations: [{ name: 'locations/1', title: 'Chetna Hospital' }, { name: 'locations/2', title: 'Dr. Nirmal Patil' }] });
  const m = url.match(/mybusiness\.googleapis\.com\/v4\/accounts\/9\/(locations\/\d+)\/reviews\?/);
  if (m) return json({ reviews: reviews[m[1]] ?? [] });
  if (url.includes('mybusiness.googleapis.com/v4/') && url.endsWith('/reply') && init?.method === 'PUT') {
    if (failNextPut) {
      failNextPut = false;
      return json({ error: { message: 'Temporary Google error' } }, 503);
    }
    puts.push({ url, body: JSON.parse(String(init.body)) });
    return json({ comment: 'ok' });
  }
  if (url.includes('generativelanguage.googleapis.com')) {
    return json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ caption: 'Thank you for taking the time to share your feedback. Team Chetna Hospital' }) }] } }] });
  }
  if (!url.startsWith('http://127.0.0.1')) throw new Error(`Unexpected network call in tests: ${url}`);
  return realFetch(input, init);
}) as typeof fetch;

let server: Server;
let base = '';
let cookie = '';

before(async () => {
  process.env.GEMINI_API_KEY = 'fake';
  process.env.GBP_CLIENT_ID = 'id';
  process.env.GBP_CLIENT_SECRET = 'secret';
  process.env.GBP_REFRESH_TOKEN = 'refresh';
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
  const html = await (await fetch(`${base}/reviews`, { headers: { cookie } })).text();
  const csrf = html.match(/name="_csrf" value="([^"]+)"/)![1];
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base, cookie },
    body: new URLSearchParams({ _csrf: csrf, ...data }),
    redirect: 'manual',
  });
}

const idOf = async (name: string) => (await getReviewByName(name))!.id;

test('reply wording check catches confidentiality problems', () => {
  assert.ok(replyWarnings('We hope your surgery went well.').length > 0);
  assert.ok(replyWarnings('Our records show you were admitted in May.').length > 0);
  assert.ok(replyWarnings('This is a fake review.').length > 0);
  assert.deepEqual(replyWarnings('Thank you for your feedback. We have shared it with the team. Team Chetna Hospital'), []);
});

test('sync picks up only recent, unanswered reviews from every profile and drafts replies', async () => {
  const s = await syncReviews();
  assert.equal(s.profiles, 2);
  assert.equal(s.newReviews, 3); // a, b, e — not the answered one, not the 200-day-old one
  assert.equal(s.drafted, 3);
  assert.deepEqual(s.errors, []);
  const open = await listReviewRows({ status: ['draft'] });
  assert.equal(open[0].reviewer, 'Ravi P', 'lowest rating first');
  assert.ok(open.every((r) => r.reply.includes('Thank you')));
  assert.equal(await getReviewByName('accounts/9/locations/1/reviews/c'), null);
  assert.equal(await getReviewByName('accounts/9/locations/1/reviews/d'), null);
});

test('a second sync does not duplicate anything', async () => {
  const s = await syncReviews();
  assert.equal(s.newReviews, 0);
  assert.equal((await listReviewRows({ status: ['draft'] })).length, 3);
});

test('the reviews page lists them', async () => {
  const html = await (await fetch(`${base}/reviews`, { headers: { cookie } })).text();
  assert.match(html, /Ravi P/);
  assert.match(html, /Waited 3 hours/);
  assert.match(html, /star rating only/);
  assert.match(html, /Post reply on Google/);
});

test('posting a reply sends it to Google, and a failed post can be retried', async () => {
  const id = await idOf('accounts/9/locations/1/reviews/a');
  let r = await form(`/reviews/${id}/save`, { reply: 'Thank you, Asha. We have shared your kind words with the team. Team Chetna Hospital' });
  assert.equal(r.status, 303);

  failNextPut = true;
  r = await form(`/reviews/${id}/post`, {});
  assert.equal(r.status, 303);
  let row = (await getReviewByName('accounts/9/locations/1/reviews/a'))!;
  assert.equal(row.status, 'failed');
  assert.match(row.error, /Temporary Google error/);

  r = await form(`/reviews/${id}/post`, {});
  row = (await getReviewByName('accounts/9/locations/1/reviews/a'))!;
  assert.equal(row.status, 'replied');
  assert.equal(puts.length, 1);
  assert.equal(puts[0].url, 'https://mybusiness.googleapis.com/v4/accounts/9/locations/1/reviews/a/reply');
  assert.match(puts[0].body.comment, /Thank you, Asha/);

  r = await form(`/reviews/${id}/post`, {});
  assert.equal(r.status, 400, 'cannot post twice');
  assert.equal(puts.length, 1);
});

test('a risky reply needs the wording check ticked', async () => {
  const id = await idOf('accounts/9/locations/2/reviews/e');
  await form(`/reviews/${id}/save`, { reply: 'Glad your surgery went well!' });
  const r = await form(`/reviews/${id}/post`, {});
  assert.equal(r.status, 400);
  assert.match(await r.text(), /I have checked the wording/);
  assert.equal(puts.length, 1);
});

test('a review answered in the Google app meanwhile is not answered again', async () => {
  reviews['locations/1'][1].reviewReply = { comment: 'Sorry, we will look into it.' };
  const s = await syncReviews();
  assert.equal(s.repliedElsewhere, 1);
  const row = (await getReviewByName('accounts/9/locations/1/reviews/b'))!;
  assert.equal(row.status, 'replied_elsewhere');
  const r = await form(`/reviews/${row.id}/post`, {});
  assert.equal(r.status, 400);
});

test('if a reviewer edits an answered review, it comes back with a fresh draft', async () => {
  const rv = reviews['locations/1'][0];
  rv.comment = 'Very caring staff, but billing was slow.';
  rv.starRating = 'THREE';
  rv.updateTime = new Date().toISOString();
  rv.reviewReply = { comment: 'Thank you, Asha.' };
  await syncReviews();
  const row = (await getReviewByName('accounts/9/locations/1/reviews/a'))!;
  assert.equal(row.status, 'draft');
  assert.equal(row.rating, 3);
  assert.match(row.error, /changed their review/);
  assert.ok(row.reply.length > 0, 'redrafted in the same sync');
});

test('skip marks a review as not needing a reply', async () => {
  const id = await idOf('accounts/9/locations/2/reviews/e');
  const r = await form(`/reviews/${id}/skip`, {});
  assert.equal(r.status, 303);
  assert.equal((await getReviewByName('accounts/9/locations/2/reviews/e'))!.status, 'skipped');
});

test('review cron endpoint needs the secret', async () => {
  const r = await fetch(`${base}/cron/reviews`, { method: 'POST' });
  assert.equal(r.status, 403);
});
