import { bookingLink, config, gbpEnabled, instagramEnabled, metaEnabled } from './config.ts';
import { gbpSummary, reviseCaption, socialCaption, writeCaption } from './captions.ts';
import { complianceWarnings } from './compliance.ts';
import { getPost, insertPost, listPosts, transitionPost, updatePost, type Post, type PublishResult } from './db.ts';
import { doctorsInDepartment, findDoctor } from './hospital.ts';
import { alertDraftReady } from './notify.ts';
import { postToFacebook, postToInstagram } from './publishers/meta.ts';
import { createLocalPost, getMatch } from './publishers/gbp.ts';
import type { GbpLocation } from './gbpMatch.ts';
import { nextTopic, topicFor, type Topic } from './topics.ts';

export interface Target {
  channel: string;
  run: (imageUrl: string) => Promise<string>;
}

export function imageUrlFor(post: Post): string {
  // The version parameter stops Instagram/Google from reusing a cached older image.
  return `${config.publicBaseUrl}/image/${post.id}.jpg?v=${encodeURIComponent(post.imageKey)}`;
}

export async function createDraft(topic: Topic): Promise<Post> {
  const caption = await writeCaption(topic);
  const post = await insertPost({
    kind: topic.kind,
    subject: topic.subject,
    title: topic.title,
    caption,
    imageKey: topic.imageKey,
    warnings: complianceWarnings(caption),
  });
  if (config.publicBaseUrl) await alertDraftReady(post.title, `${config.publicBaseUrl}/posts/${post.id}`);
  return post;
}

/** Called by the scheduler. Does nothing if drafts are already piling up unreviewed. */
export async function createScheduledDraft(): Promise<Post | null> {
  const pending = await listPosts({ status: ['draft'] });
  if (pending.length >= config.maxPendingDrafts) {
    console.log(`[schedule] ${pending.length} drafts already waiting; not creating another`);
    return null;
  }
  return createDraft(await nextTopic());
}

function topicOf(post: Post): Topic {
  return topicFor(post.kind, post.subject) ?? { kind: post.kind, subject: post.subject, title: post.title, facts: [post.title], imageKey: post.imageKey };
}

export async function requestChanges(id: number, feedback: string): Promise<Post> {
  const post = await mustBeDraft(id);
  const caption = await reviseCaption(topicOf(post), post.caption, feedback);
  await updatePost(id, { caption, warnings: complianceWarnings(caption) });
  return (await getPost(id))!;
}

export async function saveCaption(id: number, caption: string): Promise<void> {
  await mustBeDraft(id);
  const clean = caption.replace(/\r\n/g, '\n').trim().slice(0, 2000);
  if (!clean) throw new Error('Caption cannot be empty');
  await updatePost(id, { caption: clean, warnings: complianceWarnings(clean) });
}

export async function skip(id: number): Promise<void> {
  if (!(await transitionPost(id, ['draft'], 'skipped'))) throw new Error('Only drafts can be skipped');
}

async function mustBeDraft(id: number): Promise<Post> {
  const post = await getPost(id);
  if (!post) throw new Error('Post not found');
  if (post.status !== 'draft') throw new Error(`Post is ${post.status}, not a draft`);
  return post;
}

/** Google profiles a post goes to: always the hospital, plus the doctors it is about. */
export async function gbpLocationsFor(post: Pick<Post, 'kind' | 'subject'>): Promise<{ loc: GbpLocation; doctorName?: string }[]> {
  const match = await getMatch();
  const out: { loc: GbpLocation; doctorName?: string }[] = [];
  if (match.hospital) out.push({ loc: match.hospital });
  const doctors =
    post.kind === 'doctor' ? [findDoctor(post.subject)].filter((d) => d !== undefined) : post.kind === 'department' ? doctorsInDepartment(post.subject) : [];
  for (const d of doctors) {
    const loc = match.byDoctor.get(d.slug);
    if (loc) out.push({ loc, doctorName: d.name });
  }
  return out;
}

export async function planTargets(post: Post): Promise<Target[]> {
  const targets: Target[] = [];
  const social = socialCaption(post.caption);
  if (metaEnabled()) targets.push({ channel: 'facebook', run: (img) => postToFacebook(img, social) });
  if (instagramEnabled()) targets.push({ channel: 'instagram', run: (img) => postToInstagram(img, social) });
  if (gbpEnabled()) {
    const summary = gbpSummary(post.caption);
    for (const { loc, doctorName } of await gbpLocationsFor(post)) {
      const book = bookingLink(doctorName ? `Hi, I would like to book an appointment with ${doctorName}` : 'Hi, I would like to book an appointment');
      targets.push({ channel: `gbp:${loc.title}`, run: (img) => createLocalPost(loc, summary, img, book) });
    }
  }
  return targets;
}

/** Channel names only, for the approval page. Never throws. */
export async function describeTargets(post: Post): Promise<{ channels: string[]; notes: string[] }> {
  const notes: string[] = [];
  if (!metaEnabled()) notes.push('Facebook not connected (META_PAGE_ID / META_PAGE_ACCESS_TOKEN)');
  else if (!instagramEnabled()) notes.push('Instagram not connected (META_IG_USER_ID)');
  if (!gbpEnabled()) notes.push('Google Business Profiles not connected yet (GBP_* settings)');
  try {
    const channels = (await planTargets(post)).map((t) => t.channel);
    return { channels, notes };
  } catch (err) {
    notes.push(`Could not load Google profiles: ${(err as Error).message}`);
    return { channels: [], notes };
  }
}

/** At startup: a post left in "publishing" by a restart becomes partial/failed so it can be retried. */
export async function recoverInterruptedPublishes(): Promise<void> {
  for (const p of await listPosts({ status: ['publishing'] })) {
    const status = p.results.some((r) => r.ok) ? 'partial' : 'failed';
    const results = [...p.results, { channel: 'setup', ok: false, error: 'Interrupted by a server restart; use Retry' }];
    await updatePost(p.id, { status, results });
  }
}

/**
 * Publish an approved draft everywhere it belongs. Retrying a partial/failed post only re-sends to the
 * channels that failed, so nothing is posted twice.
 */
export async function approveAndPublish(id: number): Promise<Post> {
  if (!config.publicBaseUrl.startsWith('https://')) throw new Error('PUBLIC_BASE_URL must be the public https address of this service');
  if (!metaEnabled() && !gbpEnabled()) throw new Error('No channels are connected yet (Facebook/Instagram or Google)');
  const before = await getPost(id);
  if (!before) throw new Error('Post not found');
  if (!(await transitionPost(id, ['draft', 'partial', 'failed'], 'publishing'))) {
    throw new Error(`Post is ${before.status}; it cannot be published now`);
  }
  const done = new Set(before.results.filter((r) => r.ok).map((r) => r.channel));
  const results: PublishResult[] = before.results.filter((r) => r.ok);
  try {
    const targets = (await planTargets(before)).filter((t) => !done.has(t.channel));
    if (targets.length === 0 && results.length === 0) throw new Error('No channels are connected yet');
    const img = imageUrlFor(before);
    for (const t of targets) {
      try {
        results.push({ channel: t.channel, ok: true, id: await t.run(img) });
      } catch (err) {
        results.push({ channel: t.channel, ok: false, error: (err as Error).message.slice(0, 500) });
      }
      // Saved after every channel so a crash mid-way never leads to posting the same thing twice.
      await updatePost(id, { results });
    }
  } catch (err) {
    results.push({ channel: 'setup', ok: false, error: (err as Error).message.slice(0, 500) });
  }
  const okCount = results.filter((r) => r.ok).length;
  const status = okCount === results.length ? 'published' : okCount > 0 ? 'partial' : 'failed';
  await updatePost(id, { status, results });
  return (await getPost(id))!;
}
