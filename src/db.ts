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
