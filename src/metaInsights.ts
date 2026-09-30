import { config, instagramEnabled, metaEnabled } from './config.ts';
import { graph } from './publishers/meta.ts';

// Meta retires insights metrics often (Page "impressions" went in Nov 2025, engagement/follows in June
// 2026). Every metric is fetched on its own, so a retired one shows as "not available" instead of
// breaking the report. Metric names can be overridden with env vars if Meta renames them again.

export interface Pair {
  cur: number;
  prev: number;
}

export interface ChannelMetric {
  key: string;
  label: string;
  /** null when Meta did not return it (retired metric, missing permission, too few followers…) */
  value: Pair | null;
  note?: string;
}

export interface TopPost {
  text: string;
  url: string;
  engagement: number;
  when: string;
}

export interface ChannelReport {
  channel: 'facebook' | 'instagram';
  label: string;
  followers: number | null;
  metrics: ChannelMetric[];
  posts: Pair;
  engagement: Pair;
  topPost: TopPost | null;
  error?: string;
}

export interface Week {
  weekStart: string;
  weekEnd: string;
  prevStart: string;
  prevEnd: string;
}

// ---------------------------------------------------------------- time

function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** The instant a calendar day starts in a time zone (e.g. 00:00 IST = 18:30 UTC the day before). */
export function zonedMidnight(iso: string, timeZone: string): Date {
  const guess = Date.parse(`${iso}T00:00:00Z`);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(guess))
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return new Date(guess - (asUtc - guess));
}

const unix = (d: Date) => String(Math.floor(d.getTime() / 1000));

/** Start and end (exclusive) instants of a Mon–Sun week in the hospital's time zone. */
function bounds(start: string, end: string): [Date, Date] {
  return [zonedMidnight(start, config.timezone), zonedMidnight(addDays(end, 1), config.timezone)];
}

// ---------------------------------------------------------------- parsers (pure, tested)

/**
 * Page insights return one value per day with end_time = the END of that day in Pacific time
 * (e.g. "2026-09-15T07:00:00+0000" is Sep 14). Returns date → value.
 */
export function parsePageDaily(json: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  const data = (json as { data?: { values?: { value?: unknown; end_time?: string }[] }[] }).data ?? [];
  for (const v of data[0]?.values ?? []) {
    if (!v.end_time) continue;
    const endUtc = new Date(v.end_time.replace(/\+0000$/, 'Z'));
    const day = new Date(endUtc.getTime() - 12 * 3600_000).toISOString().slice(0, 10);
    out[day] = (out[day] ?? 0) + (typeof v.value === 'number' ? v.value : 0);
  }
  return out;
}

/** Instagram total_value response → number (optionally one breakdown bucket, e.g. FOLLOWER). */
export function parseIgTotal(json: unknown, bucket?: string): number {
  const d = (json as { data?: { total_value?: { value?: number; breakdowns?: { results?: { dimension_values?: string[]; value?: number }[] }[] } }[] }).data?.[0];
  if (!d?.total_value) throw new Error('No value returned');
  if (!bucket) return d.total_value.value ?? 0;
  const hit = d.total_value.breakdowns?.[0]?.results?.find((r) => r.dimension_values?.includes(bucket));
  return hit?.value ?? 0;
}

function sumRange(series: Record<string, number>, start: string, end: string): number {
  let t = 0;
  for (const [d, v] of Object.entries(series)) if (d >= start && d <= end) t += v;
  return t;
}

const shortError = (err: unknown) => (err as Error).message.replace(/^Meta \d+: /, '').slice(0, 160);

function firstLine(text: string): string {
  const line = (text ?? '').split('\n').find((l) => l.trim()) ?? '';
  return line.length > 90 ? `${line.slice(0, 87)}…` : line;
}

// ---------------------------------------------------------------- Facebook Page

async function facebookReport(w: Week): Promise<ChannelReport> {
  const r: ChannelReport = { channel: 'facebook', label: 'Facebook', followers: null, metrics: [], posts: { cur: 0, prev: 0 }, engagement: { cur: 0, prev: 0 }, topPost: null };
  const page = config.metaPageId;

  try {
    const info = await graph(page, { fields: 'followers_count,fan_count' }, 'GET');
    r.followers = Number(info.followers_count ?? info.fan_count ?? 0) || null;
  } catch (err) {
    r.error = shortError(err);
    return r; // token or page id is wrong; nothing else will work either
  }

  const metrics: { key: string; label: string; name: string }[] = [{ key: 'views', label: 'Media views', name: process.env.META_FB_VIEWS_METRIC || 'page_media_view' }];
  for (const m of metrics) {
    try {
      const json = await graph(`${page}/insights`, { metric: m.name, period: 'day', since: w.prevStart, until: addDays(w.weekEnd, 2) }, 'GET');
      const daily = parsePageDaily(json);
      r.metrics.push({ key: m.key, label: m.label, value: { cur: sumRange(daily, w.weekStart, w.weekEnd), prev: sumRange(daily, w.prevStart, w.prevEnd) } });
    } catch (err) {
      r.metrics.push({ key: m.key, label: m.label, value: null, note: shortError(err) });
    }
  }

  // Engagement from the posts themselves (reactions + comments + shares), not from insights metrics.
  try {
    const [start] = bounds(w.prevStart, w.prevEnd);
    const [curStart, curEnd] = bounds(w.weekStart, w.weekEnd);
    const json = (await graph(
      `${page}/published_posts`,
      {
        fields: 'created_time,message,permalink_url,shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)',
        since: unix(start),
        until: unix(curEnd),
        limit: '100',
      },
      'GET',
    )) as { data?: { created_time: string; message?: string; permalink_url?: string; shares?: { count?: number }; reactions?: { summary?: { total_count?: number } }; comments?: { summary?: { total_count?: number } } }[] };
    for (const p of json.data ?? []) {
      const at = new Date(p.created_time.replace(/\+0000$/, 'Z'));
      const eng = (p.reactions?.summary?.total_count ?? 0) + (p.comments?.summary?.total_count ?? 0) + (p.shares?.count ?? 0);
      if (at >= curStart && at < curEnd) {
        r.posts.cur++;
        r.engagement.cur += eng;
        if (!r.topPost || eng > r.topPost.engagement) r.topPost = { text: firstLine(p.message ?? ''), url: p.permalink_url ?? '', engagement: eng, when: p.created_time };
      } else if (at >= start && at < curStart) {
        r.posts.prev++;
        r.engagement.prev += eng;
      }
    }
  } catch (err) {
    r.metrics.push({ key: 'posts', label: 'Post engagement', value: null, note: shortError(err) });
  }
  return r;
}

// ---------------------------------------------------------------- Instagram

async function instagramReport(w: Week): Promise<ChannelReport> {
  const r: ChannelReport = { channel: 'instagram', label: 'Instagram', followers: null, metrics: [], posts: { cur: 0, prev: 0 }, engagement: { cur: 0, prev: 0 }, topPost: null };
  const ig = config.metaIgUserId;

  try {
    const info = await graph(ig, { fields: 'followers_count' }, 'GET');
    r.followers = typeof info.followers_count === 'number' ? info.followers_count : null;
  } catch (err) {
    r.error = shortError(err);
    return r;
  }

  const [prevStart, curStart] = bounds(w.prevStart, w.prevEnd);
  const [, curEnd] = bounds(w.weekStart, w.weekEnd);
  const metrics: { key: string; label: string; name: string; breakdown?: string; bucket?: string }[] = [
    { key: 'views', label: 'Views', name: 'views' },
    { key: 'reach', label: 'Accounts reached', name: 'reach' },
    { key: 'interactions', label: 'Interactions', name: 'total_interactions' },
    { key: 'link_taps', label: 'Profile button taps', name: 'profile_links_taps' },
    { key: 'follows', label: 'New followers', name: 'follows_and_unfollows', breakdown: 'follow_type', bucket: 'FOLLOWER' },
  ];
  for (const m of metrics) {
    try {
      const get = async (from: Date, to: Date) => {
        const params: Record<string, string> = { metric: m.name, period: 'day', metric_type: 'total_value', since: unix(from), until: unix(to) };
        if (m.breakdown) params.breakdown = m.breakdown;
        return parseIgTotal(await graph(`${ig}/insights`, params, 'GET'), m.bucket);
      };
      r.metrics.push({ key: m.key, label: m.label, value: { cur: await get(curStart, curEnd), prev: await get(prevStart, curStart) } });
    } catch (err) {
      r.metrics.push({ key: m.key, label: m.label, value: null, note: shortError(err) });
    }
  }

  try {
    const json = (await graph(ig + '/media', { fields: 'timestamp,caption,permalink,like_count,comments_count', since: unix(prevStart), until: unix(curEnd), limit: '100' }, 'GET')) as {
      data?: { timestamp: string; caption?: string; permalink?: string; like_count?: number; comments_count?: number }[];
    };
    for (const p of json.data ?? []) {
      const at = new Date(p.timestamp.replace(/\+0000$/, 'Z'));
      const eng = (p.like_count ?? 0) + (p.comments_count ?? 0);
      if (at >= curStart && at < curEnd) {
        r.posts.cur++;
        r.engagement.cur += eng;
        if (!r.topPost || eng > r.topPost.engagement) r.topPost = { text: firstLine(p.caption ?? ''), url: p.permalink ?? '', engagement: eng, when: p.timestamp };
      } else if (at >= prevStart && at < curStart) {
        r.posts.prev++;
        r.engagement.prev += eng;
      }
    }
  } catch (err) {
    r.metrics.push({ key: 'posts', label: 'Post engagement', value: null, note: shortError(err) });
  }
  return r;
}

/** Facebook and Instagram numbers for the week; empty when Meta isn't connected. */
export async function socialReport(w: Week): Promise<ChannelReport[]> {
  const out: ChannelReport[] = [];
  if (metaEnabled()) out.push(await facebookReport(w));
  if (instagramEnabled()) out.push(await instagramReport(w));
  return out;
}
