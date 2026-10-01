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
          `CREATE TABLE IF NOT EXISTS reports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            week_start TEXT NOT NULL UNIQUE,
            week_end TEXT NOT NULL,
            data TEXT NOT NULL,
            created_at TEXT NOT NULL
          )`,
          `CREATE TABLE IF NOT EXISTS comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            platform TEXT NOT NULL,
            comment_id TEXT NOT NULL,
            post_text TEXT NOT NULL,
            post_url TEXT NOT NULL,
            author TEXT NOT NULL,
            text TEXT NOT NULL,
            commented_at TEXT NOT NULL,
            reply TEXT NOT NULL DEFAULT '',
            category TEXT NOT NULL DEFAULT '',
            needs_reply INTEGER NOT NULL DEFAULT 1,
            status TEXT NOT NULL,
            warnings TEXT NOT NULL DEFAULT '[]',
            error TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE (platform, comment_id)
          )`,
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
      .then(() => migrate());
  }
  return ready;
}

/** Columns added after the first release. SQLite has no "ADD COLUMN IF NOT EXISTS", so ignore "duplicate column". */
async function migrate(): Promise<void> {
  const add = [
    "ALTER TABLE comments ADD COLUMN account TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE comments ADD COLUMN account_label TEXT NOT NULL DEFAULT ''",
  ];
  for (const sql of add) {
    try {
      await db().execute(sql);
    } catch (err) {
      if (!/duplicate column/i.test((err as Error).message)) throw err;
    }
  }
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

// ---------------------------------------------------------------- Weekly insights reports

export interface ReportRow<T = unknown> {
  id: number;
  weekStart: string;
  weekEnd: string;
  data: T;
  createdAt: string;
}

function rowToReport<T>(r: Record<string, unknown>): ReportRow<T> {
  return {
    id: Number(r.id),
    weekStart: String(r.week_start),
    weekEnd: String(r.week_end),
    data: JSON.parse(String(r.data)) as T,
    createdAt: String(r.created_at),
  };
}

/** Saves the report for a week, replacing an earlier one for the same week. */
export async function saveReport<T>(weekStart: string, weekEnd: string, data: T): Promise<ReportRow<T>> {
  await initDb();
  const res = await db().execute({
    sql: `INSERT INTO reports (week_start, week_end, data, created_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(week_start) DO UPDATE SET week_end = excluded.week_end, data = excluded.data, created_at = excluded.created_at
          RETURNING *`,
    args: [weekStart, weekEnd, JSON.stringify(data), new Date().toISOString()],
  });
  return rowToReport<T>(res.rows[0] as Record<string, unknown>);
}

export async function getReport<T>(id: number): Promise<ReportRow<T> | null> {
  await initDb();
  const res = await db().execute({ sql: 'SELECT * FROM reports WHERE id = ?', args: [id] });
  return res.rows[0] ? rowToReport<T>(res.rows[0] as Record<string, unknown>) : null;
}

export async function listReports<T>(limit = 26): Promise<ReportRow<T>[]> {
  await initDb();
  const res = await db().execute({ sql: 'SELECT * FROM reports ORDER BY week_start DESC LIMIT ?', args: [limit] });
  return res.rows.map((r) => rowToReport<T>(r as Record<string, unknown>));
}

/** Counts of our own activity between two instants (ISO strings). */
export async function activityBetween(
  from: string,
  to: string,
): Promise<{ postsPublished: number; repliesPosted: number; reviewsWaiting: number; commentReplies: number; commentsWaiting: number }> {
  await initDb();
  const [posts, replies, waiting, cReplies, cWaiting] = await Promise.all([
    db().execute({ sql: "SELECT COUNT(*) AS n FROM posts WHERE status IN ('published','partial') AND updated_at >= ? AND updated_at < ?", args: [from, to] }),
    db().execute({ sql: "SELECT COUNT(*) AS n FROM reviews WHERE status = 'replied' AND updated_at >= ? AND updated_at < ?", args: [from, to] }),
    db().execute("SELECT COUNT(*) AS n FROM reviews WHERE status IN ('draft','failed')"),
    db().execute({ sql: "SELECT COUNT(*) AS n FROM comments WHERE status = 'replied' AND updated_at >= ? AND updated_at < ?", args: [from, to] }),
    db().execute("SELECT COUNT(*) AS n FROM comments WHERE status IN ('draft','failed') AND needs_reply = 1"),
  ]);
  return {
    postsPublished: Number(posts.rows[0].n),
    repliesPosted: Number(replies.rows[0].n),
    reviewsWaiting: Number(waiting.rows[0].n),
    commentReplies: Number(cReplies.rows[0].n),
    commentsWaiting: Number(cWaiting.rows[0].n),
  };
}

// ---------------------------------------------------------------- Facebook / Instagram comments

export type CommentPlatform = 'facebook' | 'instagram';
export type CommentStatus = 'draft' | 'posting' | 'replied' | 'failed' | 'skipped' | 'replied_elsewhere' | 'hidden';

export interface CommentRow {
  id: number;
  platform: CommentPlatform;
  commentId: string;
  /** '' = hospital's own account; otherwise the doctor's Page id (Facebook) or Instagram user id */
  account: string;
  accountLabel: string;
  postText: string;
  postUrl: string;
  author: string;
  text: string;
  commentedAt: string;
  reply: string;
  category: string;
  needsReply: boolean;
  status: CommentStatus;
  warnings: string[];
  error: string;
  createdAt: string;
  updatedAt: string;
}

function rowToComment(r: Record<string, unknown>): CommentRow {
  return {
    id: Number(r.id),
    platform: r.platform as CommentPlatform,
    commentId: String(r.comment_id),
    account: String(r.account ?? ''),
    accountLabel: String(r.account_label ?? ''),
    postText: String(r.post_text),
    postUrl: String(r.post_url),
    author: String(r.author),
    text: String(r.text),
    commentedAt: String(r.commented_at),
    reply: String(r.reply),
    category: String(r.category),
    needsReply: Number(r.needs_reply) === 1,
    status: r.status as CommentStatus,
    warnings: JSON.parse(String(r.warnings)),
    error: String(r.error),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export async function getComment(id: number): Promise<CommentRow | null> {
  await initDb();
  const res = await db().execute({ sql: 'SELECT * FROM comments WHERE id = ?', args: [id] });
  return res.rows[0] ? rowToComment(res.rows[0] as Record<string, unknown>) : null;
}

export async function getCommentByRef(platform: CommentPlatform, commentId: string): Promise<CommentRow | null> {
  await initDb();
  const res = await db().execute({ sql: 'SELECT * FROM comments WHERE platform = ? AND comment_id = ?', args: [platform, commentId] });
  return res.rows[0] ? rowToComment(res.rows[0] as Record<string, unknown>) : null;
}

/** Oldest first for open comments, so nobody waits longest. */
export async function listCommentRows(opts: { status?: CommentStatus[]; limit?: number } = {}): Promise<CommentRow[]> {
  await initDb();
  const limit = opts.limit ?? 100;
  if (opts.status?.length) {
    const marks = opts.status.map(() => '?').join(',');
    const res = await db().execute({
      sql: `SELECT * FROM comments WHERE status IN (${marks}) ORDER BY commented_at ASC LIMIT ?`,
      args: [...opts.status, limit],
    });
    return res.rows.map((r) => rowToComment(r as Record<string, unknown>));
  }
  const res = await db().execute({ sql: 'SELECT * FROM comments ORDER BY updated_at DESC LIMIT ?', args: [limit] });
  return res.rows.map((r) => rowToComment(r as Record<string, unknown>));
}

export async function insertComment(c: {
  platform: CommentPlatform;
  commentId: string;
  account?: string;
  accountLabel?: string;
  postText: string;
  postUrl: string;
  author: string;
  text: string;
  commentedAt: string;
}): Promise<CommentRow> {
  await initDb();
  const now = new Date().toISOString();
  const res = await db().execute({
    sql: `INSERT INTO comments (platform, comment_id, account, account_label, post_text, post_url, author, text, commented_at, reply, category, needs_reply, status, warnings, error, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', 1, 'draft', '[]', '', ?, ?) RETURNING *`,
    args: [c.platform, c.commentId, c.account ?? '', c.accountLabel ?? '', c.postText, c.postUrl, c.author, c.text, c.commentedAt, now, now],
  });
  return rowToComment(res.rows[0] as Record<string, unknown>);
}

export async function updateComment(
  id: number,
  fields: Partial<Pick<CommentRow, 'reply' | 'category' | 'needsReply' | 'status' | 'warnings' | 'error'>>,
): Promise<void> {
  await initDb();
  const cols: Record<string, string> = { reply: 'reply', category: 'category', needsReply: 'needs_reply', status: 'status', warnings: 'warnings', error: 'error' };
  const sets: string[] = [];
  const args: (string | number)[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    sets.push(`${cols[k]} = ?`);
    args.push(k === 'warnings' ? JSON.stringify(v) : k === 'needsReply' ? (v ? 1 : 0) : (v as string));
  }
  sets.push('updated_at = ?');
  args.push(new Date().toISOString(), id);
  await db().execute({ sql: `UPDATE comments SET ${sets.join(', ')} WHERE id = ?`, args });
}

export async function transitionComment(id: number, from: CommentStatus[], to: CommentStatus): Promise<boolean> {
  await initDb();
  const marks = from.map(() => '?').join(',');
  const res = await db().execute({
    sql: `UPDATE comments SET status = ?, updated_at = ? WHERE id = ? AND status IN (${marks})`,
    args: [to, new Date().toISOString(), id, ...from],
  });
  return res.rowsAffected === 1;
}
