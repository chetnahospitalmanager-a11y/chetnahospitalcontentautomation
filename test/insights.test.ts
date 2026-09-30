import './setup.ts';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { addDays, change, generateWeeklyReport, highlights, reportCsv, reportWeek, todayIn, type WeeklyReport } from '../src/insights.ts';
import { createApp } from '../src/web/app.ts';

// ---- fake Google APIs ----
const civil = (iso: string) => {
  const [year, month, day] = iso.split('-').map(Number);
  return { year, month, day };
};
const perf: Record<string, (date: string) => Record<string, number>> = {
  // hospital: 10 calls/day this week (Sep 14-20), 5/day the week before; 100 map views/day, except one day Google leaves out
  'locations/1': (d) => ({ CALL_CLICKS: d >= '2026-09-14' ? 10 : 5, BUSINESS_IMPRESSIONS_MOBILE_MAPS: d === '2026-09-16' ? -1 : 100, WEBSITE_CLICKS: 2 }),
  // doctor: views collapsed from 50/day to 10/day
  'locations/2': (d) => ({ CALL_CLICKS: 3, BUSINESS_IMPRESSIONS_MOBILE_SEARCH: d >= '2026-09-14' ? 10 : 50, BUSINESS_DIRECTION_REQUESTS: 1 }),
};
const perfUrls: string[] = [];

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (url.startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 'at', expires_in: 3600 });
  if (url.startsWith('https://mybusinessaccountmanagement.googleapis.com/v1/accounts')) return json({ accounts: [{ name: 'accounts/9' }] });
  if (url.includes('mybusinessbusinessinformation.googleapis.com/v1/accounts/9/locations'))
    return json({
      locations: [
        { name: 'locations/1', title: 'Chetna Hospital' },
        { name: 'locations/2', title: 'Dr. Nirmal Patil' },
        { name: 'locations/3', title: 'Dr. Hemant Patil' },
      ],
    });
  const pm = url.match(/businessprofileperformance\.googleapis\.com\/v1\/(locations\/\d+):fetchMultiDailyMetricsTimeSeries\?(.*)$/);
  if (pm) {
    perfUrls.push(url);
    const gen = perf[pm[1]];
    if (!gen) return json({ error: { message: 'Performance data unavailable' } }, 500);
    const q = new URLSearchParams(pm[2]);
    const start = `${q.get('dailyRange.startDate.year')}-${q.get('dailyRange.startDate.month')!.padStart(2, '0')}-${q.get('dailyRange.startDate.day')!.padStart(2, '0')}`;
    const end = `${q.get('dailyRange.endDate.year')}-${q.get('dailyRange.endDate.month')!.padStart(2, '0')}-${q.get('dailyRange.endDate.day')!.padStart(2, '0')}`;
    const series = q.getAll('dailyMetrics').map((metric) => {
      const datedValues = [];
      for (let d = start; d <= end; d = addDays(d, 1)) {
        const v = gen(d)[metric];
        if (v === undefined || v < 0) datedValues.push({ date: civil(d) }); // Google omits value for zero/missing
        else datedValues.push({ date: civil(d), value: String(v) });
      }
      return { dailyMetric: metric, timeSeries: { datedValues } };
    });
    return json({ multiDailyMetricTimeSeries: [{ dailyMetricTimeSeries: series }] });
  }
  const rm = url.match(/mybusiness\.googleapis\.com\/v4\/accounts\/9\/(locations\/\d+)\/reviews\?/);
  if (rm) {
    if (url.includes('pageSize=1')) return json({ averageRating: rm[1] === 'locations/2' ? 3.6 : 4.5, totalReviewCount: 40 });
    return json({
      reviews:
        rm[1] === 'locations/1'
          ? [
              { name: 'r1', reviewer: { displayName: 'A' }, starRating: 'FIVE', createTime: '2026-09-15T10:00:00Z', updateTime: '2026-09-15T10:00:00Z' },
              { name: 'r2', reviewer: { displayName: 'B' }, starRating: 'FOUR', createTime: '2026-09-19T10:00:00Z', updateTime: '2026-09-19T10:00:00Z' },
            ]
          : [],
    });
  }
  if (!url.startsWith('http://127.0.0.1')) throw new Error(`Unexpected network call in tests: ${url}`);
  return realFetch(input, init);
}) as typeof fetch;

let server: Server;
let base = '';
let cookie = '';
before(async () => {
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

test('report week is the last full Monday–Sunday week that ended at least 3 days ago', () => {
  assert.deepEqual(reportWeek('2026-10-01', 3), { weekStart: '2026-09-21', weekEnd: '2026-09-27', prevStart: '2026-09-14', prevEnd: '2026-09-20' });
  assert.equal(reportWeek('2026-09-28', 3).weekEnd, '2026-09-20'); // Monday: last week isn't complete in Google yet
  assert.equal(reportWeek('2026-09-30', 3).weekEnd, '2026-09-27'); // Wednesday
});

test('today is taken in India time, not UTC', () => {
  assert.equal(todayIn('Asia/Kolkata', new Date('2026-09-30T20:00:00Z')), '2026-10-01');
});

test('percentage change handles zero weeks', () => {
  assert.equal(change({ cur: 15, prev: 10 }), '+50%');
  assert.equal(change({ cur: 5, prev: 10 }), '-50%');
  assert.equal(change({ cur: 3, prev: 0 }), 'new');
  assert.equal(change({ cur: 0, prev: 0 }), '–');
});

let report: WeeklyReport;

test('builds a report from Google Performance data for every profile', async () => {
  const saved = await generateWeeklyReport({ weekStart: '2026-09-14' });
  report = saved.data;
  assert.equal(report.weekEnd, '2026-09-20');
  assert.match(perfUrls[0], /dailyRange\.startDate\.day=7/);
  assert.match(perfUrls[0], /dailyMetrics=CALL_CLICKS/);

  const hosp = report.profiles[0];
  assert.equal(hosp.title, 'Chetna Hospital');
  assert.equal(hosp.kind, 'hospital');
  assert.deepEqual(hosp.metrics.calls, { cur: 70, prev: 35 });
  assert.deepEqual(hosp.metrics.views, { cur: 600, prev: 700 }, 'missing day counts as zero');
  assert.deepEqual(hosp.metrics.website, { cur: 14, prev: 14 });
  assert.equal(hosp.rating, 4.5);
  assert.equal(hosp.newReviews, 2);
  assert.equal(hosp.newReviewsAvg, 4.5);

  const doc = report.profiles.find((p) => p.title === 'Dr. Nirmal Patil')!;
  assert.equal(doc.kind, 'doctor');
  assert.equal(doc.doctor, 'Dr. Nirmal Patil');
  assert.deepEqual(doc.metrics.views, { cur: 70, prev: 350 });

  const broken = report.profiles.find((p) => p.title === 'Dr. Hemant Patil')!;
  assert.match(broken.error!, /Performance data unavailable/, 'one broken profile does not stop the report');

  assert.deepEqual(report.totals.calls, { cur: 91, prev: 56 });
});

test('highlights call out the drop, the low rating and the failed profile', () => {
  const text = report.highlights.join('\n');
  assert.match(text, /91 calls \(\+63%\)/);
  assert.match(text, /Most calls among doctors: Dr\. Nirmal Patil/);
  assert.match(text, /Views fell on Dr\. Nirmal Patil: 350 → 70/);
  assert.match(text, /Rating below 4\.0: Dr\. Nirmal Patil \(3\.6\)/);
  assert.match(text, /2 new Google reviews/);
  assert.match(text, /Could not read 1 profile: Dr\. Hemant Patil/);
});

test('highlights stay quiet when nothing notable happened', () => {
  const flat = { cur: 10, prev: 10 };
  const h = highlights({
    profiles: [],
    totals: { views: flat, calls: flat, directions: flat, website: flat },
    activity: { postsPublished: 1, repliesPosted: 0, reviewsWaiting: 0 },
  });
  assert.equal(h.length, 3);
});

test('rebuilding the same week replaces it instead of adding a duplicate', async () => {
  const a = await generateWeeklyReport({ weekStart: '2026-09-14' });
  const html = await (await fetch(`${base}/insights`, { headers: { cookie } })).text();
  assert.equal((html.match(/14 Sept? – 20 Sept? 2026/g) ?? []).length >= 1, true);
  assert.equal((html.match(/href="\/insights\/\d+">/g) ?? []).length, 1, 'one entry in past weeks');
  assert.ok(a.id > 0);
});

test('insights page shows totals, per-profile numbers and highlights', async () => {
  const html = await (await fetch(`${base}/insights`, { headers: { cookie } })).text();
  assert.match(html, /Week of/);
  assert.match(html, /What stands out/);
  assert.match(html, /Dr\. Nirmal Patil/);
  assert.match(html, /\+100%/); // hospital calls 35 → 70
  assert.match(html, /Download CSV/);
});

test('CSV export has one row per profile and neutralises formulas', async () => {
  const id = (await (await fetch(`${base}/insights`, { headers: { cookie } })).text()).match(/\/insights\/(\d+)\.csv/)![1];
  const r = await fetch(`${base}/insights/${id}.csv`, { headers: { cookie } });
  assert.match(r.headers.get('content-type')!, /text\/csv/);
  const lines = (await r.text()).trim().split('\r\n');
  assert.equal(lines.length, 4);
  assert.match(lines[1], /^﻿?"Chetna Hospital","hospital","","600","700","70","35"/);
  const evil = reportCsv({ ...report, profiles: [{ ...report.profiles[0], title: '=HYPERLINK("x")' }] });
  assert.match(evil, /"'=HYPERLINK\(""x""\)"/);
});

test('insights pages need a login, and the cron endpoint needs the secret', async () => {
  const r = await fetch(`${base}/insights`, { redirect: 'manual' });
  assert.equal(r.status, 303);
  const c = await fetch(`${base}/insights/1.csv`, { redirect: 'manual' });
  assert.equal(c.status, 303);
  const cron = await fetch(`${base}/cron/insights`, { method: 'POST' });
  assert.equal(cron.status, 403);
});
