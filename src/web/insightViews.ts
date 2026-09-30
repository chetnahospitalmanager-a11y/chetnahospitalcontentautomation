import type { ReportRow } from '../db.ts';
import type { ChannelReport } from '../metaInsights.ts';
import { change, fmtRange, METRIC_KEYS, METRICS, type Pair, type WeeklyReport } from '../insights.ts';
import { esc, layout } from './views.ts';

function delta(p: Pair): string {
  const c = change(p);
  const color = c.startsWith('+') || c === 'new' ? 'var(--ok)' : c.startsWith('-') ? 'var(--bad)' : 'var(--muted)';
  return `<span style="color:${color};font-size:.8rem;white-space:nowrap">${esc(c)}</span>`;
}

function tile(label: string, p: Pair): string {
  return `<div class="card" style="margin:0;padding:12px"><div class="muted">${esc(label)}</div>
<div style="font-size:1.6rem;font-weight:700;line-height:1.2">${p.cur.toLocaleString('en-IN')}</div>
<div>${delta(p)} <span class="muted" style="font-size:.8rem">vs ${p.prev.toLocaleString('en-IN')}</span></div></div>`;
}

function channelCard(c: ChannelReport): string {
  if (c.error) return `<div class="card"><h2>${esc(c.label)}</h2><p class="err" style="margin:0">Could not read ${esc(c.label)}: ${esc(c.error)}</p></div>`;
  const engLabel = c.channel === 'facebook' ? 'Reactions, comments & shares' : 'Likes & comments';
  const tiles = [
    ...c.metrics.filter((m) => m.key !== 'posts').map((m) =>
      m.value
        ? tile(m.label, m.value)
        : `<div class="card" style="margin:0;padding:12px"><div class="muted">${esc(m.label)}</div><div style="font-size:1rem;font-weight:600">Not available</div><div class="muted" style="font-size:.75rem">${esc(m.note ?? '')}</div></div>`,
    ),
    tile('Posts', c.posts),
    tile(engLabel, c.engagement),
  ].join('');
  const top = c.topPost
    ? `<p style="margin:12px 0 0"><strong>Best post:</strong> ${c.topPost.url ? `<a href="${esc(c.topPost.url)}" target="_blank" rel="noopener noreferrer">` : ''}${esc(c.topPost.text || '(no caption)')}${c.topPost.url ? '</a>' : ''} <span class="muted">· ${c.topPost.engagement.toLocaleString('en-IN')} ${esc(engLabel.toLowerCase())}</span></p>`
    : '';
  return `<div class="card"><h2>${esc(c.label)}${c.followers !== null ? ` <span class="muted" style="font-weight:400;font-size:.9rem">· ${c.followers.toLocaleString('en-IN')} followers</span>` : ''}</h2>
<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px">${tiles}</div>${top}</div>`;
}

export function insightsPage(opts: {
  report: ReportRow<WeeklyReport> | null;
  history: ReportRow<WeeklyReport>[];
  gbpConnected: boolean;
  metaConnected: boolean;
  csrf: string;
  flash?: string;
  error?: string;
}): string {
  const hidden = `<input type="hidden" name="_csrf" value="${esc(opts.csrf)}">`;
  const notConnected = [
    !opts.gbpConnected && 'Google Business Profiles (GBP_* settings)',
    !opts.metaConnected && 'Facebook/Instagram (META_* settings)',
  ].filter(Boolean);
  const generate = `${
    opts.gbpConnected || opts.metaConnected
      ? `<form method="post" action="/insights/generate" class="row" style="margin-top:0">${hidden}<button>Build latest week's report now</button><span class="muted">Built automatically every Thursday morning.</span></form>`
      : ''
  }${notConnected.length ? `<p class="muted" style="margin:${opts.gbpConnected || opts.metaConnected ? '8px' : '0'} 0 0">Not connected yet: ${esc(notConnected.join(', '))}. See the README.</p>` : ''}`;
  const history = opts.history.length
    ? `<div class="card"><h2>Past weeks</h2><ul>${opts.history
        .map((h) => `<li><a href="/insights/${h.id}">${esc(fmtRange(h.weekStart, h.weekEnd))}</a> <span class="muted">· ${h.data.totals.calls.cur} calls</span></li>`)
        .join('')}</ul></div>`
    : '';

  let body = '';
  const r = opts.report?.data;
  if (opts.report && r) {
    const rows = r.profiles
      .map(
        (p) => `<tr><td><strong>${esc(p.title)}</strong>${p.kind === 'hospital' ? ' <span class="badge">Hospital</span>' : ''}${
          p.error ? `<br><span style="color:var(--bad);font-size:.85rem">${esc(p.error)}</span>` : ''
        }</td>${METRIC_KEYS.map((k) => `<td style="text-align:right">${p.metrics[k].cur.toLocaleString('en-IN')}<br>${delta(p.metrics[k])}</td>`).join('')}
<td style="text-align:right">${p.rating !== null ? `${p.rating.toFixed(1)} ★` : '–'}<br><span class="muted" style="font-size:.8rem">${p.totalReviews} total</span></td>
<td style="text-align:right">${p.newReviews}${p.newReviewsAvg !== null ? `<br><span class="muted" style="font-size:.8rem">avg ${p.newReviewsAvg.toFixed(1)} ★</span>` : ''}</td></tr>`,
      )
      .join('');
    body = `<div class="card"><h1 style="margin-bottom:4px">Week of ${esc(fmtRange(r.weekStart, r.weekEnd))}</h1>
<p class="muted" style="margin:0">Compared with ${esc(fmtRange(r.prevStart, r.prevEnd))}. Built ${esc(r.generatedAt.slice(0, 16).replace('T', ' '))} UTC.
<a href="/insights/${opts.report.id}.csv">Download CSV</a></p></div>
${r.profiles.length ? `<h2 style="margin:0 0 8px">Google Business Profiles</h2><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px">${METRIC_KEYS.map((k) => tile(METRICS[k].label, r.totals[k])).join('')}</div>` : ''}
<div class="card"><h2>What stands out</h2><ul>${r.highlights.map((h) => `<li>${esc(h)}</li>`).join('')}</ul></div>
${r.profiles.length ? `<div class="card"><h2>By profile</h2><div style="overflow-x:auto"><table style="min-width:720px">
<tr><th>Profile</th>${METRIC_KEYS.map((k) => `<th style="text-align:right">${esc(METRICS[k].label)}</th>`).join('')}<th style="text-align:right">Rating</th><th style="text-align:right">New reviews</th></tr>
${rows}</table></div>
<p class="muted" style="margin-bottom:0">Views = times the profile was shown on Google Search and Maps. Calls, directions and website clicks are taps on those buttons in the profile. Google's numbers can change slightly for a few days after the week ends.</p></div>` : ''}
${(r.social ?? []).map(channelCard).join('')}${
      r.social?.length
        ? '<p class="muted">Facebook "media views" counts how many times your posts, photos and videos were seen. Engagement counts only posts published that week. Meta can take up to 48 hours to finalise these numbers.</p>'
        : ''
    }`;
  } else {
    body = '<div class="card"><p class="muted" style="margin:0">No report yet.</p></div>';
  }

  return layout(
    'Insights',
    `${opts.flash ? `<p class="warn">${esc(opts.flash)}</p>` : ''}${opts.error ? `<p class="err">${esc(opts.error)}</p>` : ''}
<div class="card">${generate}</div>
${body}
${history}`,
    { loggedIn: true },
  );
}
