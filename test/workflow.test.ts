import './setup.ts';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import sharp from 'sharp';
import { setHospitalData, loadHospital, type HospitalData } from '../src/hospital.ts';
import { nextTopic } from '../src/topics.ts';
import { createApp } from '../src/web/app.ts';
import { getPost } from '../src/db.ts';

// ---- fake Gemini + Meta; anything else (the local test server) goes to the real fetch ----
const realFetch = globalThis.fetch;
const calls: string[] = [];
let failInstagramOnce = false;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (url.includes('generativelanguage.googleapis.com')) {
    calls.push('gemini');
    return json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ caption: 'Your heart matters. Consult our cardiology team for a check-up.' }) }] } }] });
  }
  if (url.includes('graph.facebook.com')) {
    const path = new URL(url).pathname;
    if (path.endsWith('/photos')) {
      calls.push('facebook');
      return json({ id: 'photo1', post_id: 'page_post1' });
    }
    if (path.endsWith('/media')) {
      calls.push('instagram');
      if (failInstagramOnce) {
        failInstagramOnce = false;
        return json({ error: { message: 'Image could not be fetched' } }, 400);
      }
      return json({ id: 'container1' });
    }
    if (path.endsWith('/container1')) return json({ status_code: 'FINISHED' });
    if (path.endsWith('/media_publish')) return json({ id: 'igmedia1' });
  }
  if (!url.startsWith('http://127.0.0.1')) throw new Error(`Unexpected network call in tests: ${url}`);
  return realFetch(input, init);
}) as typeof fetch;

const data: HospitalData = structuredClone(loadHospital());
data.doctors = [
  { slug: 'a', name: 'Dr. A One', qualification: 'MBBS', speciality: 'Cardiology', department: 'cardiology', bio: '' },
  { slug: 'b', name: 'Dr. B Two', qualification: 'MS', speciality: 'Orthopaedics', department: 'joint-replacement', bio: '' },
  { slug: 'c', name: 'Dr. C Three', qualification: '', speciality: '', department: '', bio: '' },
  { slug: 'd', name: 'Dr. D Four', qualification: 'BPT', speciality: 'Physiotherapist', department: '', bio: '', spotlight: false },
];
setHospitalData(data);

let server: Server;
let base = '';
let cookie = '';

before(async () => {
  process.env.GEMINI_API_KEY = 'fake';
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  globalThis.fetch = realFetch;
});

function post(path: string, form: Record<string, string>, opts: { origin?: string | null } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (opts.origin !== null) headers.origin = opts.origin ?? base;
  if (cookie) headers.cookie = cookie;
  return fetch(`${base}${path}`, { method: 'POST', headers, body: new URLSearchParams(form), redirect: 'manual' });
}

async function csrf(path = '/'): Promise<string> {
  const html = await (await fetch(`${base}${path}`, { headers: { cookie } })).text();
  const m = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(m, 'page has a CSRF token');
  return m[1];
}

test('rotation goes doctor → department → doctor → department → hospital, skipping doctors without a speciality or with spotlight: false', async () => {
  const kinds = [];
  const subjects = [];
  for (let i = 0; i < 6; i++) {
    const t = await nextTopic();
    kinds.push(t.kind);
    subjects.push(t.subject);
  }
  assert.deepEqual(kinds, ['doctor', 'department', 'doctor', 'department', 'hospital', 'doctor']);
  assert.deepEqual([subjects[0], subjects[2], subjects[5]], ['a', 'b', 'a']);
});

test('pages need a login', async () => {
  const r = await fetch(`${base}/`, { redirect: 'manual' });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/login');
});

test('wrong password is refused', async () => {
  const r = await post('/login', { password: 'nope' });
  assert.equal(r.status, 401);
});

test('cross-site login post is blocked', async () => {
  const r = await post('/login', { password: 'test-password' }, { origin: 'https://evil.example' });
  assert.equal(r.status, 403);
  const r2 = await post('/login', { password: 'test-password' }, { origin: null });
  assert.equal(r2.status, 403);
});

test('correct password logs in', async () => {
  const r = await post('/login', { password: 'test-password' });
  assert.equal(r.status, 303);
  cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
  assert.match(cookie, /^chetna_social=/);
  const page = await fetch(`${base}/`, { headers: { cookie } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Waiting for approval/);
});

test('form posts without the CSRF token are blocked', async () => {
  const r = await post('/posts', { topic: 'next' });
  assert.equal(r.status, 403);
});

let draftId = 0;

test('creating a draft writes a caption and serves a 1080x1350 JPEG', async () => {
  const r = await post('/posts', { _csrf: await csrf(), topic: 'doctor:a' });
  assert.equal(r.status, 303);
  draftId = Number(r.headers.get('location')!.match(/\/posts\/(\d+)/)![1]);
  const p = await getPost(draftId);
  assert.equal(p?.status, 'draft');
  assert.match(p!.caption, /heart/);

  const img = await fetch(`${base}/image/${draftId}.jpg`);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  const meta = await sharp(Buffer.from(await img.arrayBuffer())).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.width, 1080);
  assert.equal(meta.height, 1350);
});

test('publishing refuses when no public URL / channels are configured', async () => {
  const r = await post(`/posts/${draftId}/publish`, { _csrf: await csrf(`/posts/${draftId}`) });
  assert.equal(r.status, 400);
  assert.equal((await getPost(draftId))?.status, 'draft');
});

test('approve posts to Facebook + Instagram, retry only resends what failed, and a second approve does nothing', async () => {
  process.env.PUBLIC_BASE_URL = 'https://social.example.com';
  process.env.META_PAGE_ID = 'page';
  process.env.META_PAGE_ACCESS_TOKEN = 'token';
  process.env.META_IG_USER_ID = 'ig';
  try {
    failInstagramOnce = true;
    calls.length = 0;
    let r = await post(`/posts/${draftId}/publish`, { _csrf: await csrf(`/posts/${draftId}`) });
    assert.equal(r.status, 303);
    let p = await getPost(draftId);
    assert.equal(p?.status, 'partial');
    assert.deepEqual(calls, ['facebook', 'instagram']);

    calls.length = 0;
    r = await post(`/posts/${draftId}/publish`, { _csrf: await csrf(`/posts/${draftId}`) });
    p = await getPost(draftId);
    assert.equal(p?.status, 'published');
    assert.deepEqual(calls, ['instagram'], 'Facebook is not posted twice');

    calls.length = 0;
    r = await post(`/posts/${draftId}/publish`, { _csrf: await csrf() });
    assert.equal(r.status, 400);
    assert.deepEqual(calls, []);
  } finally {
    for (const k of ['PUBLIC_BASE_URL', 'META_PAGE_ID', 'META_PAGE_ACCESS_TOKEN', 'META_IG_USER_ID']) process.env[k] = '';
  }
});

test('a caption with unsafe wording needs an explicit wording check before approval', async () => {
  let r = await post('/posts', { _csrf: await csrf(), topic: 'custom', custom: 'World Heart Day' });
  const id = Number(r.headers.get('location')!.match(/\/posts\/(\d+)/)![1]);
  r = await post(`/posts/${id}/caption`, { _csrf: await csrf(`/posts/${id}`), caption: 'The best heart care, guaranteed.' });
  assert.equal(r.status, 303);
  assert.ok((await getPost(id))!.warnings.length >= 2);
  r = await post(`/posts/${id}/publish`, { _csrf: await csrf(`/posts/${id}`) });
  assert.equal(r.status, 400);
  assert.match(await r.text(), /I have checked the wording/);
});

test('skip removes a draft from the queue', async () => {
  let r = await post('/posts', { _csrf: await csrf(), topic: 'hospital:emergency' });
  const id = Number(r.headers.get('location')!.match(/\/posts\/(\d+)/)![1]);
  r = await post(`/posts/${id}/skip`, { _csrf: await csrf(`/posts/${id}`) });
  assert.equal(r.status, 303);
  assert.equal((await getPost(id))?.status, 'skipped');
});

test('cron endpoint needs the secret', async () => {
  const r = await fetch(`${base}/cron/draft`, { method: 'POST' });
  assert.equal(r.status, 403);
});
