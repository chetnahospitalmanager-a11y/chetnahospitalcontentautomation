# Chetna Hospital: social media & Google Business Profile automation

A small standalone service, separate from the WhatsApp booking bot, with four jobs:
**posting** (below), **answering Google reviews** (see [Google review replies](#google-review-replies)),
**answering Facebook & Instagram comments** (see [Comment replies](#facebook--instagram-comment-replies))
and a **weekly insights report** for Google, Facebook and Instagram (see [Weekly insights report](#weekly-insights-report)).

For posting, it:

1. **Writes a draft post** every Mon/Wed/Fri at 10:00 IST with Gemini, rotating
   doctor spotlight → department → doctor → department → hospital-wide topic.
2. **Waits for a person to approve it** on a private, password-protected web page, where staff can
   edit the caption, ask Gemini for changes, or skip the post.
3. **Publishes the approved post** to the Facebook Page, Instagram, and the right
   Google Business Profiles in one step:

| Post type | Google profiles it goes to |
|---|---|
| Doctor spotlight | Hospital + that doctor's profile |
| Department | Hospital + profiles of the doctors in that department |
| Hospital-wide / custom topic | Hospital only |

Nothing is ever posted without a person clicking **Approve & post**. This is on purpose: NMC rules on
medical advertising in India forbid superlatives ("best", "No. 1"), promised results ("cure",
"guaranteed"), testimonials and inducements. Gemini is told these rules, and the approval page also
flags risky wording and asks for an explicit "I have checked the wording" before posting it.

## How it works

```
cron (Mon/Wed/Fri 10:00 IST) or "New post" button
  → next topic from data/hospital.json
  → Gemini writes the caption (only from the facts in data/hospital.json)
  → draft on the approval page (+ optional WhatsApp alert)
  → staff: edit / request changes / skip / Approve & post
  → Facebook photo post, Instagram post, Google posts with a BOOK button to WhatsApp
  → results shown per channel; "Retry" re-sends only the channels that failed
```

- **Facebook/Instagram caption** = the approved text + WhatsApp booking link + phone + hashtags.
- **Google post** = the approved text with phone numbers, links and hashtags removed (Google rejects
  phone numbers) and a **Book** button that opens WhatsApp. On a doctor's profile the WhatsApp message
  is pre-filled with that doctor's name.
- **Images** are served at `/image/<post id>.jpg` as 1080x1350 JPEG (what Instagram needs). Real
  photos go in `social-images/` (see its README). Without a photo, a branded text card is generated.
- **Matching Google profiles to doctors** uses first name + surname, so "Dr. Aishwarya Pethe" still
  matches "Dr. Aishwarya Patil Pethe" and the several Dr. Patils aren't mixed up. Anything
  ambiguous is skipped rather than guessed. Check with `npm run gbp:locations`.

## Google review replies

Replying to reviews consistently helps local ranking more than posting does. Every 3 hours (08:15-20:15
IST) the service checks **all** Google profiles the account can see (including any not matched to a
doctor) for new reviews, has Gemini draft a reply, and lists them on the **Reviews** page, lowest
ratings first. Staff edit the reply, ask for changes, post it, or mark it "Don't reply". **Nothing is
posted automatically.**

- **Confidentiality:** replies are public, so drafts never confirm that the reviewer was a patient or
  mention any condition, treatment, bill or visit detail, even if the reviewer did. The page flags
  wording like "your surgery" or "our records show", plus the same NMC wording rules as posts, and asks
  for "I have checked the wording" before posting such a reply.
- **Complaints (1-3 stars):** the draft thanks them, apologises, says the feedback is being looked into and
  invites them to contact the hospital. Set `REVIEW_CONTACT_LINE` to control exactly how that is phrased
  (e.g. the front-desk number). 1-2 star reviews are highlighted in red.
- **Only new, unanswered reviews** are picked up (last `REVIEW_MAX_AGE_DAYS`, default 60). Reviews
  already answered on Google are ignored.
- **Answered in the Google app meanwhile?** The next check marks it "Answered in the Google app" and it
  can no longer be posted from here, so it never gets two replies.
- **Reviewer edited their review?** It comes back to the Reviews page with a fresh draft and a note,
  even if it had already been answered.
- If Google rejects a reply, it shows the error and can be posted again (Google replaces a reply; it
  never duplicates it).
- Optional WhatsApp alert: "N new Google reviews to reply to", using the same WATI template as posts.

It needs the same Google setup as posting (step 3 below); nothing extra. On Render's free plan, also
add a cron-job.org job for `POST /cron/reviews` (see step 4).

## Facebook & Instagram comment replies

Every 2 hours (08:45-20:45 IST) the service reads new top-level comments on the Page's and Instagram
account's posts from the last 30 days, and Gemini sorts each one (question, wants to book, medical
question, praise, complaint, emergency, spam, other) and drafts a short reply. They appear on the
**Comments** page. Staff edit, ask for changes, post, mark "Don't reply", or **hide** spam/abuse.
**Nothing is posted automatically.**

- **Order:** possible emergencies first (highlighted in red), then complaints, then the oldest.
  Comments that need no reply (tagging a friend, a lone emoji, spam) sit in a collapsed section.
- **Replies never give medical advice** (no diagnosis, medicines or doses) and never confirm someone
  was a patient. Health questions are invited to book a consultation; emergency-sounding comments are
  told to come to the 24x7 emergency department. Replies are written in the comment's language
  (English, Hindi or Marathi). The same wording checks as reviews apply, and a flagged reply needs
  "I have checked the wording" before it can be posted.
- **Booking link:** on Facebook the WhatsApp booking link is added where it helps; on Instagram (where
  links in comments aren't clickable) the reply points to "the WhatsApp link in our bio" instead.
- **Answered from the Meta apps meanwhile?** The next check marks it "Answered elsewhere", so it
  never gets a second reply. Our own comments and comments older than 7 days are ignored.
- **Hide comment** hides it from everyone except the commenter (and their friends, on Facebook);
  it can be un-hidden in the Meta apps.
- Optional WhatsApp alert: "N new comments to reply to (M urgent)".

**This is not an emergency channel.** Comments are checked every 2 hours and wait for a person, so
the Page should also say that emergencies must call the hospital or come in directly.

It uses the same Page token as posting, with extra permissions (step 2 below). On Render's free plan,
add a cron-job.org job for `POST /cron/comments` (step 4).

## Weekly insights report

Every Thursday at 09:00 IST the service builds a report for the previous Monday–Sunday week (Google's
numbers take a few days to settle, hence Thursday) and shows it on the **Insights** page:

- **Totals across all profiles** with the change from the week before: profile views (Google Search +
  Maps), calls, direction requests and website clicks.
- **One row per profile** (hospital first, then doctors by calls): the same four numbers, the current
  rating and total reviews, and how many new reviews arrived that week.
- **What stands out:** plain observations worked out from the numbers, not by AI, so nothing is
  invented: which doctor got the most calls, profiles whose views fell or grew by 25%+, ratings below
  4.0, new reviews vs replies still waiting, and posts published that week.
- **Download CSV** for Excel/Google Sheets, and **Past weeks** to look back.
- **Facebook:** followers, media views (how often posts/photos/videos were seen), number of posts, and
  reactions + comments + shares on that week's posts, with the best post linked.
- **Instagram:** followers, views, accounts reached, interactions, profile button taps, new followers,
  number of posts, and likes + comments on that week's posts, with the best post linked.
- Optional WhatsApp alert with the headline numbers and a link.

Meta keeps retiring insights metrics (Page "impressions" in Nov 2025; reach, engagement and follows in
June 2026). Each metric is fetched separately, so if Meta retires another one the report shows it as
"Not available" with Meta's message instead of failing. Post engagement is counted from the posts
themselves (likes, comments, shares), which Meta hasn't been retiring. If Meta renames the Facebook
views metric again, set `META_FB_VIEWS_METRIC`.

"Build latest week's report now" rebuilds it on demand; rebuilding a week replaces it rather than adding a
duplicate. If one profile can't be read, the report still builds and names that profile.

The Google part uses the same Google sign-in as posting, plus one more API to enable: **Business Profile
Performance API** (step 3 below). The Facebook/Instagram part uses the same Page token as posting, but
the token needs the insights permissions listed in step 2. The report works with only Google, only
Meta, or both connected. On Render's free plan, add a cron-job.org job for
`POST /cron/insights` (step 4).

### Code map

| File | What it does |
|---|---|
| `data/hospital.json` | Doctors, departments, hospital facts and topics. **The only facts Gemini may use.** |
| `src/topics.ts` | Topic rotation |
| `src/captions.ts` | Gemini captions, and the Facebook/Instagram and Google versions of the text |
| `src/compliance.ts` | NMC wording rules and warnings |
| `src/images.ts` | Photo → 1080x1350 JPEG, or a generated text card |
| `src/publishers/meta.ts` | Facebook Page photo post, Instagram 2-step publish |
| `src/publishers/gbp.ts`, `src/gbpMatch.ts` | Google Business Profile posts and profile ↔ doctor matching |
| `src/workflow.ts` | Draft → approve → publish, retry of failed channels |
| `src/web/*` | Approval page (password login, CSRF + same-origin checks) |
| `src/reviews.ts`, `src/web/reviewViews.ts` | Review sync, reply drafts, posting replies, Reviews page |
| `src/insights.ts`, `src/web/insightViews.ts` | Weekly report: Google Performance numbers, highlights, CSV, Insights page |
| `src/comments.ts`, `src/publishers/metaComments.ts`, `src/web/commentViews.ts` | Facebook/Instagram comment sync, reply drafts, posting/hiding, Comments page |
| `src/metaInsights.ts` | Facebook Page and Instagram numbers for the weekly report |
| `src/notify.ts` | Optional send-only WhatsApp alert through WATI |
| `scripts/gbp-auth.mjs` | One-time Google sign-in; saves the refresh token into `.env` without printing it |
| `scripts/gbp-locations.ts` | Read-only check of which profile matched which doctor |

## Run locally

```bash
npm install
cp .env.example .env        # fill in at least APP_PASSWORD, SESSION_SECRET, GEMINI_API_KEY
npm start                   # http://localhost:3000
npm test                    # tests never touch real accounts: they blank every credential
```

## Setup checklist

### 1. Check `data/hospital.json` and add photos
The file lists 17 doctors, 2 physiotherapists and a dietitian with their qualifications,
specialities, departments and experience. The source is the Drive sheet "CHETNA HOSPITAL DOCTORS"
(Jan 2026), plus the hospital website for Dr. Hemant C. Patil. **Gemini may only use what is written
here**, so keep it up to date when doctors join or leave. People marked `"spotlight": false`
(physiotherapists, dietitian) appear in department posts but don't get their own spotlight post.
Add photos to `social-images/` as `doctor-<slug>.jpg`.

### 2. Facebook & Instagram (about 15 minutes, free)
1. In the Instagram app: switch the account to **Professional (Business)** and link it to the
   hospital's Facebook Page.
2. At developers.facebook.com create an app (type **Business**) and add the **Facebook Login for
   Business** and **Instagram Graph API** products.
3. In **Graph API Explorer**, pick the app, request `pages_show_list`, `pages_read_engagement`,
   `pages_manage_posts`, `pages_read_user_content`, `pages_manage_engagement`, `read_insights`,
   `instagram_basic`, `instagram_content_publish`, `instagram_manage_comments`,
   `instagram_manage_insights`, `business_management`, and generate a **User token**.
   (`pages_read_user_content`, `pages_manage_engagement` and `instagram_manage_comments` are for
   comment replies; `read_insights` and `instagram_manage_insights` are for the weekly report.)
4. Exchange it for a long-lived user token (Access Token Debugger → *Extend Access Token*), then call
   `GET /me/accounts` with it: the `access_token` next to your Page is a **Page token that does not
   expire**. That is `META_PAGE_ACCESS_TOKEN`; the Page's `id` is `META_PAGE_ID`.
5. `GET /<META_PAGE_ID>?fields=instagram_business_account` gives `META_IG_USER_ID`.

You are an admin of your own Page, so posting to it works without Meta's full app review.

### 2b. Doctors' own Facebook Pages and Instagram (optional)
A doctor spotlight can also go to that doctor's own Facebook Page and linked Instagram account, and a
department post to the Pages of the doctors in it. Hospital-wide posts stay on the hospital Page only.
1. In Business settings, make sure each doctor's Page is in the hospital's business portfolio and each
   doctor's Instagram is linked to their Page.
2. Give the portfolio's **system user** full control of those Pages and Instagram accounts, and a role
   on the app.
3. Generate a system-user token for the app (expiry **Never**, the same 11 permissions) and set it on
   Render as `META_SYSTEM_USER_TOKEN`.
4. Open the **Connections** page. It lists which Page and Instagram account each doctor matched. Pages are
   matched by name (like the Google profiles), using the doctor's name or an `aliases` entry in
   `data/hospital.json`; set `facebookPageId` on a doctor to pin a Page exactly. The approval page also
   lists every Page a draft will go to before you approve it.

The same accounts are also covered by **comment replies** (comments on a doctor's Page or Instagram are
labelled with the doctor's name, and replies/hides are made as that Page) and by the **weekly report**
(a Facebook and an Instagram section per doctor). The WhatsApp alert's headline numbers stay hospital-only.

### 3. Google Business Profiles (14 profiles, 1 Gmail)
1. **Request API access first; it can take weeks.** Search for "Business Profile API access
   request" (linked from the API's *Prerequisites* page). Use the Google Cloud project number and the
   Gmail that owns or manages the profiles. Use case: *"Hospital managing its own 14 verified
   profiles (hospital + doctors): scheduled posts, review replies, consistent hours."*
2. After approval, in Google Cloud enable **My Business Account Management API**, **My Business
   Business Information API**, **Google My Business API** and **Business Profile Performance API**
   (the last one is for the weekly report).
3. Create an OAuth client of type **Desktop app**. Put its ID/secret in `.env` as `GBP_CLIENT_ID` /
   `GBP_CLIENT_SECRET`.
4. On the OAuth consent screen, set the publishing status to **In production**. In "Testing" the
   sign-in expires after 7 days and posting stops without warning.
5. `npm run gbp:auth` and sign in with the Gmail that owns the profiles, or with an account added as
   **Manager** on all of them. This saves `GBP_REFRESH_TOKEN` into `.env`.
6. `npm run gbp:locations` shows every profile and which doctor it matched. Fix names in
   `data/hospital.json` (or set `GBP_HOSPITAL_LOCATION`) until everything matches.

### 4. Deploy on Render (free)
1. New → **Blueprint** → this repository (uses `render.yaml`).
2. Render's free disk is wiped on every deploy, so use a free **Turso** database: set `DATABASE_URL`
   (`libsql://...`) and `DATABASE_AUTH_TOKEN`.
3. Set `PUBLIC_BASE_URL` to the service's `https://...onrender.com` address, plus the other secrets
   from `.env`. **Never put secrets in the repository; it is public.**
4. The free plan sleeps after 15 minutes idle, so the built-in 10:00 schedule may not run. Also set
   `CRON_SECRET` and add a free job at cron-job.org: `POST https://<your-app>/cron/draft` with
   header `x-cron-secret: <CRON_SECRET>`, Mon/Wed/Fri 10:00 IST. It won't create more than
   `MAX_PENDING_DRAFTS` waiting drafts, so the two schedules can't pile up duplicates.
   Add a second job, `POST https://<your-app>/cron/reviews` with the same header, every 3 hours
   during the day, so new reviews are fetched even while the service is asleep.
   And a third, `POST https://<your-app>/cron/insights`, Thursdays 09:00 IST, for the weekly report,
   and a fourth, `POST https://<your-app>/cron/comments`, every 2 hours during the day, for comments.

### 5. Optional: WhatsApp alerts
One WATI template covers all alerts (a draft is waiting, new reviews or comments to answer, the weekly report).
Submit `chetna_social_update` (category Utility) with the text
*"Chetna Social update: {{1}}. Open: {{2}}"*, then set `WATI_API_ENDPOINT`, `WATI_API_TOKEN` and
`ALERT_PHONES`. This service only sends alerts, never receives WhatsApp messages, so it stays
separate from the booking bot.

### 6. First live test
Create one draft, approve it, and check it appears on Facebook, Instagram and the Google profiles.

## Not built yet
- Replying to Facebook Messenger / Instagram direct messages (these would belong with the WhatsApp bot).
