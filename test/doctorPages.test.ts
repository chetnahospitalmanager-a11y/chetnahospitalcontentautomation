import './setup.ts';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { clearDoctorPagesCache, getDoctorPages } from '../src/publishers/metaPages.ts';
import { insertPost } from '../src/db.ts';
import { approveAndPublish, planTargets } from '../src/workflow.ts';
import { createApp } from '../src/web/app.ts';

// ---- fake Graph API: the system user manages the hospital Page + 3 doctors' Pages + one unrelated Page ----
const managed = [
  { id: 'hosp', name: 'Chetna Hospital-Best Multispeciality Hospital in PCMC,Pune', access_token: 'tok-hosp', instagram_business_account: { id: 'ig-hosp', username: 'chetnahospital' } },
  { id: 'p-nirmal', name: 'Dr. Nirmal Patil - Spine Surgeon', access_token: 'tok-nirmal', instagram_business_account: { id: 'ig-nirmal', username: 'drnirmalpatil' } },
  { id: 'p-rachana', name: 'Dr. Rachana Tiwari', access_token: 'tok-rachana', instagram_business_account: { id: 'ig-rachana', username: 'dr.rachanatiwari' } },
  { id: 'p-aishwarya', name: 'Dr Aishwarya Patil - Skin & Hair', access_token: 'tok-aishwarya' },
  { id: 'p-other', name: 'Some Other Business', access_token: 'tok-other' },
];
const calls: { path: string; token: string; method: string }[] = [];
let failSystemToken = false;

const realFetch = globalThis.fetch;
before(() => {
  process.env.META_PAGE_ID = 'hosp';
  process.env.META_PAGE_ACCESS_TOKEN = 'tok-hosp';
  process.env.META_IG_USER_ID = 'ig-hosp';
  process.env.META_SYSTEM_USER_TOKEN = 'tok-system';
  process.env.PUBLIC_BASE_URL = 'https://social.example.com';
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.hostname === 'graph.facebook.com') {
      const path = url.pathname.replace(/^\/v[\d.]+\//, '');
      const method = init?.method ?? 'GET';
      const token = method === 'POST' ? new URLSearchParams(String(init!.body)).get('access_token')! : url.searchParams.get('access_token')!;
      calls.push({ path, token, method });
      if (path === 'me/accounts') {
        if (failSystemToken) return json({ error: { message: 'Error validating access token' } }, 400);
        assert.equal(token, 'tok-system');
        return json({ data: managed });
      }
      if (path === 'hosp') return json({ name: managed[0].name, instagram_business_account: managed[0].instagram_business_account });
      if (path.endsWith('/photos')) return json({ id: 'ph', post_id: `${path.split('/')[0]}_post` });
      if (path.endsWith('/media')) return json({ id: `c-${path.split('/')[0]}` });
      if (path.startsWith('c-')) return json({ status_code: 'FINISHED' });
      if (path.endsWith('/media_publish')) return json({ id: 'm' });
    }
    if (!url.href.startsWith('http://127.0.0.1')) throw new Error(`Unexpected network call in tests: ${url}`);
    return realFetch(input, init);
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

test("doctors' Pages are matched by name, using aliases, and unrelated Pages are ignored", async () => {
  const pages = await getDoctorPages(true);
  assert.equal(pages.byDoctor.get('nirmal-patil')?.pageId, 'p-nirmal');
  assert.equal(pages.byDoctor.get('rachana-tiwari-patil')?.pageId, 'p-rachana', 'matched through the "Dr. Rachana Tiwari" alias');
  assert.equal(pages.byDoctor.get('aishwarya-patil-pethe')?.pageId, 'p-aishwarya', 'matched through the "Dr. Aishwarya Patil" alias');
  assert.equal(pages.byDoctor.size, 3, 'the hospital Page and the unrelated Page are not doctors');
  assert.ok(pages.problems.some((p) => p.includes('Some Other Business')));
  assert.ok(pages.problems.some((p) => p.includes('no Instagram account linked') && p.includes('Aishwarya')));
});

test('a doctor spotlight goes to the hospital and that doctor’s Page + Instagram only', async () => {
  const post = await insertPost({ kind: 'doctor', subject: 'nirmal-patil', title: 'Doctor spotlight', caption: 'Meet our spine surgeon.', imageKey: 'doctor-nirmal-patil', warnings: [] });
  const channels = (await planTargets(post)).map((t) => t.channel);
  assert.deepEqual(channels, ['facebook', 'instagram', 'facebook:Dr. Nirmal Patil - Spine Surgeon', 'instagram:@drnirmalpatil']);
});

test('a hospital-wide post goes to the hospital only', async () => {
  const post = await insertPost({ kind: 'hospital', subject: 'emergency', title: '24x7', caption: 'We are open 24x7.', imageKey: 'hospital-emergency', warnings: [] });
  assert.deepEqual((await planTargets(post)).map((t) => t.channel), ['facebook', 'instagram']);
});

test('publishing uses each Page’s own token', async () => {
  const post = await insertPost({ kind: 'doctor', subject: 'rachana-tiwari-patil', title: 'Eye care', caption: 'Eye check-ups.', imageKey: 'doctor-rachana-tiwari-patil', warnings: [] });
  calls.length = 0;
  const done = await approveAndPublish(post.id);
  assert.equal(done.status, 'published');
  const posts = calls.filter((c) => c.method === 'POST');
  assert.deepEqual(
    posts.map((c) => `${c.path}|${c.token}`),
    [
      'hosp/photos|tok-hosp',
      'ig-hosp/media|tok-hosp',
      'ig-hosp/media_publish|tok-hosp',
      'p-rachana/photos|tok-rachana',
      'ig-rachana/media|tok-rachana',
      'ig-rachana/media_publish|tok-rachana',
    ],
  );
});

test("if the doctors' Pages can't be loaded, the hospital still posts and the problem shows as a retryable failure", async () => {
  clearDoctorPagesCache();
  failSystemToken = true;
  try {
    const post = await insertPost({ kind: 'doctor', subject: 'nirmal-patil', title: 'Spine', caption: 'Back pain?', imageKey: 'doctor-nirmal-patil', warnings: [] });
    const done = await approveAndPublish(post.id);
    assert.equal(done.status, 'partial');
    assert.deepEqual(done.results.filter((r) => r.ok).map((r) => r.channel), ['facebook', 'instagram']);
    assert.match(done.results.find((r) => !r.ok)!.error!, /Could not load doctors' Pages: .*validating access token/);
  } finally {
    failSystemToken = false;
    clearDoctorPagesCache();
  }
});

test('the Connections page shows the hospital and doctor accounts', async () => {
  process.env.GEMINI_API_KEY = '';
  const server: Server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const login = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
      body: new URLSearchParams({ password: 'test-password' }),
      redirect: 'manual',
    });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    const html = await (await fetch(`${base}/connections`, { headers: { cookie } })).text();
    assert.match(html, /Chetna Hospital-Best Multispeciality Hospital in PCMC,Pune \(hosp\)/);
    assert.match(html, /@chetnahospital/);
    assert.match(html, /Dr\. Nirmal Patil - Spine Surgeon/);
    assert.match(html, /@dr\.rachanatiwari/);
    assert.match(html, /Needs attention/);
  } finally {
    server.close();
  }
});
