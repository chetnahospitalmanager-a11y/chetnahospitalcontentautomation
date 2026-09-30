import './setup.ts';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIgTotal, parsePageDaily, socialReport, zonedMidnight } from '../src/metaInsights.ts';
import { generateWeeklyReport, reportCsv } from '../src/insights.ts';

test('00:00 in India is 18:30 UTC the day before', () => {
  assert.equal(zonedMidnight('2026-09-21', 'Asia/Kolkata').toISOString(), '2026-09-20T18:30:00.000Z');
  assert.equal(zonedMidnight('2026-09-21', 'UTC').toISOString(), '2026-09-21T00:00:00.000Z');
});

test('Facebook daily values are dated by the day they cover, not their Pacific end_time', () => {
  const daily = parsePageDaily({
    data: [{ values: [{ value: 5, end_time: '2026-09-15T07:00:00+0000' }, { value: 7, end_time: '2026-11-03T08:00:00+0000' }] }],
  });
  assert.deepEqual(daily, { '2026-09-14': 5, '2026-11-02': 7 });
});

test('Instagram total_value and breakdown parsing', () => {
  assert.equal(parseIgTotal({ data: [{ total_value: { value: 1234 } }] }), 1234);
  const fu = { data: [{ total_value: { breakdowns: [{ results: [{ dimension_values: ['FOLLOWER'], value: 12 }, { dimension_values: ['NON_FOLLOWER'], value: 3 }] }] } }] };
  assert.equal(parseIgTotal(fu, 'FOLLOWER'), 12);
  assert.throws(() => parseIgTotal({ data: [] }));
});

// ---- fake Graph API ----
const week = { weekStart: '2026-09-14', weekEnd: '2026-09-20', prevStart: '2026-09-07', prevEnd: '2026-09-13' };
const unix = (s: string) => String(Date.parse(s) / 1000);
const calls: string[] = [];
const realFetch = globalThis.fetch;

before(() => {
  process.env.META_PAGE_ID = 'page1';
  process.env.META_PAGE_ACCESS_TOKEN = 'tok';
  process.env.META_IG_USER_ID = 'ig1';
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const q = url.searchParams;
    const path = url.pathname.replace(/^\/v[\d.]+\//, '');
    calls.push(`${path}?${q.get('metric') ?? q.get('fields') ?? ''}`);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    assert.equal(q.get('access_token'), 'tok');
    if (path === 'page1') return json({ followers_count: 2500, fan_count: 2400 });
    if (path === 'page1/insights') {
      assert.equal(q.get('since'), '2026-09-07');
      const values = [];
      for (let d = 7; d <= 21; d++) values.push({ value: d >= 14 ? 300 : 200, end_time: `2026-09-${String(d + 1).padStart(2, '0')}T07:00:00+0000` });
      return json({ data: [{ name: 'page_media_view', values }] });
    }
    if (path === 'page1/published_posts')
      return json({
        data: [
          { created_time: '2026-09-15T05:00:00+0000', message: 'Heart care week\nmore', permalink_url: 'https://fb/1', reactions: { summary: { total_count: 40 } }, comments: { summary: { total_count: 5 } }, shares: { count: 3 } },
          { created_time: '2026-09-17T05:00:00+0000', message: 'Knee pain', permalink_url: 'https://fb/2', reactions: { summary: { total_count: 10 } }, comments: { summary: { total_count: 0 } } },
          { created_time: '2026-09-09T05:00:00+0000', message: 'Old', reactions: { summary: { total_count: 20 } }, comments: { summary: { total_count: 0 } } },
        ],
      });
    if (path === 'ig1') return json({ followers_count: 900 });
    if (path === 'ig1/insights') {
      const cur = q.get('since') === unix('2026-09-13T18:30:00Z');
      const prev = q.get('since') === unix('2026-09-06T18:30:00Z');
      assert.ok(cur || prev, `unexpected since ${q.get('since')}`);
      const metric = q.get('metric');
      if (metric === 'profile_links_taps') return json({ error: { message: '(#100) The value must be a valid insights metric' } }, 400);
      if (metric === 'follows_and_unfollows') {
        assert.equal(q.get('breakdown'), 'follow_type');
        return json({ data: [{ total_value: { breakdowns: [{ results: [{ dimension_values: ['FOLLOWER'], value: cur ? 30 : 20 }] }] } }] });
      }
      const v = { views: [5000, 4000], reach: [1800, 1500], total_interactions: [240, 300] }[metric!]!;
      return json({ data: [{ name: metric, total_value: { value: cur ? v[0] : v[1] } }] });
    }
    if (path === 'ig1/media')
      return json({ data: [{ timestamp: '2026-09-16T06:00:00+0000', caption: 'World Heart Day', permalink: 'https://ig/1', like_count: 120, comments_count: 8 }] });
    throw new Error(`Unexpected call ${url}`);
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

test('Facebook: followers, media views by week, post engagement and best post', async () => {
  const [fb] = await socialReport(week);
  assert.equal(fb.channel, 'facebook');
  assert.equal(fb.followers, 2500);
  assert.deepEqual(fb.metrics[0], { key: 'views', label: 'Media views', value: { cur: 2100, prev: 1400 } });
  assert.deepEqual(fb.posts, { cur: 2, prev: 1 });
  assert.deepEqual(fb.engagement, { cur: 58, prev: 20 });
  assert.equal(fb.topPost?.text, 'Heart care week');
  assert.equal(fb.topPost?.url, 'https://fb/1');
});

test('Instagram: a retired metric shows as unavailable instead of breaking the report', async () => {
  const [, ig] = await socialReport(week);
  const get = (k: string) => ig.metrics.find((m) => m.key === k)!;
  assert.equal(ig.followers, 900);
  assert.deepEqual(get('views').value, { cur: 5000, prev: 4000 });
  assert.deepEqual(get('reach').value, { cur: 1800, prev: 1500 });
  assert.deepEqual(get('interactions').value, { cur: 240, prev: 300 });
  assert.deepEqual(get('follows').value, { cur: 30, prev: 20 });
  assert.equal(get('link_taps').value, null);
  assert.match(get('link_taps').note!, /valid insights metric/);
  assert.deepEqual(ig.engagement, { cur: 128, prev: 0 });
});

test('the weekly report works with only Facebook/Instagram connected and includes them in highlights and CSV', async () => {
  const saved = await generateWeeklyReport({ weekStart: '2026-09-14' });
  const r = saved.data;
  assert.equal(r.profiles.length, 0);
  assert.equal(r.social?.length, 2);
  const text = r.highlights.join('\n');
  assert.match(text, /Facebook: 2,100 media views \(\+50%\), 2 posts with 58 reactions, comments and shares \(\+190%\)/);
  assert.match(text, /Best Facebook post this week: "Heart care week"/);
  assert.match(text, /Instagram: 5,000 views \(\+25%\), 1,800 accounts reached \(\+20%\), 240 interactions \(-20%\), 30 new followers \(\+50%\)/);
  assert.doesNotMatch(text, /Google/);
  const csv = reportCsv(r);
  assert.match(csv, /"Instagram","Profile button taps","","","\(#100\)/);
  assert.match(csv, /"Facebook","Media views","2100","1400"/);
});
