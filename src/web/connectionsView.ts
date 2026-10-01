import { esc, layout } from './views.ts';

export interface ConnectionsInfo {
  hospital: { facebook: string | null; instagram: string | null; error?: string };
  doctors: { doctor: string; facebook: string | null; instagram: string | null }[];
  doctorPagesEnabled: boolean;
  problems: string[];
  google: {
    connected: boolean;
    error?: string;
    profileCount: number;
    hospital: string | null;
    doctors: { doctor: string; profile: string }[];
    problems: string[];
  };
}

const ok = (v: string | null) => (v ? `✅ ${esc(v)}` : '<span class="muted">—</span>');

export function connectionsPage(info: ConnectionsInfo): string {
  const h = info.hospital;
  const doctorRows = info.doctors
    .map((d) => `<tr><td>${esc(d.doctor)}</td><td>${ok(d.facebook)}</td><td>${ok(d.instagram)}</td></tr>`)
    .join('');
  return layout(
    'Connections',
    `<h1>Connected accounts</h1>
<div class="card"><h2>Hospital</h2>
${h.error ? `<p class="err">${esc(h.error)}</p>` : ''}
<table><tr><th>Facebook Page</th><td>${ok(h.facebook)}</td></tr><tr><th>Instagram</th><td>${ok(h.instagram)}</td></tr></table>
<p class="muted" style="margin-bottom:0">Every post goes here.</p></div>
<div class="card"><h2>Doctors' own Pages</h2>
${
  info.doctorPagesEnabled
    ? doctorRows
      ? `<table><tr><th>Doctor</th><th>Facebook Page</th><th>Instagram</th></tr>${doctorRows}</table>
<p class="muted" style="margin-bottom:0">A doctor spotlight also goes to that doctor's Page and Instagram; a department post goes to the Pages of the doctors in it.</p>`
      : '<p class="muted">The system user manages no Pages that match a doctor in data/hospital.json.</p>'
    : '<p class="muted">Not set up. Add META_SYSTEM_USER_TOKEN on Render (see README) to post to doctors’ own Pages too.</p>'
}
${info.problems.length ? `<h2 style="margin-top:16px">Needs attention</h2><ul>${info.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
</div>
${googleCard(info.google)}`,
    { loggedIn: true },
  );
}

function googleCard(g: ConnectionsInfo['google']): string {
  if (!g.connected) {
    return '<div class="card"><h2>Google Business Profiles</h2><p class="muted" style="margin:0">Not connected yet. Add GBP_CLIENT_ID, GBP_CLIENT_SECRET and GBP_REFRESH_TOKEN on Render (see README).</p></div>';
  }
  if (g.error) return `<div class="card"><h2>Google Business Profiles</h2><p class="err" style="margin:0">${esc(g.error)}</p></div>`;
  const rows = g.doctors.map((d) => `<tr><td>${esc(d.doctor)}</td><td>✅ ${esc(d.profile)}</td></tr>`).join('');
  return `<div class="card"><h2>Google Business Profiles <span class="muted" style="font-weight:400;font-size:.9rem">· ${g.profileCount} profiles found</span></h2>
<table><tr><th>Hospital profile</th><td>${ok(g.hospital)}</td></tr></table>
${rows ? `<table style="margin-top:12px"><tr><th>Doctor</th><th>Google profile</th></tr>${rows}</table>` : '<p class="muted">No doctor profiles matched yet.</p>'}
<p class="muted">Every post goes to the hospital profile; a doctor's or department's post also goes to the matching doctors' profiles.</p>
${g.problems.length ? `<h2 style="margin-top:16px">Needs attention</h2><ul>${g.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
</div>`;
}
