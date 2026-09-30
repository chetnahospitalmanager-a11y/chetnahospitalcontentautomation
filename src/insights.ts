import { config, gbpEnabled } from './config.ts';
import { activityBetween, listReports, saveReport, type ReportRow } from './db.ts';
import { findDoctor } from './hospital.ts';
import { sendAlert } from './notify.ts';
import { fetchDailyMetrics, getMatch, listLocations, listReviews, reviewStats } from './publishers/gbp.ts';

export const METRICS = {
  views: {
    label: 'Profile views',
    google: [
      'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
      'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
      'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
      'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
    ],
  },
  calls: { label: 'Calls', google: ['CALL_CLICKS'] },
  directions: { label: 'Direction requests', google: ['BUSINESS_DIRECTION_REQUESTS'] },
  website: { label: 'Website clicks', google: ['WEBSITE_CLICKS'] },
} as const;
export type MetricKey = keyof typeof METRICS;
export const METRIC_KEYS = Object.keys(METRICS) as MetricKey[];

export interface Pair {
  cur: number;
  prev: number;
}

export interface ProfileReport {
  title: string;
  location: string;
  kind: 'hospital' | 'doctor' | 'other';
  doctor: string | null;
  metrics: Record<MetricKey, Pair>;
  rating: number | null;
  totalReviews: number;
  newReviews: number;
  newReviewsAvg: number | null;
  error?: string;
}

export interface WeeklyReport {
  weekStart: string;
  weekEnd: string;
  prevStart: string;
  prevEnd: string;
  generatedAt: string;
  profiles: ProfileReport[];
  totals: Record<MetricKey, Pair>;
  activity: { postsPublished: number; repliesPosted: number; reviewsWaiting: number };
  highlights: string[];
}

// ---------------------------------------------------------------- dates ("YYYY-MM-DD", no time zone games)

export function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function weekday(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
}

export function todayIn(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** The latest Monday–Sunday week that ended at least `lagDays` ago, and the week before it. */
export function reportWeek(today: string, lagDays: number): { weekStart: string; weekEnd: string; prevStart: string; prevEnd: string } {
  let end = addDays(today, -lagDays);
  while (weekday(end) !== 0) end = addDays(end, -1);
  const weekStart = addDays(end, -6);
  return { weekStart, weekEnd: end, prevStart: addDays(weekStart, -7), prevEnd: addDays(weekStart, -1) };
}

export function fmtRange(start: string, end: string): string {
  const f = (iso: string, withYear: boolean) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC' });
  return `${f(start, false)} – ${f(end, true)}`;
}

// ---------------------------------------------------------------- numbers

export function change(p: Pair): string {
  if (p.prev === 0) return p.cur > 0 ? 'new' : '–';
  const pct = Math.round(((p.cur - p.prev) / p.prev) * 100);
  return `${pct > 0 ? '+' : ''}${pct}%`;
}

function sumRange(series: Record<string, number>, start: string, end: string): number {
  let total = 0;
  for (const [date, v] of Object.entries(series)) if (date >= start && date <= end) total += v;
  return total;
}

const emptyMetrics = (): Record<MetricKey, Pair> =>
  Object.fromEntries(METRIC_KEYS.map((k) => [k, { cur: 0, prev: 0 }])) as Record<MetricKey, Pair>;

/** Plain-language observations, worked out from the numbers (no AI, so nothing is invented). */
const n = (v: number) => v.toLocaleString('en-IN');

export function highlights(r: Pick<WeeklyReport, 'profiles' | 'totals' | 'activity'>): string[] {
  const out: string[] = [];
  const t = r.totals;
  out.push(
    `Across all profiles: ${n(t.calls.cur)} calls (${change(t.calls)}), ${n(t.directions.cur)} direction requests (${change(t.directions)}), ${n(t.website.cur)} website clicks (${change(t.website)}), ${n(t.views.cur)} profile views (${change(t.views)}).`,
  );
  const ok = r.profiles.filter((p) => !p.error);
  const doctors = ok.filter((p) => p.kind === 'doctor');
  const topCalls = [...doctors].sort((a, b) => b.metrics.calls.cur - a.metrics.calls.cur)[0];
  if (topCalls && topCalls.metrics.calls.cur > 0) out.push(`Most calls among doctors: ${topCalls.title} (${topCalls.metrics.calls.cur}).`);
  const drops = ok
    .filter((p) => p.metrics.views.prev >= 20 && p.metrics.views.cur <= p.metrics.views.prev * 0.75)
    .sort((a, b) => a.metrics.views.cur / a.metrics.views.prev - b.metrics.views.cur / b.metrics.views.prev);
  for (const p of drops.slice(0, 2)) out.push(`Views fell on ${p.title}: ${n(p.metrics.views.prev)} → ${n(p.metrics.views.cur)} (${change(p.metrics.views)}). Worth a fresh post or photo.`);
  const rises = ok
    .filter((p) => p.metrics.views.prev >= 20 && p.metrics.views.cur >= p.metrics.views.prev * 1.25)
    .sort((a, b) => b.metrics.views.cur / b.metrics.views.prev - a.metrics.views.cur / a.metrics.views.prev);
  if (rises[0]) out.push(`Views grew on ${rises[0].title}: ${n(rises[0].metrics.views.prev)} → ${n(rises[0].metrics.views.cur)} (${change(rises[0].metrics.views)}).`);
  const low = ok.filter((p) => p.rating !== null && p.rating < 4 && p.totalReviews >= 3);
  if (low.length) out.push(`Rating below 4.0: ${low.map((p) => `${p.title} (${p.rating!.toFixed(1)})`).join(', ')}.`);
  const newReviews = ok.reduce((n, p) => n + p.newReviews, 0);
  out.push(`${newReviews} new Google review${newReviews === 1 ? '' : 's'} this week; ${r.activity.repliesPosted} replies posted from this tool; ${r.activity.reviewsWaiting} still waiting.`);
  out.push(`${r.activity.postsPublished} post${r.activity.postsPublished === 1 ? '' : 's'} published this week.`);
  const failed = r.profiles.filter((p) => p.error);
  if (failed.length) out.push(`Could not read ${failed.length} profile${failed.length === 1 ? '' : 's'}: ${failed.map((p) => p.title).join(', ')}.`);
  return out;
}

// ---------------------------------------------------------------- building the report

let running: Promise<ReportRow<WeeklyReport>> | null = null;

/** Build (or rebuild) the report for the latest complete week, or for the week starting `weekStart`. */
export function generateWeeklyReport(opts: { weekStart?: string; alert?: boolean } = {}): Promise<ReportRow<WeeklyReport>> {
  if (!running) running = build(opts).finally(() => (running = null));
  return running;
}

async function build(opts: { weekStart?: string; alert?: boolean }): Promise<ReportRow<WeeklyReport>> {
  if (!gbpEnabled()) throw new Error('Google Business Profiles are not connected yet (GBP_* settings)');
  const w = opts.weekStart
    ? { weekStart: opts.weekStart, weekEnd: addDays(opts.weekStart, 6), prevStart: addDays(opts.weekStart, -7), prevEnd: addDays(opts.weekStart, -1) }
    : reportWeek(todayIn(config.timezone), config.insightsLagDays);

  const locations = await listLocations();
  let match: Awaited<ReturnType<typeof getMatch>> | null = null;
  try {
    match = await getMatch();
  } catch {
    match = null; // the report still works, just without doctor names
  }
  const doctorOf = new Map<string, string>();
  for (const [slug, loc] of match?.byDoctor ?? []) doctorOf.set(loc.name, findDoctor(slug)?.name ?? slug);

  const allGoogle = METRIC_KEYS.flatMap((k) => [...METRICS[k].google]);
  const profiles: ProfileReport[] = [];
  for (const loc of locations) {
    const p: ProfileReport = {
      title: loc.title,
      location: loc.name,
      kind: match?.hospital?.name === loc.name ? 'hospital' : doctorOf.has(loc.name) ? 'doctor' : 'other',
      doctor: doctorOf.get(loc.name) ?? null,
      metrics: emptyMetrics(),
      rating: null,
      totalReviews: 0,
      newReviews: 0,
      newReviewsAvg: null,
    };
    try {
      const series = await fetchDailyMetrics(loc, allGoogle, w.prevStart, w.weekEnd);
      for (const k of METRIC_KEYS) {
        for (const g of METRICS[k].google) {
          p.metrics[k].cur += sumRange(series[g] ?? {}, w.weekStart, w.weekEnd);
          p.metrics[k].prev += sumRange(series[g] ?? {}, w.prevStart, w.prevEnd);
        }
      }
      const stats = await reviewStats(loc);
      p.rating = stats.averageRating;
      p.totalReviews = stats.totalReviews;
      const fresh = (await listReviews(loc, new Date(`${w.weekStart}T00:00:00Z`))).filter((rv) => {
        const created = rv.createTime.slice(0, 10);
        return created >= w.weekStart && created <= w.weekEnd;
      });
      p.newReviews = fresh.length;
      p.newReviewsAvg = fresh.length ? Math.round((fresh.reduce((n, rv) => n + rv.rating, 0) / fresh.length) * 10) / 10 : null;
    } catch (err) {
      p.error = (err as Error).message.slice(0, 300);
    }
    profiles.push(p);
  }

  const rank = { hospital: 0, doctor: 1, other: 2 };
  profiles.sort((a, b) => rank[a.kind] - rank[b.kind] || b.metrics.calls.cur - a.metrics.calls.cur || a.title.localeCompare(b.title));

  const totals = emptyMetrics();
  for (const p of profiles) {
    for (const k of METRIC_KEYS) {
      totals[k].cur += p.metrics[k].cur;
      totals[k].prev += p.metrics[k].prev;
    }
  }
  const activity = await activityBetween(`${w.weekStart}T00:00:00.000Z`, `${addDays(w.weekEnd, 1)}T00:00:00.000Z`);
  const report: WeeklyReport = { ...w, generatedAt: new Date().toISOString(), profiles, totals, activity, highlights: [] };
  report.highlights = highlights(report);

  const saved = await saveReport(w.weekStart, w.weekEnd, report);
  if (opts.alert && config.publicBaseUrl) {
    await sendAlert(
      `Weekly Google report ${fmtRange(w.weekStart, w.weekEnd)}: ${totals.calls.cur} calls (${change(totals.calls)}), ${totals.directions.cur} directions (${change(totals.directions)})`,
      `${config.publicBaseUrl}/insights/${saved.id}`,
    );
  }
  return saved;
}

export async function latestReports(): Promise<ReportRow<WeeklyReport>[]> {
  return listReports<WeeklyReport>();
}

/** Spreadsheet-friendly export: one row per profile. */
export function reportCsv(r: WeeklyReport): string {
  const cell = (v: unknown) => {
    const s = String(v ?? '');
    // Quote everything; neutralise leading =,+,-,@ so spreadsheet apps don't run it as a formula.
    return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
  };
  const header = [
    'Profile',
    'Type',
    'Doctor',
    ...METRIC_KEYS.flatMap((k) => [`${METRICS[k].label} (this week)`, `${METRICS[k].label} (previous week)`]),
    'Rating',
    'Total reviews',
    'New reviews',
    'New reviews avg',
    'Error',
  ];
  const rows = r.profiles.map((p) => [
    p.title,
    p.kind,
    p.doctor ?? '',
    ...METRIC_KEYS.flatMap((k) => [p.metrics[k].cur, p.metrics[k].prev]),
    p.rating ?? '',
    p.totalReviews,
    p.newReviews,
    p.newReviewsAvg ?? '',
    p.error ?? '',
  ]);
  return [header, ...rows].map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
