import express, { type NextFunction, type Request, type Response } from 'express';
import { config, gbpEnabled, instagramEnabled, metaEnabled } from '../config.ts';
import { getComment, getKv, getPost, getReport, getReview, listCommentRows, listPosts, listReports, listReviewRows, type PostKind } from '../db.ts';
import { draftReply, postReply, reviseReply, saveReply, skipReview, syncReviews, type SyncSummary } from '../reviews.ts';
import { reviewsPage } from './reviewViews.ts';
import { insightsPage } from './insightViews.ts';
import { commentsPage } from './commentViews.ts';
import { connectionsPage, type ConnectionsInfo } from './connectionsView.ts';
import { doctorPagesEnabled, getDoctorPages } from '../publishers/metaPages.ts';
import { graph } from '../publishers/meta.ts';
import { getMatch, listLocations } from '../publishers/gbp.ts';
import { loadHospital } from '../hospital.ts';
import {
  draftCommentReply,
  hideCommentById,
  postCommentReply,
  reviseCommentReply,
  saveCommentReply,
  skipComment,
  syncComments,
  type CommentSyncSummary,
} from '../comments.ts';
import { generateWeeklyReport, reportCsv, type WeeklyReport } from '../insights.ts';
import { renderPostImage } from '../images.ts';
import { nextTopic, topicFor } from '../topics.ts';
import { approveAndPublish, createDraft, createScheduledDraft, describeTargets, requestChanges, saveCaption, skip } from '../workflow.ts';
import {
  checkPassword,
  csrfToken,
  endSession,
  loginAllowed,
  recordLoginFailure,
  requireCsrf,
  requireLogin,
  requireSameOrigin,
  secretMatches,
  startSession,
} from './auth.ts';
import { dashboardPage, loginPage, postPage } from './views.ts';

const FLASH: Record<string, string> = {
  created: 'Draft written. Review it below.',
  saved: 'Caption saved.',
  revised: 'Gemini rewrote the caption. Check it again.',
  skipped: 'Post skipped.',
  published: 'Posted everywhere.',
  partial: 'Posted to some channels. See the results for what failed.',
  failed: 'Posting failed. See the results below.',
  replied: 'Reply posted on Google.',
  reply_failed: 'Google did not accept the reply. See the error on the review.',
  reply_saved: 'Reply saved.',
  reply_revised: 'Gemini rewrote the reply. Check it again.',
  reply_drafted: 'Reply drafted. Check it before posting.',
  review_skipped: 'Marked as not needing a reply.',
  synced: 'Checked Google for new reviews.',
  report_built: 'Report built.',
  comment_replied: 'Reply posted.',
  comment_reply_failed: 'Meta did not accept the reply. See the error on the comment.',
  comment_saved: 'Reply saved.',
  comment_revised: 'Gemini rewrote the reply. Check it again.',
  comment_drafted: 'Reply drafted. Check it before posting.',
  comment_skipped: 'Marked as not needing a reply.',
  comment_hidden: 'Comment hidden.',
  comments_synced: 'Checked Facebook and Instagram for new comments.',
};

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

function postId(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw Object.assign(new Error('Post not found'), { status: 404 });
  return id;
}

async function renderPost(req: Request, res: Response, id: number, extra: { error?: string; status?: number } = {}) {
  const post = await getPost(id);
  if (!post) {
    res.status(404).send('Post not found');
    return;
  }
  const { channels, notes } = post.status === 'draft' ? await describeTargets(post) : { channels: [], notes: [] };
  res
    .status(extra.status ?? 200)
    .send(postPage({ post, channels, notes, csrf: csrfToken(req), flash: FLASH[String(req.query.ok ?? '')], error: extra.error }));
}

export function createApp() {
  if (!config.appPassword || !config.sessionSecret || config.sessionSecret.length < 32) {
    throw new Error('Set APP_PASSWORD and a SESSION_SECRET of at least 32 characters');
  }
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use((_req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });
  app.use(express.urlencoded({ extended: false, limit: '20kb' }));

  // Public: health check, and images (Instagram and Google must fetch them without logging in).
  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });
  app.get(
    '/image/:id.jpg',
    wrap(async (req, res) => {
      const post = await getPost(postId(req));
      if (!post) {
        res.status(404).end();
        return;
      }
      const jpg = await renderPostImage(post.imageKey, post.title);
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.send(jpg);
    }),
  );

  // For an external scheduler when the free host sleeps: POST with header "x-cron-secret".
  app.post(
    '/cron/draft',
    wrap(async (req, res) => {
      if (!secretMatches(req.header('x-cron-secret'), config.cronSecret)) {
        res.status(403).json({ ok: false });
        return;
      }
      const post = await createScheduledDraft();
      res.json({ ok: true, created: post ? post.id : null });
    }),
  );

  app.post(
    '/cron/reviews',
    wrap(async (req, res) => {
      if (!secretMatches(req.header('x-cron-secret'), config.cronSecret)) {
        res.status(403).json({ ok: false });
        return;
      }
      res.json({ ok: true, summary: await syncReviews() });
    }),
  );

  app.post(
    '/cron/insights',
    wrap(async (req, res) => {
      if (!secretMatches(req.header('x-cron-secret'), config.cronSecret)) {
        res.status(403).json({ ok: false });
        return;
      }
      const r = await generateWeeklyReport({ alert: true });
      res.json({ ok: true, report: r.id, week: r.weekStart });
    }),
  );

  app.post(
    '/cron/comments',
    wrap(async (req, res) => {
      if (!secretMatches(req.header('x-cron-secret'), config.cronSecret)) {
        res.status(403).json({ ok: false });
        return;
      }
      res.json({ ok: true, summary: await syncComments() });
    }),
  );

  app.get('/login', (_req, res) => {
    res.send(loginPage());
  });
  app.post('/login', requireSameOrigin, (req, res) => {
    const ip = req.ip ?? 'unknown';
    if (!loginAllowed(ip)) {
      res.status(429).send(loginPage('Too many attempts. Try again in 15 minutes.'));
      return;
    }
    if (!checkPassword(String(req.body?.password ?? ''))) {
      recordLoginFailure(ip);
      res.status(401).send(loginPage('Wrong password.'));
      return;
    }
    startSession(req, res);
    res.redirect(303, '/');
  });

  // Everything below needs a login; every POST must come from this site and carry the CSRF token.
  app.use(requireLogin, requireSameOrigin);
  // The header's logout button has no token field; the same-origin check is enough for a logout.
  app.post('/logout', (_req, res) => {
    endSession(res);
    res.redirect(303, '/login');
  });

  app.get(
    '/',
    wrap(async (req, res) => {
      const [drafts, recent] = await Promise.all([listPosts({ status: ['draft'] }), listPosts({ limit: 30 })]);
      res.send(
        dashboardPage({
          drafts,
          recent: recent.filter((p) => p.status !== 'draft'),
          csrf: csrfToken(req),
          flash: FLASH[String(req.query.ok ?? '')],
        }),
      );
    }),
  );

  app.post(
    '/posts',
    requireCsrf,
    wrap(async (req, res) => {
      const choice = String(req.body.topic ?? 'next');
      const custom = String(req.body.custom ?? '').trim();
      let topic;
      if (choice === 'custom' || (choice === 'next' && custom)) {
        if (!custom) throw Object.assign(new Error('Type a custom topic first'), { status: 400 });
        topic = topicFor('custom', custom);
      } else if (choice === 'next') {
        topic = await nextTopic();
      } else {
        const [kind, subject] = choice.split(':');
        topic = topicFor(kind as PostKind, subject ?? '');
      }
      if (!topic) throw Object.assign(new Error('Unknown topic'), { status: 400 });
      const post = await createDraft(topic);
      res.redirect(303, `/posts/${post.id}?ok=created`);
    }),
  );

  app.get(
    '/posts/:id',
    wrap(async (req, res) => {
      await renderPost(req, res, postId(req));
    }),
  );

  const action = (fn: (req: Request, id: number) => Promise<string>) =>
    wrap(async (req, res) => {
      const id = postId(req);
      try {
        const ok = await fn(req, id);
        res.redirect(303, ok === 'skipped' ? '/?ok=skipped' : `/posts/${id}?ok=${ok}`);
      } catch (err) {
        await renderPost(req, res, id, { error: (err as Error).message, status: 400 });
      }
    });

  app.post(
    '/posts/:id/caption',
    requireCsrf,
    action(async (req, id) => {
      await saveCaption(id, String(req.body.caption ?? ''));
      return 'saved';
    }),
  );
  app.post(
    '/posts/:id/revise',
    requireCsrf,
    action(async (req, id) => {
      const feedback = String(req.body.feedback ?? '').trim();
      if (!feedback) throw new Error('Write what should change');
      await requestChanges(id, feedback);
      return 'revised';
    }),
  );
  app.post(
    '/posts/:id/skip',
    requireCsrf,
    action(async (_req, id) => {
      await skip(id);
      return 'skipped';
    }),
  );
  app.post(
    '/posts/:id/publish',
    requireCsrf,
    action(async (req, id) => {
      const post = await getPost(id);
      if (post?.status === 'draft' && post.warnings.length && req.body.confirm !== 'yes') {
        throw new Error('Tick "I have checked the wording" first');
      }
      return (await approveAndPublish(id)).status;
    }),
  );

  // ---------------------------------------------------------------- Google review replies

  async function renderReviews(req: Request, res: Response, extra: { error?: string; status?: number } = {}) {
    const [open, recent, last] = await Promise.all([
      listReviewRows({ status: ['draft', 'failed'] }),
      listReviewRows({ status: ['replied', 'replied_elsewhere', 'skipped'], limit: 30 }),
      getKv('reviews:lastSync'),
    ]);
    recent.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    res.status(extra.status ?? 200).send(
      reviewsPage({
        open,
        recent,
        lastSync: last ? (JSON.parse(last) as SyncSummary) : null,
        gbpConnected: gbpEnabled(),
        csrf: csrfToken(req),
        flash: FLASH[String(req.query.ok ?? '')],
        error: extra.error,
      }),
    );
  }

  app.get(
    '/reviews',
    wrap(async (req, res) => {
      await renderReviews(req, res);
    }),
  );

  app.post(
    '/reviews/sync',
    requireCsrf,
    wrap(async (req, res) => {
      try {
        await syncReviews();
        res.redirect(303, '/reviews?ok=synced');
      } catch (err) {
        await renderReviews(req, res, { error: (err as Error).message, status: 400 });
      }
    }),
  );

  const reviewAction = (fn: (req: Request, id: number) => Promise<string>) =>
    wrap(async (req, res) => {
      const id = postId(req);
      try {
        const ok = await fn(req, id);
        res.redirect(303, `/reviews?ok=${ok}#r${id}`);
      } catch (err) {
        await renderReviews(req, res, { error: (err as Error).message, status: 400 });
      }
    });

  app.post(
    '/reviews/:id/draft',
    requireCsrf,
    reviewAction(async (_req, id) => {
      await draftReply(id);
      return 'reply_drafted';
    }),
  );
  app.post(
    '/reviews/:id/save',
    requireCsrf,
    reviewAction(async (req, id) => {
      await saveReply(id, String(req.body.reply ?? ''));
      return 'reply_saved';
    }),
  );
  app.post(
    '/reviews/:id/revise',
    requireCsrf,
    reviewAction(async (req, id) => {
      const feedback = String(req.body.feedback ?? '').trim();
      if (!feedback) throw new Error('Write what should change');
      await reviseReply(id, feedback);
      return 'reply_revised';
    }),
  );
  app.post(
    '/reviews/:id/skip',
    requireCsrf,
    reviewAction(async (_req, id) => {
      await skipReview(id);
      return 'review_skipped';
    }),
  );
  app.post(
    '/reviews/:id/post',
    requireCsrf,
    reviewAction(async (req, id) => {
      const r = await getReview(id);
      if (r?.warnings.length && req.body.confirm !== 'yes') throw new Error('Tick "I have checked the wording" first');
      const after = await postReply(id);
      return after.status === 'replied' ? 'replied' : 'reply_failed';
    }),
  );

  // ---------------------------------------------------------------- Connected accounts (read-only check)

  app.get(
    '/connections',
    wrap(async (_req, res) => {
      const info: ConnectionsInfo = {
        hospital: { facebook: null, instagram: null },
        doctors: [],
        doctorPagesEnabled: doctorPagesEnabled(),
        problems: [],
        google: { connected: gbpEnabled(), profileCount: 0, hospital: null, doctors: [], problems: [] },
      };
      if (info.google.connected) {
        try {
          const [locations, match] = [await listLocations(), await getMatch(true)];
          info.google.profileCount = locations.length;
          info.google.hospital = match.hospital ? match.hospital.title : null;
          for (const d of loadHospital().doctors) {
            const loc = match.byDoctor.get(d.slug);
            if (loc) info.google.doctors.push({ doctor: d.name, profile: loc.title });
          }
          info.google.problems = match.problems;
        } catch (err) {
          info.google.error = `Could not read Google Business Profiles: ${(err as Error).message}`;
        }
      }
      if (metaEnabled()) {
        try {
          const p = (await graph(config.metaPageId, { fields: 'name,instagram_business_account{username}' }, 'GET')) as {
            name?: string;
            instagram_business_account?: { id: string; username?: string };
          };
          info.hospital.facebook = `${p.name ?? config.metaPageId} (${config.metaPageId})`;
          if (instagramEnabled()) {
            const linked = p.instagram_business_account;
            info.hospital.instagram = linked?.id === config.metaIgUserId ? `@${linked.username ?? linked.id}` : `account ${config.metaIgUserId}`;
            if (linked && linked.id !== config.metaIgUserId) info.problems.push('META_IG_USER_ID is not the Instagram account linked to the hospital Page');
          }
        } catch (err) {
          info.hospital.error = `Could not read the hospital Page: ${(err as Error).message}`;
        }
      } else {
        info.hospital.error = 'Facebook is not connected (META_PAGE_ID / META_PAGE_ACCESS_TOKEN).';
      }
      if (info.doctorPagesEnabled) {
        try {
          const pages = await getDoctorPages(true);
          for (const d of loadHospital().doctors) {
            const acc = pages.byDoctor.get(d.slug);
            if (acc) info.doctors.push({ doctor: d.name, facebook: acc.pageName, instagram: acc.igUsername ? `@${acc.igUsername}` : acc.igUserId });
          }
          info.problems.push(...pages.problems);
        } catch (err) {
          info.problems.push(`Could not list the system user's Pages: ${(err as Error).message}`);
        }
      }
      res.send(connectionsPage(info));
    }),
  );

  // ---------------------------------------------------------------- Facebook / Instagram comments

  async function renderComments(req: Request, res: Response, extra: { error?: string; status?: number } = {}) {
    const [open, recent, last] = await Promise.all([
      listCommentRows({ status: ['draft', 'failed'] }),
      listCommentRows({ status: ['replied', 'replied_elsewhere', 'skipped', 'hidden'], limit: 30 }),
      getKv('comments:lastSync'),
    ]);
    recent.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    res.status(extra.status ?? 200).send(
      commentsPage({
        open,
        recent,
        lastSync: last ? (JSON.parse(last) as CommentSyncSummary) : null,
        metaConnected: metaEnabled(),
        csrf: csrfToken(req),
        flash: FLASH[String(req.query.ok ?? '')],
        error: extra.error,
      }),
    );
  }

  app.get(
    '/comments',
    wrap(async (req, res) => {
      await renderComments(req, res);
    }),
  );
  app.post(
    '/comments/sync',
    requireCsrf,
    wrap(async (req, res) => {
      try {
        await syncComments();
        res.redirect(303, '/comments?ok=comments_synced');
      } catch (err) {
        await renderComments(req, res, { error: (err as Error).message, status: 400 });
      }
    }),
  );

  const commentAction = (fn: (req: Request, id: number) => Promise<string>) =>
    wrap(async (req, res) => {
      const id = postId(req);
      try {
        const ok = await fn(req, id);
        res.redirect(303, `/comments?ok=${ok}#c${id}`);
      } catch (err) {
        await renderComments(req, res, { error: (err as Error).message, status: 400 });
      }
    });

  app.post(
    '/comments/:id/draft',
    requireCsrf,
    commentAction(async (_req, id) => {
      await draftCommentReply(id);
      return 'comment_drafted';
    }),
  );
  app.post(
    '/comments/:id/save',
    requireCsrf,
    commentAction(async (req, id) => {
      await saveCommentReply(id, String(req.body.reply ?? ''));
      return 'comment_saved';
    }),
  );
  app.post(
    '/comments/:id/revise',
    requireCsrf,
    commentAction(async (req, id) => {
      const feedback = String(req.body.feedback ?? '').trim();
      if (!feedback) throw new Error('Write what should change');
      await reviseCommentReply(id, feedback);
      return 'comment_revised';
    }),
  );
  app.post(
    '/comments/:id/skip',
    requireCsrf,
    commentAction(async (_req, id) => {
      await skipComment(id);
      return 'comment_skipped';
    }),
  );
  app.post(
    '/comments/:id/hide',
    requireCsrf,
    commentAction(async (_req, id) => {
      await hideCommentById(id);
      return 'comment_hidden';
    }),
  );
  app.post(
    '/comments/:id/post',
    requireCsrf,
    commentAction(async (req, id) => {
      const c = await getComment(id);
      if (c?.warnings.length && req.body.confirm !== 'yes') throw new Error('Tick "I have checked the wording" first');
      const after = await postCommentReply(id);
      return after.status === 'replied' ? 'comment_replied' : 'comment_reply_failed';
    }),
  );

  // ---------------------------------------------------------------- Weekly insights

  async function renderInsights(req: Request, res: Response, id: number | null, extra: { error?: string; status?: number } = {}) {
    const history = await listReports<WeeklyReport>();
    const report = id === null ? (history[0] ?? null) : await getReport<WeeklyReport>(id);
    if (id !== null && !report) {
      res.status(404).send('Report not found');
      return;
    }
    res.status(extra.status ?? 200).send(
      insightsPage({ report, history, gbpConnected: gbpEnabled(), metaConnected: metaEnabled(), csrf: csrfToken(req), flash: FLASH[String(req.query.ok ?? '')], error: extra.error }),
    );
  }

  app.get(
    '/insights',
    wrap(async (req, res) => {
      await renderInsights(req, res, null);
    }),
  );
  app.get(
    '/insights/:id.csv',
    wrap(async (req, res) => {
      const report = await getReport<WeeklyReport>(postId(req));
      if (!report) {
        res.status(404).send('Report not found');
        return;
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="chetna-google-insights-${report.weekStart}.csv"`);
      res.send(`\uFEFF${reportCsv(report.data)}`); // BOM so Excel reads UTF-8
    }),
  );
  app.get(
    '/insights/:id',
    wrap(async (req, res) => {
      await renderInsights(req, res, postId(req));
    }),
  );
  app.post(
    '/insights/generate',
    requireCsrf,
    wrap(async (req, res) => {
      try {
        const r = await generateWeeklyReport();
        res.redirect(303, `/insights/${r.id}?ok=report_built`);
      } catch (err) {
        await renderInsights(req, res, null, { error: (err as Error).message, status: 400 });
      }
    }),
  );

  app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status ?? 500;
    if (status >= 500) console.error('[web]', err);
    res.status(status).send(status >= 500 ? 'Something went wrong. Check the server logs.' : err.message);
  });

  return app;
}
