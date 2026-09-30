import cron from 'node-cron';
import { config, gbpEnabled, instagramEnabled, metaEnabled } from './config.ts';
import { initDb } from './db.ts';
import { createApp } from './web/app.ts';
import { createScheduledDraft, recoverInterruptedPublishes } from './workflow.ts';
import { recoverInterruptedReplies, syncReviews } from './reviews.ts';
import { generateWeeklyReport } from './insights.ts';
import { recoverInterruptedCommentReplies, syncComments } from './comments.ts';

// Fail fast with a message that names the setting to fix (these show up in the host's deploy log).
const missing = [
  !config.appPassword && 'APP_PASSWORD',
  config.sessionSecret.length < 32 && 'SESSION_SECRET (at least 32 characters)',
].filter(Boolean);
if (missing.length) {
  console.error(`[startup] Missing settings: ${missing.join(', ')}. Add them in the host's environment settings and redeploy.`);
  process.exit(1);
}

try {
  await initDb();
} catch (err) {
  const e = err as Error & { cause?: Error; code?: string };
  console.error(
    `[startup] Could not open the database at ${config.databaseUrl.replace(/\?.*$/, '')}: ${e.code ?? ''} ${e.message}${e.cause ? ` (${e.cause.message})` : ''}`.trim(),
  );
  console.error('[startup] Check DATABASE_URL and DATABASE_AUTH_TOKEN (a rotated or expired Turso token gives "401"/"Unauthorized").');
  process.exit(1);
}
await recoverInterruptedPublishes();
await recoverInterruptedReplies();
await recoverInterruptedCommentReplies();
const app = createApp();

app.listen(config.port, () => {
  console.log(`[server] approval page on port ${config.port}`);
  console.log(`[server] channels: facebook=${metaEnabled()} instagram=${instagramEnabled()} gbp=${gbpEnabled()}`);
  if (!config.publicBaseUrl) console.warn('[server] PUBLIC_BASE_URL is not set: publishing is disabled until it is');
});

if (config.draftCron.trim()) {
  cron.schedule(
    config.draftCron,
    () => {
      createScheduledDraft()
        .then((p) => p && console.log(`[schedule] draft #${p.id} created: ${p.title}`))
        .catch((err) => console.error('[schedule] draft failed:', err));
    },
    { timezone: config.timezone },
  );
  console.log(`[schedule] drafts on "${config.draftCron}" (${config.timezone})`);
}

if (config.reviewCron.trim() && gbpEnabled()) {
  cron.schedule(
    config.reviewCron,
    () => {
      syncReviews()
        .then((s) => console.log(`[reviews] ${s.profiles} profiles, ${s.newReviews} new, ${s.drafted} drafted, ${s.errors.length} errors`))
        .catch((err) => console.error('[reviews] sync failed:', err));
    },
    { timezone: config.timezone },
  );
  console.log(`[reviews] checking Google reviews on "${config.reviewCron}" (${config.timezone})`);
}

if (config.insightsCron.trim() && gbpEnabled()) {
  cron.schedule(
    config.insightsCron,
    () => {
      generateWeeklyReport({ alert: true })
        .then((r) => console.log(`[insights] weekly report #${r.id} for ${r.weekStart}`))
        .catch((err) => console.error('[insights] report failed:', err));
    },
    { timezone: config.timezone },
  );
  console.log(`[insights] weekly report on "${config.insightsCron}" (${config.timezone})`);
}

if (config.commentCron.trim() && metaEnabled()) {
  cron.schedule(
    config.commentCron,
    () => {
      syncComments()
        .then((s) => console.log(`[comments] ${s.newComments} new, ${s.drafted} drafted, ${s.errors.length} errors`))
        .catch((err) => console.error('[comments] sync failed:', err));
    },
    { timezone: config.timezone },
  );
  console.log(`[comments] checking Facebook/Instagram comments on "${config.commentCron}" (${config.timezone})`);
}
