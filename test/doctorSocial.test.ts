import './setup.ts';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { syncComments, postCommentReply, hideCommentById } from '../src/comments.ts';
import { getCommentByRef, initDb } from '../src/db.ts';
import { socialReport } from '../src/metaInsights.ts';
import { clearDoctorPagesCache } from '../src/publishers/metaPages.ts';

const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString().replace('.000Z', '+0000');
const managed = [
  { id: 'hosp', name: 'Chetna Hospital', access_token: 'tok-hosp', instagram_business_account: { id: 'ig-hosp', username: 'chetnahospital' } },
  { id: 'p-nirmal', name: 'Dr. Nirmal Patil', access_token: 'tok-nirmal', instagram_business_account: { id: 'ig-nirmal', username: 'drnirmalpatil' } },
];
const calls: { method: string; path: string; token: string; params: Record<string, string> }[] = [];

const realFetch = globalThis.fetch;
before(async () => {
  process.env.META_PAGE_ID = 'hosp';
  process.env.META_PAGE_ACCESS_TOKEN = 'tok-hosp';
  process.env.META_IG_USER_ID = 'ig-hosp';
  process.env.META_SYSTEM_USER_TOKEN = 'tok-system';
  process.env.GEMINI_API_KEY = 'fake';
  clearDoctorPagesCache();
  await initDb();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.hostname === 'generativelanguage.googleapis.com') {
      return json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ category: 'question', needs_reply: true, reply: 'Thank you for asking! Please contact us.' }) }] } }] });
    }
    const path = url.pathname.replace(/^\/v[\d.]+\//, '');
    const method = init?.method ?? 'GET';
    const params = Object.fromEntries(method === 'POST' ? new URLSearchParams(String(init!.body)) : url.searchParams);
    const token = params.access_token;
    delete params.access_token;
    calls.push({ method, path, token, params });
    if (method === 'POST') return json({ id: 'new', success: true });

    if (path === 'me/accounts') return json({ data: managed });
    // comments: hospital has none, Dr. Nirmal's Page and Instagram have one each
    if (path === 'hosp/published_posts' && params.fields?.startsWith('id,message')) return json({ data: [] });
    if (path === 'ig-hosp' && params.fields === 'username') return json({ username: 'chetnahospital' });
    if (path === 'ig-hosp/media' && params.fields?.startsWith('id,caption')) return json({ data: [] });
    if (path === 'p-nirmal/published_posts' && params.fields?.startsWith('id,message')) {
      assert.equal(token, 'tok-nirmal', "doctor's Page is read with its own token");
      return json({ data: [{ id: 'np1', message: 'Back pain tips', permalink_url: 'https://fb/np1' }] });
    }
    if (path === 'np1/comments') return json({ data: [{ id: 'nc1', message: 'Do you do endoscopic spine surgery?', created_time: ago(2), from: { id: 'u1', name: 'Sunil' } }] });
    if (path === 'ig-nirmal' && params.fields === 'username') return json({ username: 'drnirmalpatil' });
    if (path === 'ig-nirmal/media' && params.fields?.startsWith('id,caption')) return json({ data: [{ id: 'nm1', caption: 'Posture', permalink: 'https://ig/nm1', timestamp: ago(30) }] });
    if (path === 'nm1/comments') return json({ data: [{ id: 'ic1', text: 'Spam spam', username: 'spammer', timestamp: ago(1) }] });

    // insights
    if (['hosp', 'p-nirmal'].includes(path) && params.fields === 'followers_count,fan_count') return json({ followers_count: path === 'hosp' ? 2500 : 800 });
    if (['ig-hosp', 'ig-nirmal'].includes(path) && params.fields === 'followers_count') return json({ followers_count: path === 'ig-hosp' ? 900 : 300 });
    if (path.endsWith('/insights')) {
      if (path.startsWith('ig-')) return json({ data: [{ total_value: { value: path === 'ig-hosp' ? 5000 : 1200 } }] });
      return json({ data: [{ values: [] }] });
    }
    if (path.endsWith('/published_posts') || path.endsWith('/media')) return json({ data: [] });
    throw new Error(`Unexpected call ${method} ${url}`);
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

test("comments on doctors' own Pages and Instagram are picked up and labelled", async () => {
  const s = await syncComments();
  assert.deepEqual(s.errors, []);
  assert.deepEqual(s.checked, ['Facebook', 'Instagram', 'Facebook (Dr. Nirmal Patil)', 'Instagram (Dr. Nirmal Patil)']);
  assert.equal(s.newComments, 2);
  const fb = await getCommentByRef('facebook', 'nc1');
  assert.equal(fb?.account, 'p-nirmal');
  assert.equal(fb?.accountLabel, 'Dr. Nirmal Patil');
  const ig = await getCommentByRef('instagram', 'ic1');
  assert.equal(ig?.account, 'ig-nirmal');
});

test("replies and hides on a doctor's account use that Page's token", async () => {
  const fb = (await getCommentByRef('facebook', 'nc1'))!;
  calls.length = 0;
  const after = await postCommentReply(fb.id);
  assert.equal(after.status, 'replied');
  assert.deepEqual(
    calls.filter((c) => c.method === 'POST').map((c) => `${c.path}|${c.token}`),
    ['nc1/comments|tok-nirmal'],
  );

  const ig = (await getCommentByRef('instagram', 'ic1'))!;
  calls.length = 0;
  await hideCommentById(ig.id);
  assert.deepEqual(
    calls.filter((c) => c.method === 'POST').map((c) => `${c.path}|${c.token}|${JSON.stringify(c.params)}`),
    ['ic1|tok-nirmal|{"hide":"true"}'],
  );
});

test("the weekly report has a section for each doctor's Page and Instagram", async () => {
  const channels = await socialReport({ weekStart: '2026-09-21', weekEnd: '2026-09-27', prevStart: '2026-09-14', prevEnd: '2026-09-20' });
  assert.deepEqual(
    channels.map((c) => `${c.label}|${c.followers}`),
    ['Facebook|2500', 'Instagram|900', 'Facebook — Dr. Nirmal Patil|800', 'Instagram — Dr. Nirmal Patil|300'],
  );
  assert.equal(channels[2].doctor, 'Dr. Nirmal Patil');
  assert.equal(channels[0].doctor, undefined);
  const igDoc = channels[3].metrics.find((m) => m.key === 'views');
  assert.deepEqual(igDoc?.value, { cur: 1200, prev: 1200 });
  const docCalls = calls.filter((c) => c.path.startsWith('p-nirmal') || c.path.startsWith('ig-nirmal'));
  assert.ok(docCalls.length > 0 && docCalls.every((c) => c.token === 'tok-nirmal'), "doctor's numbers are read with the doctor's token");
});
