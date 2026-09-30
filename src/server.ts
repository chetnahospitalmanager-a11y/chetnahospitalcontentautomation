import cron from 'node-cron';
import { config, gbpEnabled, instagramEnabled, metaEnabled } from './config.ts';
import { initDb } from './db.ts';
import { createApp } from './web/app.ts';
import { createScheduledDraft, recoverInterruptedPublishes } from './workflow.ts';

await initDb();
await recoverInterruptedPublishes();
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
