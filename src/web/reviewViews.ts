import type { ReviewRow } from '../db.ts';
import type { SyncSummary } from '../reviews.ts';
import { badge, esc, layout } from './views.ts';

function stars(n: number): string {
  return `<span aria-label="${n} of 5 stars" style="color:#c98a00;letter-spacing:1px">${'★'.repeat(n)}${'☆'.repeat(5 - n)}</span>`;
}

function reviewCard(r: ReviewRow, csrf: string): string {
  const hidden = `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;
  const low = r.rating > 0 && r.rating <= 2;
  const warnings = r.warnings.length
    ? `<div class="warn"><strong>Check before posting:</strong><ul>${r.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>`
    : '';
  const replyForm = r.reply
    ? `<form method="post" action="/reviews/${r.id}/save">${hidden}
<label><strong>Reply</strong> <span class="muted">(public on Google; edit freely)</span><br><textarea name="reply" style="min-height:120px" maxlength="4000">${esc(r.reply)}</textarea></label>
<div class="row"><button>Save edits</button></div></form>
<form method="post" action="/reviews/${r.id}/post" style="margin-top:12px">${hidden}
${r.warnings.length ? '<label class="row"><input type="checkbox" name="confirm" value="yes" required> I have checked the wording</label>' : ''}
<div class="row"><button class="primary">Post reply on Google</button></div></form>
<details style="margin-top:12px"><summary>Request changes</summary>
<form method="post" action="/reviews/${r.id}/revise">${hidden}
<textarea name="feedback" style="min-height:70px" placeholder="e.g. Shorter, and mention we have noted the waiting time issue" required maxlength="1000"></textarea>
<div class="row"><button>Rewrite with Gemini</button></div></form></details>`
    : `<form method="post" action="/reviews/${r.id}/draft">${hidden}<div class="row"><button class="primary">Write a reply with Gemini</button><span class="muted">Not drafted yet.</span></div></form>`;

  return `<div class="card" id="r${r.id}" style="${low ? 'border-left:4px solid var(--bad)' : ''}">
<div class="row" style="justify-content:space-between;margin-top:0"><div>${stars(r.rating)} <strong>${esc(r.reviewer)}</strong> <span class="muted">on ${esc(r.locationTitle)} · ${esc(r.reviewUpdated.slice(0, 10))}</span></div>${badge(r.status)}</div>
${low ? '<p class="err" style="margin:8px 0">Low rating: reply soon, and pass the complaint to the team concerned.</p>' : ''}
${r.error ? `<p class="err" style="margin:8px 0">${esc(r.error)}</p>` : ''}
<pre style="margin:8px 0 12px">${r.comment ? esc(r.comment) : '<span class="muted">(star rating only, no text)</span>'}</pre>
${warnings}${replyForm}
<form method="post" action="/reviews/${r.id}/skip" style="margin-top:12px">${hidden}<button class="danger">Don't reply</button></form>
</div>`;
}

export function reviewsPage(opts: {
  open: ReviewRow[];
  recent: ReviewRow[];
  lastSync: SyncSummary | null;
  gbpConnected: boolean;
  csrf: string;
  flash?: string;
  error?: string;
}): string {
  const hidden = `<input type="hidden" name="_csrf" value="${esc(opts.csrf)}">`;
  const s = opts.lastSync;
  const syncInfo = s
    ? `Last checked ${esc(s.at.slice(0, 16).replace('T', ' '))} UTC: ${s.profiles} profiles, ${s.newReviews} new, ${s.drafted} replies drafted.${
        s.errors.length ? `<ul class="err">${s.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : ''
      }`
    : 'Not checked yet.';
  const rows = opts.recent
    .map(
      (r) =>
        `<tr><td>${stars(r.rating)} ${esc(r.reviewer)}<br><span class="muted">${esc(r.locationTitle)}</span></td><td>${badge(r.status)}</td><td class="muted">${esc(r.reply.slice(0, 90))}${r.reply.length > 90 ? '…' : ''}</td></tr>`,
    )
    .join('');

  return layout(
    'Reviews',
    `${opts.flash ? `<p class="warn">${esc(opts.flash)}</p>` : ''}${opts.error ? `<p class="err">${esc(opts.error)}</p>` : ''}
<h1>Google reviews to answer</h1>
<div class="card"><p style="margin-top:0" class="muted">${syncInfo}</p>
${
  opts.gbpConnected
    ? `<form method="post" action="/reviews/sync">${hidden}<button>Check for new reviews now</button></form>`
    : '<p class="muted">Google Business Profiles are not connected yet (GBP_* settings). See the README.</p>'
}
<p class="muted" style="margin-bottom:0">Replies are public. Never confirm that someone was a patient or mention their treatment; the draft follows this rule, but please check.</p></div>
${opts.open.length ? opts.open.map((r) => reviewCard(r, opts.csrf)).join('') : '<p class="muted">Nothing waiting. 🎉</p>'}
<div class="card"><h2>Recently handled</h2>${rows ? `<table>${rows}</table>` : '<p class="muted">None yet.</p>'}</div>`,
    { loggedIn: true },
  );
}
