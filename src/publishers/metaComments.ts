import { config } from '../config.ts';
import type { CommentPlatform } from '../db.ts';
import { graph } from './meta.ts';

// Needs these permissions on the Page token: pages_read_engagement, pages_read_user_content,
// pages_manage_engagement (Facebook) and instagram_manage_comments (Instagram).

export interface FetchedComment {
  platform: CommentPlatform;
  commentId: string;
  postText: string;
  postUrl: string;
  author: string;
  text: string;
  createdAt: string;
  /** The Page / our Instagram account has already replied in the thread (e.g. from the Meta app). */
  answeredByUs: boolean;
  /** '' for the hospital's own accounts; otherwise the doctor's Page id (Facebook) or Instagram user id. */
  account: string;
  /** Shown on the Comments page, e.g. "Dr. Nirmal Patil". Empty for the hospital. */
  accountLabel: string;
}

/** Which account to read: the hospital's (default) or a doctor's, with that account's own Page token. */
export interface CommentSource {
  id: string;
  token: string;
  /** '' for the hospital */
  account: string;
  accountLabel: string;
}

const iso = (t: string) => new Date(t.replace(/\+0000$/, 'Z')).toISOString();
const unix = (d: Date) => String(Math.floor(d.getTime() / 1000));

function firstLine(text: string): string {
  const line = (text ?? '').split('\n').find((l) => l.trim()) ?? '';
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}

type FbComment = {
  id: string;
  message?: string;
  created_time: string;
  is_hidden?: boolean;
  from?: { id?: string; name?: string };
  comments?: { data?: { from?: { id?: string } }[] };
};

/** Top-level comments from other people on the Page's recent posts. */
export async function facebookComments(
  postsSince: Date,
  commentsSince: Date,
  src: CommentSource = { id: config.metaPageId, token: config.metaPageAccessToken, account: '', accountLabel: '' },
): Promise<FetchedComment[]> {
  const page = src.id;
  const posts = (await graph(`${page}/published_posts`, { fields: 'id,message,permalink_url,created_time', since: unix(postsSince), limit: '50' }, 'GET', src.token)) as {
    data?: { id: string; message?: string; permalink_url?: string }[];
  };
  const out: FetchedComment[] = [];
  for (const post of posts.data ?? []) {
    const res = (await graph(
      `${post.id}/comments`,
      {
        filter: 'toplevel',
        order: 'reverse_chronological',
        fields: 'id,message,created_time,is_hidden,from{id,name},comments.limit(25){from{id}}',
        limit: '100',
      },
      'GET',
      src.token,
    )) as { data?: FbComment[] };
    for (const c of res.data ?? []) {
      if (c.from?.id === page || c.is_hidden) continue;
      if (new Date(iso(c.created_time)) < commentsSince) continue;
      out.push({
        platform: 'facebook',
        commentId: c.id,
        postText: firstLine(post.message ?? ''),
        postUrl: post.permalink_url ?? '',
        author: c.from?.name ?? 'Facebook user',
        text: (c.message ?? '').trim(),
        createdAt: iso(c.created_time),
        answeredByUs: (c.comments?.data ?? []).some((r) => r.from?.id === page),
        account: src.account,
        accountLabel: src.accountLabel,
      });
    }
  }
  return out;
}

type IgComment = {
  id: string;
  text?: string;
  username?: string;
  timestamp: string;
  hidden?: boolean;
  replies?: { data?: { username?: string }[] };
};

export async function instagramComments(
  postsSince: Date,
  commentsSince: Date,
  src: CommentSource = { id: config.metaIgUserId, token: config.metaPageAccessToken, account: '', accountLabel: '' },
): Promise<FetchedComment[]> {
  const ig = src.id;
  const me = String((await graph(ig, { fields: 'username' }, 'GET', src.token)).username ?? '').toLowerCase();
  const media = (await graph(`${ig}/media`, { fields: 'id,caption,permalink,timestamp', since: unix(postsSince), limit: '50' }, 'GET', src.token)) as {
    data?: { id: string; caption?: string; permalink?: string; timestamp: string }[];
  };
  const out: FetchedComment[] = [];
  for (const m of media.data ?? []) {
    if (new Date(iso(m.timestamp)) < postsSince) continue;
    const res = (await graph(`${m.id}/comments`, { fields: 'id,text,username,timestamp,hidden,replies{username}', limit: '100' }, 'GET', src.token)) as {
      data?: IgComment[];
    };
    for (const c of res.data ?? []) {
      if ((c.username ?? '').toLowerCase() === me || c.hidden) continue;
      if (new Date(iso(c.timestamp)) < commentsSince) continue;
      out.push({
        platform: 'instagram',
        commentId: c.id,
        postText: firstLine(m.caption ?? ''),
        postUrl: m.permalink ?? '',
        author: c.username ? `@${c.username}` : 'Instagram user',
        text: (c.text ?? '').trim(),
        createdAt: iso(c.timestamp),
        answeredByUs: (c.replies?.data ?? []).some((r) => (r.username ?? '').toLowerCase() === me),
        account: src.account,
        accountLabel: src.accountLabel,
      });
    }
  }
  return out;
}

/** Reply as the account the comment was made on (`token` = that account's Page token). */
export async function replyToComment(platform: CommentPlatform, commentId: string, message: string, token = config.metaPageAccessToken): Promise<string> {
  const r =
    platform === 'facebook'
      ? await graph(`${commentId}/comments`, { message }, 'POST', token)
      : await graph(`${commentId}/replies`, { message }, 'POST', token);
  return String(r.id ?? '');
}

/** Hides a comment from everyone except its author and their friends (spam, abuse). Reversible in the Meta apps. */
export async function hideComment(platform: CommentPlatform, commentId: string, token = config.metaPageAccessToken): Promise<void> {
  if (platform === 'facebook') await graph(commentId, { is_hidden: 'true' }, 'POST', token);
  else await graph(commentId, { hide: 'true' }, 'POST', token);
}
