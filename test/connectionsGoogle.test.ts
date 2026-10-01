import './setup.ts';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/web/app.ts';

const realFetch = globalThis.fetch;
let server: Server;
let base = '';
let cookie = '';

before(async () => {
  process.env.GBP_CLIENT_ID = 'id';
  process.env.GBP_CLIENT_SECRET = 'secret';
  process.env.GBP_REFRESH_TOKEN = 'refresh';
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    if (url.startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 'at', expires_in: 3600 });
    if (url.startsWith('https://mybusinessaccountmanagement.googleapis.com/v1/accounts')) return json({ accounts: [{ name: 'accounts/1' }] });
    if (url.includes('/v1/accounts/1/locations'))
      return json({
        locations: [
          { name: 'locations/1', title: 'Chetna Hospital-Best Multispeciality Hospital in PCMC' },
          { name: 'locations/2', title: 'Dr. Nirmal Patil - Spine Surgeon' },
          { name: 'locations/3', title: 'Dr. Rachana Tiwari' },
          { name: 'locations/4', title: 'Unknown Clinic' },
        ],
      });
    if (!url.startsWith('http://127.0.0.1')) throw new Error(`Unexpected network call in tests: ${url}`);
    return realFetch(input, init);
  }) as typeof fetch;
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

test('the Connections page shows which Google profile matched which doctor', async () => {
  const html = await (await fetch(`${base}/connections`, { headers: { cookie } })).text();
  assert.match(html, /Google Business Profiles/);
  assert.match(html, /4 profiles found/);
  assert.match(html, /✅ Chetna Hospital-Best Multispeciality Hospital in PCMC/);
  assert.match(html, /Dr\. Nirmal Patil<\/td><td>✅ Dr\. Nirmal Patil - Spine Surgeon/);
  assert.match(html, /Dr\. Rachana Tiwari-Patil<\/td><td>✅ Dr\. Rachana Tiwari/, 'matched through the alias');
  assert.match(html, /Unknown Clinic.*did not match any doctor/s);
});
