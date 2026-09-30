import type { Doctor } from './hospital.ts';

export interface GbpLocation {
  /** "locations/123" */
  name: string;
  /** "accounts/456" */
  account: string;
  title: string;
}

export interface GbpMatch {
  hospital: GbpLocation | null;
  byDoctor: Map<string, GbpLocation>;
  /** Human-readable notes about locations that were skipped and why. */
  problems: string[];
}

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t && t !== 'dr' && t !== 'doctor');
}

/** How many of the doctor's key name parts (first name + surname) appear in the title; 0 = no match. */
function score(doctor: Doctor, titleTokens: Set<string>): number {
  const parts = tokens(doctor.name);
  if (parts.length === 0) return 0;
  const key = parts.length === 1 ? [parts[0]] : [parts[0], parts[parts.length - 1]];
  if (!key.every((k) => titleTokens.has(k))) return 0;
  return parts.filter((p) => titleTokens.has(p)).length;
}

/**
 * Match each Google profile to a doctor by first name + surname, so "Dr. Aishwarya Pethe" still matches
 * "Dr. Aishwarya Patil Pethe" while the several Dr. Patils are not mixed up. Anything ambiguous is skipped
 * rather than guessed: posting a doctor's content on the wrong doctor's profile is worse than not posting.
 */
export function matchLocations(
  locations: GbpLocation[],
  doctors: Doctor[],
  opts: { hospitalLocation?: string; hospitalKeyword: string },
): GbpMatch {
  const problems: string[] = [];
  const byDoctor = new Map<string, GbpLocation>();
  const claimed = new Map<string, GbpLocation[]>();
  const leftovers: GbpLocation[] = [];

  for (const loc of locations) {
    if (opts.hospitalLocation && loc.name === opts.hospitalLocation) continue;
    const t = new Set(tokens(loc.title));
    const scored = doctors.map((d) => ({ d, s: score(d, t) })).filter((x) => x.s > 0);
    if (scored.length === 0) {
      leftovers.push(loc);
      continue;
    }
    const best = Math.max(...scored.map((x) => x.s));
    const top = scored.filter((x) => x.s === best);
    if (top.length > 1) {
      problems.push(`"${loc.title}" matches more than one doctor (${top.map((x) => x.d.name).join(', ')}); skipped`);
      continue;
    }
    const slug = top[0].d.slug;
    claimed.set(slug, [...(claimed.get(slug) ?? []), loc]);
  }

  for (const [slug, locs] of claimed) {
    if (locs.length === 1) byDoctor.set(slug, locs[0]);
    else problems.push(`${locs.length} profiles match the same doctor (${locs.map((l) => `"${l.title}"`).join(', ')}); skipped`);
  }

  let hospital: GbpLocation | null = null;
  if (opts.hospitalLocation) {
    hospital = locations.find((l) => l.name === opts.hospitalLocation) ?? null;
    if (!hospital) problems.push(`GBP_HOSPITAL_LOCATION ${opts.hospitalLocation} was not found`);
  } else {
    const kw = opts.hospitalKeyword.toLowerCase();
    const cands = leftovers.filter((l) => l.title.toLowerCase().includes(kw));
    if (cands.length === 1) hospital = cands[0];
    else if (cands.length > 1)
      problems.push(`Several profiles could be the hospital (${cands.map((l) => `"${l.title}"`).join(', ')}); set GBP_HOSPITAL_LOCATION`);
    else problems.push('No hospital profile found; set GBP_HOSPITAL_LOCATION');
  }

  for (const l of leftovers) {
    if (l !== hospital) problems.push(`"${l.title}" did not match any doctor in data/hospital.json`);
  }

  return { hospital, byDoctor, problems };
}
