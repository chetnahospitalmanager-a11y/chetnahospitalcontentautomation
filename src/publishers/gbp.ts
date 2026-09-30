import { config } from '../config.ts';
import { matchLocations, type GbpLocation, type GbpMatch } from '../gbpMatch.ts';
import { loadHospital } from '../hospital.ts';

let token: { value: string; expires: number } | null = null;

async function accessToken(): Promise<string> {
  if (token && token.expires > Date.now() + 60_000) return token.value;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({
      client_id: config.gbpClientId,
      client_secret: config.gbpClientSecret,
      refresh_token: config.gbpRefreshToken,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !json.access_token) {
    throw new Error(`Google sign-in failed: ${json.error ?? res.status} ${json.error_description ?? ''}`.trim());
  }
  token = { value: json.access_token, expires: Date.now() + (json.expires_in ?? 3600) * 1000 };
  return token.value;
}

async function google<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) throw new Error(`Google ${res.status}: ${json.error?.message ?? 'unknown error'}`);
  return json;
}

export async function listLocations(): Promise<GbpLocation[]> {
  const accounts: string[] = [];
  let pageToken = '';
  do {
    const r = await google<{ accounts?: { name: string }[]; nextPageToken?: string }>(
      `https://mybusinessaccountmanagement.googleapis.com/v1/accounts?pageSize=20${pageToken ? `&pageToken=${pageToken}` : ''}`,
    );
    accounts.push(...(r.accounts ?? []).map((a) => a.name));
    pageToken = r.nextPageToken ?? '';
  } while (pageToken);

  const out: GbpLocation[] = [];
  for (const account of accounts) {
    let page = '';
    do {
      const r = await google<{ locations?: { name: string; title: string }[]; nextPageToken?: string }>(
        `https://mybusinessbusinessinformation.googleapis.com/v1/${account}/locations?readMask=name,title&pageSize=100${page ? `&pageToken=${page}` : ''}`,
      );
      for (const l of r.locations ?? []) {
        if (!out.some((o) => o.name === l.name)) out.push({ name: l.name, title: l.title, account });
      }
      page = r.nextPageToken ?? '';
    } while (page);
  }
  return out;
}

let matchCache: { value: GbpMatch; at: number } | null = null;

export async function getMatch(fresh = false): Promise<GbpMatch> {
  if (!fresh && matchCache && Date.now() - matchCache.at < 6 * 3600_000) return matchCache.value;
  const data = loadHospital();
  const value = matchLocations(await listLocations(), data.doctors, {
    hospitalLocation: config.gbpHospitalLocation || undefined,
    hospitalKeyword: data.hospital.shortName.split(/\s+/)[0],
  });
  matchCache = { value, at: Date.now() };
  return value;
}

export interface GbpReview {
  /** "accounts/1/locations/2/reviews/3" */
  name: string;
  reviewer: string;
  rating: number;
  comment: string;
  createTime: string;
  updateTime: string;
  /** Existing owner reply on Google, if any (e.g. typed in the Google app). */
  replyComment: string | null;
}

const STARS: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

/** Newest first. Stops paging once reviews are older than `since`. */
export async function listReviews(loc: GbpLocation, since: Date): Promise<GbpReview[]> {
  const out: GbpReview[] = [];
  let page = '';
  do {
    const r = await google<{
      reviews?: {
        name: string;
        reviewer?: { displayName?: string; isAnonymous?: boolean };
        starRating?: string;
        comment?: string;
        createTime: string;
        updateTime?: string;
        reviewReply?: { comment?: string };
      }[];
      nextPageToken?: string;
    }>(`https://mybusiness.googleapis.com/v4/${loc.account}/${loc.name}/reviews?pageSize=50&orderBy=updateTime%20desc${page ? `&pageToken=${page}` : ''}`);
    let reachedOld = false;
    for (const rv of r.reviews ?? []) {
      const updated = rv.updateTime ?? rv.createTime;
      if (new Date(updated) < since) {
        reachedOld = true;
        continue;
      }
      out.push({
        name: rv.name,
        reviewer: rv.reviewer?.isAnonymous ? 'A Google user' : (rv.reviewer?.displayName ?? 'A Google user'),
        rating: STARS[rv.starRating ?? ''] ?? 0,
        // Non-English reviews include Google's translation and the original; both are kept for Gemini.
        comment: (rv.comment ?? '').trim(),
        createTime: rv.createTime,
        updateTime: updated,
        replyComment: rv.reviewReply?.comment ?? null,
      });
    }
    page = reachedOld ? '' : (r.nextPageToken ?? '');
  } while (page);
  return out;
}

/** Creates or replaces the owner's public reply to a review. */
export async function replyToReview(reviewName: string, comment: string): Promise<void> {
  await google(`https://mybusiness.googleapis.com/v4/${reviewName}/reply`, {
    method: 'PUT',
    body: JSON.stringify({ comment }),
  });
}

export interface CivilDate {
  year: number;
  month: number;
  day: number;
}

/** "2026-09-28" ↔ {year, month, day} */
export const toCivil = (iso: string): CivilDate => {
  const [year, month, day] = iso.split('-').map(Number);
  return { year, month, day };
};
const fromCivil = (d: CivilDate) => `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;

/**
 * Daily Business Profile Performance metrics (needs the "Business Profile Performance API" enabled).
 * Returns metric → date ("YYYY-MM-DD") → value. Days Google leaves out are zero.
 */
export async function fetchDailyMetrics(
  loc: GbpLocation,
  metrics: string[],
  start: string,
  end: string,
): Promise<Record<string, Record<string, number>>> {
  const q = new URLSearchParams();
  for (const m of metrics) q.append('dailyMetrics', m);
  const s = toCivil(start);
  const e = toCivil(end);
  q.set('dailyRange.startDate.year', String(s.year));
  q.set('dailyRange.startDate.month', String(s.month));
  q.set('dailyRange.startDate.day', String(s.day));
  q.set('dailyRange.endDate.year', String(e.year));
  q.set('dailyRange.endDate.month', String(e.month));
  q.set('dailyRange.endDate.day', String(e.day));
  const r = await google<{
    multiDailyMetricTimeSeries?: {
      dailyMetricTimeSeries?: { dailyMetric: string; timeSeries?: { datedValues?: { date: CivilDate; value?: string }[] } }[];
    }[];
  }>(`https://businessprofileperformance.googleapis.com/v1/${loc.name}:fetchMultiDailyMetricsTimeSeries?${q}`);
  const out: Record<string, Record<string, number>> = Object.fromEntries(metrics.map((m) => [m, {}]));
  for (const group of r.multiDailyMetricTimeSeries ?? []) {
    for (const series of group.dailyMetricTimeSeries ?? []) {
      const bucket = (out[series.dailyMetric] ??= {});
      for (const dv of series.timeSeries?.datedValues ?? []) bucket[fromCivil(dv.date)] = Number(dv.value ?? 0);
    }
  }
  return out;
}

/** Current overall rating and review count shown on the profile. */
export async function reviewStats(loc: GbpLocation): Promise<{ averageRating: number | null; totalReviews: number }> {
  const r = await google<{ averageRating?: number; totalReviewCount?: number }>(
    `https://mybusiness.googleapis.com/v4/${loc.account}/${loc.name}/reviews?pageSize=1`,
  );
  return { averageRating: r.averageRating ?? null, totalReviews: r.totalReviewCount ?? 0 };
}

export async function createLocalPost(loc: GbpLocation, summary: string, imageUrl: string, bookUrl: string): Promise<string> {
  const body: Record<string, unknown> = {
    languageCode: 'en',
    topicType: 'STANDARD',
    summary,
    media: [{ mediaFormat: 'PHOTO', sourceUrl: imageUrl }],
  };
  if (bookUrl) body.callToAction = { actionType: 'BOOK', url: bookUrl };
  const r = await google<{ name?: string }>(`https://mybusiness.googleapis.com/v4/${loc.account}/${loc.name}/localPosts`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return r.name ?? '';
}
