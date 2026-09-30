import { config } from '../config.ts';
import { matchLocations, type GbpLocation } from '../gbpMatch.ts';
import { loadHospital } from '../hospital.ts';
import { graph } from './meta.ts';

// Doctors' own Facebook Pages (and linked Instagram accounts). They are found through the business
// portfolio's system user: every Page it manages is listed with its own Page token, then matched to a
// doctor by name exactly like the Google profiles (or pinned with `facebookPageId` in hospital.json).

export interface MetaAccount {
  pageId: string;
  pageName: string;
  token: string;
  igUserId: string | null;
  igUsername: string | null;
}

export interface DoctorPages {
  byDoctor: Map<string, MetaAccount>;
  problems: string[];
}

export function doctorPagesEnabled(): boolean {
  return Boolean(config.metaSystemUserToken);
}

interface ManagedPage {
  id: string;
  name: string;
  access_token?: string;
  instagram_business_account?: { id: string; username?: string };
}

async function listManagedPages(): Promise<ManagedPage[]> {
  const out: ManagedPage[] = [];
  let after = '';
  for (let i = 0; i < 10; i++) {
    const params: Record<string, string> = { fields: 'id,name,access_token,instagram_business_account{id,username}', limit: '100' };
    if (after) params.after = after;
    const r = (await graph('me/accounts', params, 'GET', config.metaSystemUserToken)) as {
      data?: ManagedPage[];
      paging?: { cursors?: { after?: string }; next?: string };
    };
    out.push(...(r.data ?? []));
    after = r.paging?.next ? (r.paging.cursors?.after ?? '') : '';
    if (!after) break;
  }
  return out;
}

let cache: { value: DoctorPages; at: number } | null = null;

export async function getDoctorPages(fresh = false): Promise<DoctorPages> {
  if (!doctorPagesEnabled()) return { byDoctor: new Map(), problems: [] };
  if (!fresh && cache && Date.now() - cache.at < 6 * 3600_000) return cache.value;

  const pages = (await listManagedPages()).filter((p) => p.id !== config.metaPageId);
  const doctors = loadHospital().doctors;
  const toAccount = (p: ManagedPage): MetaAccount => ({
    pageId: p.id,
    pageName: p.name,
    token: p.access_token ?? '',
    igUserId: p.instagram_business_account?.id ?? null,
    igUsername: p.instagram_business_account?.username ?? null,
  });

  const byDoctor = new Map<string, MetaAccount>();
  const problems: string[] = [];

  // 1. Pinned pages.
  const pinned = new Set<string>();
  for (const d of doctors) {
    if (!d.facebookPageId) continue;
    const p = pages.find((x) => x.id === d.facebookPageId);
    if (p) {
      byDoctor.set(d.slug, toAccount(p));
      pinned.add(p.id);
    } else {
      problems.push(`${d.name}: Facebook Page ${d.facebookPageId} is not managed by the system user`);
    }
  }

  // 2. Everything else is matched by name, skipping anything ambiguous.
  const asLocations: GbpLocation[] = pages.filter((p) => !pinned.has(p.id)).map((p) => ({ name: p.id, account: '', title: p.name }));
  const match = matchLocations(
    asLocations,
    doctors.filter((d) => !byDoctor.has(d.slug)),
    { hospitalKeyword: '\u0000' }, // the hospital Page is configured separately; don't guess one here
  );
  for (const [slug, loc] of match.byDoctor) {
    const p = pages.find((x) => x.id === loc.name)!;
    byDoctor.set(slug, toAccount(p));
  }
  problems.push(
    ...match.problems.filter((m) => !m.startsWith('No hospital profile found')).map((m) => m.replace('did not match any doctor in data/hospital.json', 'is not a doctor\'s Page (ignored)')),
  );
  for (const [slug, acc] of byDoctor) {
    if (!acc.token) problems.push(`${acc.pageName}: no Page token returned; give the system user full control of this Page`);
    if (!acc.igUserId) problems.push(`${acc.pageName}: no Instagram account linked (Facebook only for ${slug})`);
  }

  const value = { byDoctor, problems };
  cache = { value, at: Date.now() };
  return value;
}

/** For tests. */
export function clearDoctorPagesCache(): void {
  cache = null;
}
