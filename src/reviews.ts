import { config, gbpEnabled } from './config.ts';
import { reviseReviewReply, writeReviewReply, type ReviewForReply } from './captions.ts';
import { replyWarnings } from './compliance.ts';
import {
  getReview,
  getReviewByName,
  insertReview,
  listReviewRows,
  setKv,
  transitionReview,
  updateReview,
  type ReviewRow,
} from './db.ts';
import { sendAlert } from './notify.ts';
import { listLocations, listReviews, replyToReview } from './publishers/gbp.ts';

export interface SyncSummary {
  at: string;
  profiles: number;
  newReviews: number;
  drafted: number;
  repliedElsewhere: number;
  errors: string[];
}

const forReply = (r: ReviewRow): ReviewForReply => ({
  reviewer: r.reviewer,
  rating: r.rating,
  comment: r.comment,
  profileTitle: r.locationTitle,
});

let running: Promise<SyncSummary> | null = null;

/**
 * Fetch recent reviews from every Google profile, store the unanswered ones and have Gemini draft
 * replies. Nothing is posted here: every reply waits for a person on the approval page.
 */
export function syncReviews(): Promise<SyncSummary> {
  if (!running) running = doSync().finally(() => (running = null));
  return running;
}

async function doSync(): Promise<SyncSummary> {
  if (!gbpEnabled()) throw new Error('Google Business Profiles are not connected yet (GBP_* settings)');
  const summary: SyncSummary = { at: new Date().toISOString(), profiles: 0, newReviews: 0, drafted: 0, repliedElsewhere: 0, errors: [] };
  const since = new Date(Date.now() - config.reviewMaxAgeDays * 86_400_000);

  const locations = await listLocations();
  summary.profiles = locations.length;
  for (const loc of locations) {
    try {
      for (const rv of await listReviews(loc, since)) {
        const existing = await getReviewByName(rv.name);
        if (!existing) {
          if (rv.replyComment !== null) continue; // already answered on Google
          await insertReview({
            reviewName: rv.name,
            locationTitle: loc.title,
            reviewer: rv.reviewer,
            rating: rv.rating,
            comment: rv.comment,
            reviewUpdated: rv.updateTime,
          });
          summary.newReviews++;
          continue;
        }
        const changed = rv.comment !== existing.comment || rv.rating !== existing.rating;
        if ((existing.status === 'draft' || existing.status === 'failed') && rv.replyComment !== null) {
          // Someone answered it in the Google app meanwhile; don't post a second reply over it.
          await updateReview(existing.id, { status: 'replied_elsewhere' });
          summary.repliedElsewhere++;
        } else if (changed && ['draft', 'failed', 'replied', 'replied_elsewhere', 'skipped'].includes(existing.status)) {
          // The reviewer edited their review: the old reply may no longer fit, so draft a fresh one.
          await updateReview(existing.id, {
            rating: rv.rating,
            comment: rv.comment,
            reviewUpdated: rv.updateTime,
            reply: '',
            warnings: [],
            status: 'draft',
            error: existing.status === 'draft' || existing.status === 'failed' ? '' : 'The reviewer changed their review after it was answered.',
          });
          summary.newReviews++;
        }
      }
    } catch (err) {
      summary.errors.push(`${loc.title}: ${(err as Error).message}`);
    }
  }

  const needDraft = (await listReviewRows({ status: ['draft'] })).filter((r) => !r.reply);
  for (const r of needDraft.slice(0, config.reviewDraftsPerSync)) {
    try {
      await writeDraft(r);
      summary.drafted++;
    } catch (err) {
      summary.errors.push(`Drafting reply to ${r.reviewer}: ${(err as Error).message}`);
      break; // most likely Gemini quota; try again next sync
    }
  }

  await setKv('reviews:lastSync', JSON.stringify(summary));
  if (summary.newReviews > 0 && config.publicBaseUrl) {
    await sendAlert(`${summary.newReviews} new Google review${summary.newReviews === 1 ? '' : 's'} to reply to`, `${config.publicBaseUrl}/reviews`);
  }
  return summary;
}

async function writeDraft(r: ReviewRow): Promise<void> {
  const reply = await writeReviewReply(forReply(r));
  await updateReview(r.id, { reply, warnings: replyWarnings(reply) });
}

async function mustBeOpen(id: number): Promise<ReviewRow> {
  const r = await getReview(id);
  if (!r) throw new Error('Review not found');
  if (r.status !== 'draft' && r.status !== 'failed') throw new Error(`This review is already ${r.status.replace('_', ' ')}`);
  return r;
}

export async function draftReply(id: number): Promise<void> {
  await writeDraft(await mustBeOpen(id));
}

export async function saveReply(id: number, text: string): Promise<void> {
  await mustBeOpen(id);
  const reply = text.replace(/\r\n/g, '\n').trim().slice(0, 4000);
  if (!reply) throw new Error('Reply cannot be empty');
  await updateReview(id, { reply, warnings: replyWarnings(reply) });
}

export async function reviseReply(id: number, feedback: string): Promise<void> {
  const r = await mustBeOpen(id);
  const reply = r.reply ? await reviseReviewReply(forReply(r), r.reply, feedback) : await writeReviewReply(forReply(r));
  await updateReview(id, { reply, warnings: replyWarnings(reply) });
}

export async function skipReview(id: number): Promise<void> {
  if (!(await transitionReview(id, ['draft', 'failed'], 'skipped'))) throw new Error('This review cannot be skipped now');
}

/** Post the approved reply publicly on Google. */
export async function postReply(id: number): Promise<ReviewRow> {
  const r = await mustBeOpen(id);
  if (!r.reply.trim()) throw new Error('Write or generate a reply first');
  if (!(await transitionReview(id, ['draft', 'failed'], 'posting'))) throw new Error('This reply is already being posted');
  try {
    await replyToReview(r.reviewName, r.reply);
    await updateReview(id, { status: 'replied', error: '' });
  } catch (err) {
    await updateReview(id, { status: 'failed', error: (err as Error).message.slice(0, 500) });
  }
  return (await getReview(id))!;
}

/** At startup: a reply left "posting" by a restart can be retried (Google replaces a reply, never duplicates it). */
export async function recoverInterruptedReplies(): Promise<void> {
  for (const r of await listReviewRows({ status: ['posting'] })) {
    await updateReview(r.id, { status: 'failed', error: 'Interrupted by a server restart. Post it again.' });
  }
}
