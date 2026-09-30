import 'dotenv/config';

function str(name: string, fallback = ''): string {
  return (process.env[name] ?? fallback).trim();
}

function list(name: string): string[] {
  return str(name)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Read lazily so tests can change process.env between cases.
export const config = {
  get port() {
    return Number(str('PORT', '3000'));
  },
  /** Public https URL of this service, e.g. https://chetna-social.onrender.com. Instagram and Google fetch images from here. */
  get publicBaseUrl() {
    return str('PUBLIC_BASE_URL').replace(/\/+$/, '');
  },
  get timezone() {
    return str('TZ_NAME', 'Asia/Kolkata');
  },

  // Approval page
  get appPassword() {
    return str('APP_PASSWORD');
  },
  get sessionSecret() {
    return str('SESSION_SECRET');
  },
  /** Lets an external scheduler (e.g. cron-job.org) trigger the scheduled draft when the free host is asleep. */
  get cronSecret() {
    return str('CRON_SECRET');
  },
  /** Cron expression for automatic drafts. Default: Mon/Wed/Fri 10:00. Empty string disables. */
  get draftCron() {
    return process.env.DRAFT_CRON ?? '0 10 * * 1,3,5';
  },
  get maxPendingDrafts() {
    return Number(str('MAX_PENDING_DRAFTS', '2'));
  },

  // Database: a local file by default, or Turso (libsql://...) in production.
  get databaseUrl() {
    return str('DATABASE_URL', 'file:social.db');
  },
  get databaseAuthToken() {
    return str('DATABASE_AUTH_TOKEN');
  },

  // Gemini
  get geminiApiKey() {
    return str('GEMINI_API_KEY');
  },
  get geminiModel() {
    return str('GEMINI_MODEL', 'gemini-flash-lite-latest');
  },

  // Booking links placed in every post
  get bookingWhatsappNumber() {
    return str('BOOKING_WHATSAPP_NUMBER').replace(/\D/g, '');
  },
  get bookingPhoneDisplay() {
    return str('BOOKING_PHONE_DISPLAY');
  },

  // Meta (Facebook Page + Instagram)
  get metaPageId() {
    return str('META_PAGE_ID');
  },
  get metaPageAccessToken() {
    return str('META_PAGE_ACCESS_TOKEN');
  },
  get metaIgUserId() {
    return str('META_IG_USER_ID');
  },
  /**
   * Optional: the business portfolio's system-user token. With it, doctors' own Facebook Pages (and their linked
   * Instagram accounts) that the system user can manage are found automatically and receive their posts too.
   */
  get metaSystemUserToken() {
    return str('META_SYSTEM_USER_TOKEN');
  },
  get metaGraphVersion() {
    return str('META_GRAPH_VERSION', 'v23.0');
  },

  // Google Business Profile
  get gbpClientId() {
    return str('GBP_CLIENT_ID');
  },
  get gbpClientSecret() {
    return str('GBP_CLIENT_SECRET');
  },
  get gbpRefreshToken() {
    return str('GBP_REFRESH_TOKEN');
  },
  /** Optional: force which location is the hospital, e.g. "locations/123456". */
  get gbpHospitalLocation() {
    return str('GBP_HOSPITAL_LOCATION');
  },

  // Google review replies
  /** When to fetch new reviews. Default: every 3 hours from 08:15 to 20:15. Empty string disables. */
  get reviewCron() {
    return process.env.REVIEW_CRON ?? '15 8-20/3 * * *';
  },
  /** Only reviews newer than this are picked up (so the first sync doesn't pull years of old reviews). */
  get reviewMaxAgeDays() {
    return Number(str('REVIEW_MAX_AGE_DAYS', '60'));
  },
  /** Max Gemini drafts per sync; the rest are drafted on the next sync (free-tier friendly). */
  get reviewDraftsPerSync() {
    return Number(str('REVIEW_DRAFTS_PER_SYNC', '20'));
  },
  /** Sentence used when inviting an unhappy reviewer to get in touch, e.g. "Please call our front desk on 020-XXXXXXX." */
  get reviewContactLine() {
    return str('REVIEW_CONTACT_LINE');
  },

  // Facebook / Instagram comment replies
  /** When to fetch new comments. Default: every 2 hours from 08:45 to 20:45. Empty string disables. */
  get commentCron() {
    return process.env.COMMENT_CRON ?? '45 8-20/2 * * *';
  },
  /** Look for comments on posts published in the last N days. */
  get commentPostMaxAgeDays() {
    return Number(str('COMMENT_POST_MAX_AGE_DAYS', '30'));
  },
  /** Ignore comments older than N days (so the first sync doesn't dig up old threads). */
  get commentMaxAgeDays() {
    return Number(str('COMMENT_MAX_AGE_DAYS', '7'));
  },
  get commentDraftsPerSync() {
    return Number(str('COMMENT_DRAFTS_PER_SYNC', '25'));
  },

  // Weekly insights report
  /** When to build the weekly report. Default: Thursday 09:00 (Google's numbers lag a few days). Empty disables. */
  get insightsCron() {
    return process.env.INSIGHTS_CRON ?? '0 9 * * 4';
  },
  /** Google's performance numbers are complete only after a few days; the report covers the last Mon–Sun week ending at least this many days ago. */
  get insightsLagDays() {
    return Number(str('INSIGHTS_LAG_DAYS', '3'));
  },

  // Optional WhatsApp alert (send-only) via WATI when a draft is ready
  get watiApiEndpoint() {
    return str('WATI_API_ENDPOINT').replace(/\/+$/, '');
  },
  get watiApiToken() {
    return str('WATI_API_TOKEN');
  },
  get watiTemplateName() {
    return str('WATI_TEMPLATE', 'chetna_social_update');
  },
  get alertPhones() {
    return list('ALERT_PHONES').map((p) => p.replace(/\D/g, ''));
  },
};

export function metaEnabled(): boolean {
  return Boolean(config.metaPageId && config.metaPageAccessToken);
}

export function instagramEnabled(): boolean {
  return metaEnabled() && Boolean(config.metaIgUserId);
}

export function gbpEnabled(): boolean {
  return Boolean(config.gbpClientId && config.gbpClientSecret && config.gbpRefreshToken);
}

export function bookingLink(prefill?: string): string {
  if (!config.bookingWhatsappNumber) return '';
  const base = `https://wa.me/${config.bookingWhatsappNumber}`;
  return prefill ? `${base}?text=${encodeURIComponent(prefill)}` : base;
}
