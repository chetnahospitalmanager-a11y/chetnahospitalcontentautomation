import { CATEGORY_LABEL, type CommentSyncSummary } from '../comments.ts';
import type { CommentRow } from '../db.ts';
import { badge, esc, layout } from './views.ts';

const URGENT = new Set(['emergency', 'complaint']);

function when(isoTime: string): string {
  return new Date(isoTime).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
}

function commentCard(c: CommentRow, csrf: string): string {
  const hidden = `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;
  const urgent = URGENT.has(c.category);
  const platform = c.platform === 'facebook' ? 'Facebook' : 'Instagram';
  const cat = c.category
    ? `<span class="badge" style="${c.category === 'emergency' ? 'background:#fbe3e1;color:var(--bad);font-weight:700' : c.category === 'complaint' ? 'background:#fff1d6;color:var(--warn)' : ''}">${esc(CATEGORY_LABEL[c.category] ?? c.category)}</span>`
    : '';
  const warnings = c.warnings.length
    ? `<div class="warn"><strong>Check before posting:</strong><ul>${c.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>`
    : '';
  const replyForm = c.reply
    ? `<form method="post" action="/comments/${c.id}/save">${hidden}
<label><strong>Reply</strong> <span class="muted">(public; edit freely)</span><br><textarea name="reply" style="min-height:90px" maxlength="2000">${esc(c.reply)}</textarea></label>
<div class="row"><button>Save edits</button></div></form>
<form method="post" action="/comments/${c.id}/post" style="margin-top:12px">${hidden}
${c.warnings.length ? '<label class="row"><input type="checkbox" name="confirm" value="yes" required> I have checked the wording</label>' : ''}
<div class="row"><button class="primary">Post reply on ${platform}</button></div></form>
<details style="margin-top:12px"><summary>Request changes</summary>
<form method="post" action="/comments/${c.id}/revise">${hidden}
<textarea name="feedback" style="min-height:60px" placeholder="e.g. Mention that Dr. Patil's OPD is on Mondays" required maxlength="1000"></textarea>
<div class="row"><button>Rewrite with Gemini</button></div></form></details>`
    : `<form method="post" action="/comments/${c.id}/draft">${hidden}<div class="row"><button class="primary">Write a reply with Gemini</button><span class="muted">${c.category ? 'No reply suggested.' : 'Not drafted yet.'}</span></div></form>`;

  return `<div class="card" id="c${c.id}" style="${urgent ? 'border-left:4px solid var(--bad)' : ''}">
<div class="row" style="justify-content:space-between;margin-top:0"><div><span class="badge">${platform}${c.accountLabel ? ` · ${esc(c.accountLabel)}` : ''}</span> ${cat} <strong>${esc(c.author)}</strong> <span class="muted">· ${esc(when(c.commentedAt))}</span></div>${badge(c.status)}</div>
${c.category === 'emergency' ? '<p class="err" style="margin:8px 0">Possible emergency: reply now, and consider calling or messaging the person if they can be reached.</p>' : ''}
${c.error ? `<p class="err" style="margin:8px 0">${esc(c.error)}</p>` : ''}
<p class="muted" style="margin:8px 0 4px">On post: ${c.postUrl ? `<a href="${esc(c.postUrl)}" target="_blank" rel="noopener noreferrer">${esc(c.postText || '(no caption)')}</a>` : esc(c.postText || '(no caption)')}</p>
<pre style="margin:0 0 12px">${c.text ? esc(c.text) : '<span class="muted">(no text)</span>'}</pre>
${warnings}${replyForm}
<div class="row" style="margin-top:12px">
<form method="post" action="/comments/${c.id}/skip" style="margin:0">${hidden}<button>Don't reply</button></form>
<form method="post" action="/comments/${c.id}/hide" style="margin:0">${hidden}<button class="danger" title="Hides it from everyone except the commenter (and their friends on Facebook). Undo in the Meta apps.">Hide comment (spam/abuse)</button></form>
</div></div>`;
}

export function commentsPage(opts: {
  open: CommentRow[];
  recent: CommentRow[];
  lastSync: CommentSyncSummary | null;
  metaConnected: boolean;
  csrf: string;
  flash?: string;
  error?: string;
}): string {
  const hidden = `<input type="hidden" name="_csrf" value="${esc(opts.csrf)}">`;
  const rank = (c: CommentRow) => (c.category === 'emergency' ? 0 : c.category === 'complaint' ? 1 : 2);
  const needs = opts.open.filter((c) => c.needsReply).sort((a, b) => rank(a) - rank(b) || a.commentedAt.localeCompare(b.commentedAt));
  const optional = opts.open.filter((c) => !c.needsReply);
  const s = opts.lastSync;
  const syncInfo = s
    ? `Last checked ${esc(s.at.slice(0, 16).replace('T', ' '))} UTC (${esc(s.checked.join(' + ') || 'nothing')}): ${s.newComments} new, ${s.drafted} replies drafted.${
        s.errors.length ? `<ul class="err">${s.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : ''
      }`
    : 'Not checked yet.';
  const rows = opts.recent
    .map(
      (c) =>
        `<tr><td>${c.platform === 'facebook' ? 'Facebook' : 'Instagram'}${c.accountLabel ? ` (${esc(c.accountLabel)})` : ''} · ${esc(c.author)}<br><span class="muted">${esc(c.text.slice(0, 70))}${c.text.length > 70 ? '…' : ''}</span></td><td>${badge(c.status)}</td><td class="muted">${esc(c.reply.slice(0, 80))}${c.reply.length > 80 ? '…' : ''}</td></tr>`,
    )
    .join('');

  return layout(
    'Comments',
    `${opts.flash ? `<p class="warn">${esc(opts.flash)}</p>` : ''}${opts.error ? `<p class="err">${esc(opts.error)}</p>` : ''}
<h1>Facebook &amp; Instagram comments</h1>
<div class="card"><p style="margin-top:0" class="muted">${syncInfo}</p>
${
  opts.metaConnected
    ? `<form method="post" action="/comments/sync">${hidden}<button>Check for new comments now</button></form>`
    : '<p class="muted">Facebook/Instagram are not connected yet (META_* settings). See the README.</p>'
}
<p class="muted" style="margin-bottom:0">Replies are public. Never give medical advice or confirm that someone was a patient; drafts follow these rules, but please check.</p></div>
<h2>Needs a reply (${needs.length})</h2>
${needs.length ? needs.map((c) => commentCard(c, opts.csrf)).join('') : '<p class="muted">Nothing waiting. 🎉</p>'}
${
  optional.length
    ? `<details class="card"><summary>Probably no reply needed (${optional.length}): tags, emojis, spam</summary><div style="margin-top:12px">${optional.map((c) => commentCard(c, opts.csrf)).join('')}</div></details>`
    : ''
}
<div class="card"><h2>Recently handled</h2>${rows ? `<table>${rows}</table>` : '<p class="muted">None yet.</p>'}</div>`,
    { loggedIn: true },
  );
}
