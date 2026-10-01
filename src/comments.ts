import { bookingLink, config, instagramEnabled, metaEnabled } from './config.ts';
import { cleanCaption, generateJson } from './captions.ts';
import { COMMENT_CATEGORIES, COMMENT_RULES_TEXT, replyWarnings, type CommentCategory } from './compliance.ts';
import {
  getComment,
  getCommentByRef,
  insertComment,
  listCommentRows,
  setKv,
  transitionComment,
  updateComment,
  type CommentPlatform,
  type CommentRow,
} from './db.ts';
import { loadHospital } from './hospital.ts';
import { doctorPagesEnabled, getDoctorPages } from './publishers/metaPages.ts';
import { sendAlert } from './notify.ts';
import { facebookComments, hideComment, instagramComments, replyToComment, type FetchedComment } from './publishers/metaComments.ts';

export interface CommentSyncSummary {
  at: string;
  checked: string[];
  newComments: number;
  drafted: number;
  repliedElsewhere: number;
  errors: string[];
}

export const CATEGORY_LABEL: Record<string, string> = {
  question: 'Question',
  booking: 'Wants to book',
  medical_question: 'Medical question',
  praise: 'Praise',
  complaint: 'Complaint',
  emergency: 'Emergency',
  spam: 'Spam',
  other: 'Other',
};

/** Swap the booking placeholder for something that works on each platform. */
export function finishReply(platform: CommentPlatform, text: string): string {
  let out = cleanCaption(text);
  const link = bookingLink();
  const replacement = platform === 'facebook' ? link : link ? 'the WhatsApp link in our bio' : '';
  out = replacement ? out.replace(/\[BOOKING_LINK\]/g, replacement) : out.replace(/[:\s-]*\[BOOKING_LINK\]/g, '');
  return out.replace(/[ \t]{2,}/g, ' ').trim();
}

interface Draft {
  category: CommentCategory;
  needs_reply: boolean;
  reply: string;
}

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    category: { type: 'STRING', enum: [...COMMENT_CATEGORIES] },
    needs_reply: { type: 'BOOLEAN' },
    reply: { type: 'STRING' },
  },
  required: ['category', 'needs_reply', 'reply'],
};

function system(): string {
  const h = loadHospital().hospital;
  return `You reply to comments on the Facebook and Instagram posts of ${h.name}, ${h.location}, on behalf of the hospital.
Hospital facts: ${h.facts.join('; ')}.
Classify the comment, decide whether it needs a reply, and write the reply.

${COMMENT_RULES_TEXT}`;
}

function describe(c: Pick<CommentRow, 'platform' | 'postText' | 'author' | 'text'>): string {
  return `Platform: ${c.platform}
Our post: ${c.postText || '(no caption)'}
Commenter: ${c.author}
Comment: """${c.text.slice(0, 2000) || '(empty)'}"""`;
}

async function draftFor(c: CommentRow, feedback?: string): Promise<void> {
  const prompt = feedback
    ? `${describe(c)}\n\nCurrent draft reply:\n"""\n${c.reply}\n"""\nRewrite the reply following this feedback from hospital staff: ${feedback.trim().slice(0, 1000)}\nThe rules above still apply.`
    : describe(c);
  const d = await generateJson<Draft>(system(), prompt, SCHEMA);
  const reply = finishReply(c.platform, String(d.reply ?? ''));
  const category = (COMMENT_CATEGORIES as readonly string[]).includes(d.category) ? d.category : 'other';
  await updateComment(c.id, {
    reply,
    // Rewrites keep the original classification unless it was never set.
    category: feedback && c.category ? c.category : category,
    needsReply: feedback ? c.needsReply : category === 'emergency' || category === 'complaint' ? true : d.needs_reply !== false,
    warnings: reply ? replyWarnings(reply) : [],
  });
}

let running: Promise<CommentSyncSummary> | null = null;

/** Fetch new comments from Facebook and Instagram and draft replies. Nothing is posted here. */
export function syncComments(): Promise<CommentSyncSummary> {
  if (!running) running = doSync().finally(() => (running = null));
  return running;
}

async function doSync(): Promise<CommentSyncSummary> {
  if (!metaEnabled()) throw new Error('Facebook is not connected yet (META_* settings)');
  const s: CommentSyncSummary = { at: new Date().toISOString(), checked: [], newComments: 0, drafted: 0, repliedElsewhere: 0, errors: [] };
  const postsSince = new Date(Date.now() - config.commentPostMaxAgeDays * 86_400_000);
  const commentsSince = new Date(Date.now() - config.commentMaxAgeDays * 86_400_000);

  const sources: [string, () => Promise<FetchedComment[]>][] = [['Facebook', () => facebookComments(postsSince, commentsSince)]];
  if (instagramEnabled()) sources.push(['Instagram', () => instagramComments(postsSince, commentsSince)]);
  // Doctors' own Pages and Instagram accounts, read with each Page's own token.
  if (doctorPagesEnabled()) {
    try {
      const pages = await getDoctorPages();
      for (const d of loadHospital().doctors) {
        const acc = pages.byDoctor.get(d.slug);
        if (!acc || !acc.token) continue;
        sources.push([
          `Facebook (${d.name})`,
          () => facebookComments(postsSince, commentsSince, { id: acc.pageId, token: acc.token, account: acc.pageId, accountLabel: d.name }),
        ]);
        if (acc.igUserId) {
          const igUserId = acc.igUserId;
          sources.push([
            `Instagram (${d.name})`,
            () => instagramComments(postsSince, commentsSince, { id: igUserId, token: acc.token, account: igUserId, accountLabel: d.name }),
          ]);
        }
      }
    } catch (err) {
      s.errors.push(`Doctors' Pages: ${(err as Error).message}`);
    }
  }

  const alertWorthy: string[] = [];
  for (const [label, fetchAll] of sources) {
    let fetched: FetchedComment[];
    try {
      fetched = await fetchAll();
      s.checked.push(label);
    } catch (err) {
      s.errors.push(`${label}: ${(err as Error).message}`);
      continue;
    }
    for (const f of fetched) {
      const existing = await getCommentByRef(f.platform, f.commentId);
      if (!existing) {
        if (f.answeredByUs) continue;
        await insertComment({ ...f, commentedAt: f.createdAt });
        s.newComments++;
      } else if ((existing.status === 'draft' || existing.status === 'failed') && f.answeredByUs) {
        await updateComment(existing.id, { status: 'replied_elsewhere' });
        s.repliedElsewhere++;
      }
    }
  }

  const needDraft = (await listCommentRows({ status: ['draft'] })).filter((c) => !c.category);
  for (const c of needDraft.slice(0, config.commentDraftsPerSync)) {
    try {
      await draftFor(c);
      s.drafted++;
      const after = await getComment(c.id);
      if (after?.needsReply) alertWorthy.push(after.category);
    } catch (err) {
      s.errors.push(`Drafting reply to ${c.author}: ${(err as Error).message}`);
      break; // most likely Gemini quota; try again next sync
    }
  }

  await setKv('comments:lastSync', JSON.stringify(s));
  if (alertWorthy.length && config.publicBaseUrl) {
    const urgent = alertWorthy.filter((c) => c === 'emergency' || c === 'complaint').length;
    await sendAlert(
      `${alertWorthy.length} new Facebook/Instagram comment${alertWorthy.length === 1 ? '' : 's'} to reply to${urgent ? ` (${urgent} urgent)` : ''}`,
      `${config.publicBaseUrl}/comments`,
    );
  }
  return s;
}

/** The Page token to act with: the hospital's, or the doctor's Page the comment was made on. */
async function tokenFor(c: CommentRow): Promise<string> {
  if (!c.account) return config.metaPageAccessToken;
  const pages = await getDoctorPages();
  for (const acc of pages.byDoctor.values()) {
    if (acc.token && (acc.pageId === c.account || acc.igUserId === c.account)) return acc.token;
  }
  throw new Error(`${c.accountLabel || 'This doctor'}'s Page is no longer connected (check the Connections page)`);
}

async function mustBeOpen(id: number): Promise<CommentRow> {
  const c = await getComment(id);
  if (!c) throw new Error('Comment not found');
  if (c.status !== 'draft' && c.status !== 'failed') throw new Error(`This comment is already ${c.status.replace('_', ' ')}`);
  return c;
}

export async function draftCommentReply(id: number): Promise<void> {
  await draftFor(await mustBeOpen(id));
}

export async function reviseCommentReply(id: number, feedback: string): Promise<void> {
  const c = await mustBeOpen(id);
  await draftFor(c, c.reply ? feedback : undefined);
}

export async function saveCommentReply(id: number, text: string): Promise<void> {
  const c = await mustBeOpen(id);
  const reply = finishReply(c.platform, text.replace(/\r\n/g, '\n').slice(0, 2000));
  if (!reply) throw new Error('Reply cannot be empty');
  await updateComment(id, { reply, warnings: replyWarnings(reply) });
}

export async function skipComment(id: number): Promise<void> {
  if (!(await transitionComment(id, ['draft', 'failed'], 'skipped'))) throw new Error('This comment cannot be skipped now');
}

export async function postCommentReply(id: number): Promise<CommentRow> {
  const c = await mustBeOpen(id);
  if (!c.reply.trim()) throw new Error('Write or generate a reply first');
  if (!(await transitionComment(id, ['draft', 'failed'], 'posting'))) throw new Error('This reply is already being posted');
  try {
    await replyToComment(c.platform, c.commentId, c.reply, await tokenFor(c));
    await updateComment(id, { status: 'replied', error: '' });
  } catch (err) {
    await updateComment(id, { status: 'failed', error: (err as Error).message.slice(0, 500) });
  }
  return (await getComment(id))!;
}

export async function hideCommentById(id: number): Promise<void> {
  const c = await mustBeOpen(id);
  await hideComment(c.platform, c.commentId, await tokenFor(c));
  await updateComment(id, { status: 'hidden', error: '' });
}

/**
 * At startup: a reply left "posting" by a restart. Unlike Google, Meta would add a SECOND reply if it is
 * posted again, so it is marked failed with a warning to check the post first.
 */
export async function recoverInterruptedCommentReplies(): Promise<void> {
  for (const c of await listCommentRows({ status: ['posting'] })) {
    await updateComment(c.id, { status: 'failed', error: 'Interrupted by a server restart. Check the post first: the reply may already be there.' });
  }
}
