// Read-only: lists every Google Business Profile the signed-in account can see and which doctor each
// one was matched to. Nothing is posted.
import { gbpEnabled } from '../src/config.ts';
import { loadHospital } from '../src/hospital.ts';
import { getMatch, listLocations } from '../src/publishers/gbp.ts';

if (!gbpEnabled()) {
  console.error('Set GBP_CLIENT_ID, GBP_CLIENT_SECRET and GBP_REFRESH_TOKEN in .env (run: npm run gbp:auth).');
  process.exit(1);
}

const locations = await listLocations();
console.log(`Found ${locations.length} profiles:\n`);
for (const l of locations) console.log(`  ${l.name.padEnd(28)} ${l.title}`);

const match = await getMatch(true);
console.log(`\nHospital profile: ${match.hospital ? `${match.hospital.title} (${match.hospital.name})` : 'NOT FOUND'}`);
console.log('\nDoctor profiles:');
for (const d of loadHospital().doctors) {
  const loc = match.byDoctor.get(d.slug);
  console.log(`  ${d.name.padEnd(30)} → ${loc ? loc.title : '(no profile matched)'}`);
}
if (match.problems.length) {
  console.log('\nNeeds attention:');
  for (const p of match.problems) console.log(`  - ${p}`);
}
