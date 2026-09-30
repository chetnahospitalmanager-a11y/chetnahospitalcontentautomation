// Imported first by every test file. Blanks every real credential so a test can never post to the real
// Facebook page / Google profiles or write to the production database, even if a real .env exists.
// (dotenv never overrides a variable that is already set, even to an empty string.)
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BLANK = [
  'GEMINI_API_KEY',
  'META_PAGE_ID',
  'META_PAGE_ACCESS_TOKEN',
  'META_IG_USER_ID',
  'GBP_CLIENT_ID',
  'GBP_CLIENT_SECRET',
  'GBP_REFRESH_TOKEN',
  'GBP_HOSPITAL_LOCATION',
  'WATI_API_ENDPOINT',
  'WATI_API_TOKEN',
  'ALERT_PHONES',
  'DATABASE_AUTH_TOKEN',
  'PUBLIC_BASE_URL',
  'CRON_SECRET',
];
for (const k of BLANK) process.env[k] = '';

const dir = mkdtempSync(join(tmpdir(), 'chetna-social-test-'));
process.env.DATABASE_URL = `file:${join(dir, 'test.db')}`;
process.env.APP_PASSWORD = 'test-password';
process.env.SESSION_SECRET = 'x'.repeat(40);
process.env.DRAFT_CRON = '';
process.env.BOOKING_WHATSAPP_NUMBER = '910000000000';
process.env.BOOKING_PHONE_DISPLAY = '+91 00000 00000';
