import type { Post } from '../db.ts';
import { gbpSummary, socialCaption } from '../captions.ts';
import { loadHospital, postableDepartments, spotlightDoctors } from '../hospital.ts';

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const STATUS_LABEL: Record<string, string> = {
  draft: 'Waiting for approval',
  publishing: 'Publishing…',
  published: 'Published',
  partial: 'Partly published',
  failed: 'Failed',
  skipped: 'Skipped',
};

function layout(title: string, body: string, opts: { loggedIn?: boolean } = {}): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} · Chetna Social</title>
<style>
:root{--bg:#f4f7f8;--card:#fff;--ink:#14262b;--muted:#5b6f75;--line:#dbe4e6;--brand:#0b5d6b;--ok:#1d7a3e;--warn:#9a5b00;--bad:#b3261e}
*{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--ink)}
header{background:var(--brand);color:#fff;padding:12px 16px;display:flex;justify-content:space-between;align-items:center}
header a{color:#fff;text-decoration:none;font-weight:600}main{max-width:960px;margin:0 auto;padding:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:16px}
h1{font-size:1.3rem;margin:0 0 12px}h2{font-size:1.1rem;margin:0 0 8px}
.muted{color:var(--muted);font-size:.9rem}.grid{display:grid;grid-template-columns:minmax(0,320px) minmax(0,1fr);gap:16px}
@media(max-width:700px){.grid{grid-template-columns:1fr}}
img.preview{width:100%;aspect-ratio:4/5;object-fit:cover;display:block;border-radius:8px;border:1px solid var(--line)}
textarea,input[type=text],input[type=password],select{width:100%;font:inherit;padding:8px;border:1px solid var(--line);border-radius:8px;background:#fff;color:var(--ink)}
textarea{min-height:180px}button{font:inherit;padding:10px 14px;border-radius:8px;border:1px solid var(--line);background:#fff;cursor:pointer}
button.primary{background:var(--brand);color:#fff;border-color:var(--brand)}button.danger{color:var(--bad)}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:.8rem;background:#e6eef0}
.badge.published{background:#dff3e5;color:var(--ok)}.badge.failed{background:#fbe3e1;color:var(--bad)}.badge.partial{background:#fff1d6;color:var(--warn)}
.warn{background:#fff6e0;border:1px solid #f0d49a;border-radius:8px;padding:8px 12px;color:#5c3b00}
.err{background:#fbe3e1;border:1px solid #efb4ae;border-radius:8px;padding:8px 12px;color:#6d130d}
pre{white-space:pre-wrap;word-break:break-word;background:#f7fafa;border:1px solid var(--line);border-radius:8px;padding:8px;margin:0;font:14px/1.45 system-ui,sans-serif}
ul{padding-left:20px;margin:6px 0}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:6px;border-bottom:1px solid var(--line);font-size:.95rem}
details summary{cursor:pointer;color:var(--brand);font-weight:600}
</style></head><body>
<header><a href="/">Chetna Social</a>${opts.loggedIn ? '<form method="post" action="/logout" style="margin:0"><button style="padding:4px 10px">Log out</button></form>' : ''}</header>
<main>${body}</main></body></html>`;
}

export function loginPage(error?: string): string {
  return layout(
    'Log in',
    `<div class="card" style="max-width:380px;margin:40px auto">
<h1>Log in</h1>${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="post" action="/login"><label>Password<br><input type="password" name="password" autofocus required></label>
<div class="row"><button class="primary">Log in</button></div></form></div>`,
  );
}

function badge(status: string): string {
  return `<span class="badge ${esc(status)}">${esc(STATUS_LABEL[status] ?? status)}</span>`;
}

export function dashboardPage(opts: { drafts: Post[]; recent: Post[]; csrf: string; flash?: string; error?: string }): string {
  const h = loadHospital();
  const draftCards = opts.drafts.length
    ? opts.drafts
        .map(
          (p) => `<a href="/posts/${p.id}" style="text-decoration:none;color:inherit"><div class="card" style="display:grid;grid-template-columns:96px minmax(0,1fr);gap:16px;align-items:center">
<img class="preview" src="/image/${p.id}.jpg?v=${encodeURIComponent(p.imageKey)}" alt="">
<div><strong>${esc(p.title)}</strong><br><span class="muted">${esc(p.caption.slice(0, 140))}…</span><br>${badge(p.status)}${p.warnings.length ? ' <span class="badge partial">Check wording</span>' : ''}</div></div></a>`,
        )
        .join('')
    : '<p class="muted">No drafts waiting. The next one is written automatically, or create one below.</p>';

  const options = [
    '<option value="next">Next in rotation</option>',
    spotlightDoctors().length ? `<optgroup label="Doctor spotlight">${spotlightDoctors().map((d) => `<option value="doctor:${esc(d.slug)}">${esc(d.name)}</option>`).join('')}</optgroup>` : '',
    postableDepartments().length ? `<optgroup label="Department">${postableDepartments().map((d) => `<option value="department:${esc(d.slug)}">${esc(d.name)}</option>`).join('')}</optgroup>` : '',
    `<optgroup label="Hospital">${h.hospital.topics.map((t) => `<option value="hospital:${esc(t.key)}">${esc(t.label)}</option>`).join('')}</optgroup>`,
    '<option value="custom">Custom topic (type below)</option>',
  ].join('');

  const rows = opts.recent
    .map(
      (p) => `<tr><td><a href="/posts/${p.id}">${esc(p.title)}</a></td><td>${badge(p.status)}</td><td class="muted">${esc(p.updatedAt.slice(0, 16).replace('T', ' '))} UTC</td></tr>`,
    )
    .join('');

  return layout(
    'Drafts',
    `${opts.flash ? `<p class="warn">${esc(opts.flash)}</p>` : ''}${opts.error ? `<p class="err">${esc(opts.error)}</p>` : ''}
<h1>Waiting for approval</h1>${draftCards}
<div class="card"><h2>New post</h2>
<form method="post" action="/posts"><input type="hidden" name="_csrf" value="${esc(opts.csrf)}">
<label>Topic<br><select name="topic">${options}</select></label>
<label style="display:block;margin-top:8px">Custom topic <span class="muted">(e.g. World Heart Day)</span><br><input type="text" name="custom" maxlength="200"></label>
<div class="row"><button class="primary">Write draft</button><span class="muted">Gemini writes it in a few seconds. Nothing is posted until you approve.</span></div></form></div>
<div class="card"><h2>Recent posts</h2>${rows ? `<table><tr><th>Post</th><th>Status</th><th>Updated</th></tr>${rows}</table>` : '<p class="muted">None yet.</p>'}</div>`,
    { loggedIn: true },
  );
}

export function postPage(opts: { post: Post; channels: string[]; notes: string[]; csrf: string; flash?: string; error?: string }): string {
  const { post, csrf } = opts;
  const hidden = `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;
  const isDraft = post.status === 'draft';
  const canRetry = post.status === 'partial' || post.status === 'failed';

  const warnings = post.warnings.length
    ? `<div class="warn"><strong>Check the wording before approving</strong> (NMC advertising rules):<ul>${post.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>Edit the caption or ask for changes.</div>`
    : '';

  const targets = `<h2>Will post to</h2>${
    opts.channels.length ? `<ul>${opts.channels.map((c) => `<li>${esc(c.replace(/^gbp:/, 'Google: '))}</li>`).join('')}</ul>` : '<p class="muted">No channels connected yet.</p>'
  }${opts.notes.length ? `<ul class="muted">${opts.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}`;

  const results = post.results.length
    ? `<div class="card"><h2>Publishing results</h2><table>${post.results
        .map((r) => `<tr><td>${esc(r.channel.replace(/^gbp:/, 'Google: '))}</td><td>${r.ok ? '✅ Posted' : `❌ ${esc(r.error)}`}</td></tr>`)
        .join('')}</table>${
        canRetry ? `<form method="post" action="/posts/${post.id}/publish">${hidden}<div class="row"><button class="primary">Retry the failed ones</button></div></form>` : ''
      }</div>`
    : '';

  const actions = isDraft
    ? `<form method="post" action="/posts/${post.id}/caption">${hidden}
<label><strong>Caption</strong> <span class="muted">(you can edit it directly)</span><br><textarea name="caption" maxlength="2000">${esc(post.caption)}</textarea></label>
<div class="row"><button>Save edits</button></div></form>
<form method="post" action="/posts/${post.id}/publish" style="margin-top:16px">${hidden}
${post.warnings.length ? '<label class="row"><input type="checkbox" name="confirm" value="yes" required> I have checked the wording</label>' : ''}
<div class="row"><button class="primary">Approve &amp; post</button></div></form>
<details style="margin-top:16px"><summary>Request changes</summary>
<form method="post" action="/posts/${post.id}/revise">${hidden}
<textarea name="feedback" style="min-height:80px" placeholder="e.g. Make it shorter and mention OPD timings" required maxlength="1000"></textarea>
<div class="row"><button>Rewrite with Gemini</button></div></form></details>
<form method="post" action="/posts/${post.id}/skip" style="margin-top:16px">${hidden}<button class="danger">Skip this post</button></form>`
    : `<h2>Caption</h2><pre>${esc(post.caption)}</pre>`;

  return layout(
    post.title,
    `<p><a href="/">← All drafts</a></p>
${opts.flash ? `<p class="warn">${esc(opts.flash)}</p>` : ''}${opts.error ? `<p class="err">${esc(opts.error)}</p>` : ''}
<div class="card"><h1>${esc(post.title)}</h1>${badge(post.status)}</div>
${results}
<div class="card grid"><div><img class="preview" src="/image/${post.id}.jpg?v=${encodeURIComponent(post.imageKey)}" alt="Post image">
<p class="muted">Image: <code>${esc(post.imageKey)}</code>. Add a real photo with this name in <code>social-images/</code> to replace the text card.</p>
${isDraft ? targets : ''}</div>
<div>${warnings}${actions}</div></div>
<div class="card"><details><summary>Preview: exactly what will be posted</summary>
<h2 style="margin-top:12px">Facebook &amp; Instagram</h2><pre>${esc(socialCaption(post.caption))}</pre>
<h2 style="margin-top:12px">Google Business Profile</h2><pre>${esc(gbpSummary(post.caption))}</pre>
<p class="muted">Google posts get a <strong>Book</strong> button to WhatsApp instead of a phone number (Google rejects phone numbers in posts).</p></details></div>`,
    { loggedIn: true },
  );
}
