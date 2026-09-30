import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.ts';

const COOKIE = 'chetna_social';
const SESSION_HOURS = 12;

function sign(value: string): string {
  return createHmac('sha256', config.sessionSecret).update(value).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function checkPassword(given: string): boolean {
  if (!config.appPassword) return false;
  // Compare HMACs so the comparison is constant-time whatever the input length.
  return safeEqual(sign(`pw:${given}`), sign(`pw:${config.appPassword}`));
}

function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function sessionValue(req: Request): string | null {
  const raw = readCookie(req, COOKIE);
  if (!raw) return null;
  const [exp, sig] = raw.split('.');
  if (!exp || !sig || !safeEqual(sig, sign(`session:${exp}`))) return null;
  if (Number(exp) < Date.now()) return null;
  return raw;
}

export function startSession(req: Request, res: Response): void {
  const exp = String(Date.now() + SESSION_HOURS * 3600_000);
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${encodeURIComponent(`${exp}.${sign(`session:${exp}`)}`)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}${secure ? '; Secure' : ''}`,
  );
}

export function endSession(res: Response): void {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

/** Per-session token embedded in every form. */
export function csrfToken(req: Request): string {
  const s = sessionValue(req);
  return s ? sign(`csrf:${s}`) : '';
}

export function requireLogin(req: Request, res: Response, next: NextFunction): void {
  if (sessionValue(req)) return next();
  if (req.method === 'GET') return res.redirect(303, '/login');
  res.status(401).send('Please log in again.');
}

/**
 * Blocks cross-site form posts: the browser's Origin (or Referer) must be this site, and the form must
 * carry this session's CSRF token.
 */
export function requireSameOrigin(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== 'POST') return next();
  const origin = req.headers.origin ?? req.headers.referer;
  const host = req.headers['x-forwarded-host'] ?? req.headers.host;
  let ok = false;
  if (origin && host) {
    try {
      ok = new URL(origin).host === host;
    } catch {
      ok = false;
    }
  }
  if (!ok) {
    res.status(403).send('Blocked: request did not come from this site.');
    return;
  }
  next();
}

export function requireCsrf(req: Request, res: Response, next: NextFunction): void {
  const expected = csrfToken(req);
  const given = typeof req.body?._csrf === 'string' ? req.body._csrf : '';
  if (!expected || !safeEqual(given, expected)) {
    res.status(403).send('Blocked: the form expired. Go back, reload the page and try again.');
    return;
  }
  next();
}

const attempts = new Map<string, { count: number; until: number }>();

/** At most 10 failed logins per IP per 15 minutes. */
export function loginAllowed(ip: string): boolean {
  const a = attempts.get(ip);
  return !a || a.until < Date.now() || a.count < 10;
}

export function recordLoginFailure(ip: string): void {
  const a = attempts.get(ip);
  if (!a || a.until < Date.now()) attempts.set(ip, { count: 1, until: Date.now() + 15 * 60_000 });
  else a.count++;
}

export function secretMatches(given: string | undefined, expected: string): boolean {
  if (!expected || !given) return false;
  return safeEqual(sign(`secret:${given}`), sign(`secret:${expected}`));
}
