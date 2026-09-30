import { createClient, type Client } from '@libsql/client';
import { config } from './config.ts';

export type PostKind = 'doctor' | 'department' | 'hospital' | 'custom';
export type PostStatus = 'draft' | 'publishing' | 'published' | 'partial' | 'failed' | 'skipped';

export interface PublishResult {
  channel: string; // "facebook" | "instagram" | "gbp:<location title>"
  ok: boolean;
  id?: string;
  error?: string;
}

export interface Post {
  id: number;
  kind: PostKind;
  subject: string;
  title: string;
  caption: string;
  imageKey: string;
  status: PostStatus;
  warnings: string[];
  results: PublishResult[];
  createdAt: string;
  updatedAt: string;
}

let client: Client | null = null;
let ready: Promise<void> | null = null;

export function db(): Client {
  if (!client) {
    client = createClient({
      url: config.databaseUrl,
      authToken: config.databaseAuthToken || undefined,
    });
  }
  return client;
}

/** For tests: point at a fresh database. */
export function resetDb(): void {
  client?.close();
  client = null;
  ready = null;
}

export function initDb(): Promise<void> {
  if (!ready) {
    ready = db()
      .batch(
        [
          `CREATE TABLE IF NOT EXISTS posts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            kind TEXT NOT NULL,
            subject TEXT NOT NULL,
            title TEXT NOT NULL,
            caption TEXT NOT NULL,
            image_key TEXT NOT NULL,
            status TEXT NOT NULL,
            warnings TEXT NOT NULL DEFAULT '[]',
            results TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          )`,
          `CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
          `CREATE TABLE IF NOT EXISTS reviews (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            review_name TEXT NOT NULL UNIQUE,
            location_title TEXT NOT NULL,
            reviewer TEXT NOT NULL,
            rating INTEGER NOT NULL,
            comment TEXT NOT NULL,
            review_updated TEXT NOT NULL,
            reply TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL,
            warnings TEXT NOT NULL DEFAULT '[]',
            error TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          )`,
        ],
        'write',
      )
      .then(() => undefined);
  }
  return ready;
}

function rowToPost(r: Record<string, unknown>): Post {
  return {
    id: Number(r.id),
    kind: r.kind as PostKind,
    subject: String(r.subject),
    title: String(r.title),
    caption: String(r.caption),
    imageKey: String(r.image_key),
    status: r.status as PostStatus,
    warnings: JSON.parse(String(r.warnings)),
    results: JSON.parse(String(r.results)),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export async function insertPost(p: {
  kind: PostKind;
  subject: string;
  title: string;
  caption: string;
  imageKey: string;
  warnings: string[];
}): Promise<Post> {
  await initDb();
  const now = new Date().toISOString();
  const res = await db().execute({
    sql: `INSERT INTO posts (kind, subject, title, caption, image_key, status, warnings, results, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'draft', ?, '[]', ?, ?) RETURNING *`,
    args: [p.kind, p.subject, p.title, p.caption, p.imageKey, JSON.stringify(p.warnings), now, now],
  });
  return rowToPost(res.rows[0] as Record<string, unknown>);
}

export async function getPost(id: number): Promise<Post | null> {
  await initDb();
  const res = await db().execute({ sql: 'SELECT * FROM posts WHERE id = ?', args: [id] });
  return res.rows[0] ? rowToPost(res.rows[0] as Record<string, unknown>) : null;
}

export async function listPosts(opts: { status?: PostStatus[]; limit?: number } = {}): Promise<Post[]> {
  await initDb();
  const limit = opts.limit ?? 50;
  if (opts.status?.length) {
    const marks = opts.status.map(() => '?').join(',');
    const res = await db().execute({
      sql: `SELECT * FROM posts WHERE status IN (${marks}) ORDER BY id DESC LIMIT ?`,
      args: [...opts.status, limit],
    });
    return res.rows.map((r) => rowToPost(r as Record<string, unknown>));
  }
  const res = await db().execute({ sql: 'SELECT * FROM posts ORDER BY id DESC LIMIT ?', args: [limit] });
  return res.rows.map((r) => rowToPost(r as Record<string, unknown>));
}

export async function updatePost(
  id: number,
  fields: Partial<Pick<Post, 'caption' | 'status' | 'warnings' | 'results'>>,
): Promise<void> {
  await initDb();
  const sets: string[] = [];
  const args: (string | number)[] = [];
  if (fields.caption !== undefined) {
    sets.push('caption = ?');
    args.push(fields.caption);
  }
  if (fields.status !== undefined) {
    sets.push('status = ?');
    args.push(fields.status);
  }
  if (fields.warnings !== undefined) {
    sets.push('warnings = ?');
    args.push(JSON.stringify(fields.warnings));
  }
  if (fields.results !== undefined) {
    sets.push('results = ?');
    args.push(JSON.stringify(fields.results));
  }
  sets.push('updated_at = ?');
  args.push(new Date().toISOString());
  args.push(id);
  await db().execute({ sql: `UPDATE posts SET ${sets.join(', ')} WHERE id = ?`, args });
}

/**
 * Atomically move a post from one status to another. Returns false if it was not in one of `from`,
 * which stops a double-click on "Approve" from publishing twice.
 */
export async function transitionPost(id: number, from: PostStatus[], to: PostStatus): Promise<boolean> {
  await initDb();
  const marks = from.map(() => '?').join(',');
  const res = await db().execute({
    sql: `UPDATE posts SET status = ?, updated_at = ? WHERE id = ? AND status IN (${marks})`,
    args: [to, new Date().toISOString(), id, ...from],
  });
  return res.rowsAffected === 1;
}

export async function getKv(key: string): Promise<string | null> {
  await initDb();
  const res = await db().execute({ sql: 'SELECT value FROM kv WHERE key = ?', args: [key] });
  return res.rows[0] ? String(res.rows[0].value) : null;
}

export async function setKv(key: string, value: string): Promise<void> {
  await initDb();
  await db().execute({
    sql: 'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    args: [key, value],
  });
}

// ---------------------------------------------------------------- Google review replies

export type ReviewStatus = 'draft' | 'posting' | 'replied' | 'failed' | 'skipped' | 'replied_elsewhere';

export interface ReviewRow {
  id: number;
  reviewName: string;
  locationTitle: string;
  reviewer: string;
  rating: number;
  comment: string;
  reviewUpdated: string;
  reply: string;
  status: ReviewStatus;
  warnings: string[];
  error: string;
  createdAt: string;
  updatedAt: string;
}

function rowToReview(r: Record<string, unknown>): ReviewRow {
  return {
    id: Number(r.id),
    reviewName: String(r.review_name),
    locationTitle: String(r.location_title),
    reviewer: String(r.reviewer),
    rating: Number(r.rating),
    comment: String(r.comment),
    reviewUpdated: String(r.review_updated),
    reply: String(r.reply),
    status: r.status as ReviewStatus,
    warnings: JSON.parse(String(r.warnings)),
    error: String(r.error),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export async function getReview(id: number): Promise<ReviewRow | null> {
  await initDb();
  const res = await db().execute({ sql: 'SELECT * FROM reviews WHERE id = ?', args: [id] });
  return res.rows[0] ? rowToReview(res.rows[0] as Record<string, unknown>) : null;
}

export async function getReviewByName(name: string): Promise<ReviewRow | null> {
  await initDb();
  const res = await db().execute({ sql: 'SELECT * FROM reviews WHERE review_name = ?', args: [name] });
  return res.rows[0] ? rowToReview(res.rows[0] as Record<string, unknown>) : null;
}

/** Lowest ratings first, so complaints get answered first. */
export async function listReviewRows(opts: { status?: ReviewStatus[]; limit?: number } = {}): Promise<ReviewRow[]> {
  await initDb();
  const limit = opts.limit ?? 100;
  if (opts.status?.length) {
    const marks = opts.status.map(() => '?').join(',');
    const res = await db().execute({
      sql: `SELECT * FROM reviews WHERE status IN (${marks}) ORDER BY rating ASC, review_updated DESC LIMIT ?`,
      args: [...opts.status, limit],
    });
    return res.rows.map((r) => rowToReview(r as Record<string, unknown>));
  }
  const res = await db().execute({ sql: 'SELECT * FROM reviews ORDER BY updated_at DESC LIMIT ?', args: [limit] });
  return res.rows.map((r) => rowToReview(r as Record<string, unknown>));
}

export async function insertReview(r: {
  reviewName: string;
  locationTitle: string;
  reviewer: string;
  rating: number;
  comment: string;
  reviewUpdated: string;
}): Promise<ReviewRow> {
  await initDb();
  const now = new Date().toISOString();
  const res = await db().execute({
    sql: `INSERT INTO reviews (review_name, location_title, reviewer, rating, comment, review_updated, reply, status, warnings, error, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, '', 'draft', '[]', '', ?, ?) RETURNING *`,
    args: [r.reviewName, r.locationTitle, r.reviewer, r.rating, r.comment, r.reviewUpdated, now, now],
  });
  return rowToReview(res.rows[0] as Record<string, unknown>);
}

export async function updateReview(
  id: number,
  fields: Partial<Pick<ReviewRow, 'reply' | 'status' | 'warnings' | 'error' | 'rating' | 'comment' | 'reviewUpdated'>>,
): Promise<void> {
  await initDb();
  const cols: Record<string, string> = {
    reply: 'reply',
    status: 'status',
    warnings: 'warnings',
    error: 'error',
    rating: 'rating',
    comment: 'comment',
    reviewUpdated: 'review_updated',
  };
  const sets: string[] = [];
  const args: (string | number)[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    sets.push(`${cols[k]} = ?`);
    args.push(k === 'warnings' ? JSON.stringify(v) : (v as string | number));
  }
  sets.push('updated_at = ?');
  args.push(new Date().toISOString(), id);
  await db().execute({ sql: `UPDATE reviews SET ${sets.join(', ')} WHERE id = ?`, args });
}

export async function transitionReview(id: number, from: ReviewStatus[], to: ReviewStatus): Promise<boolean> {
  await initDb();
  const marks = from.map(() => '?').join(',');
  const res = await db().execute({
    sql: `UPDATE reviews SET status = ?, updated_at = ? WHERE id = ? AND status IN (${marks})`,
    args: [to, new Date().toISOString(), id, ...from],
  });
  return res.rowsAffected === 1;
}
