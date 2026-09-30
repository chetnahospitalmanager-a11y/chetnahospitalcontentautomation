import './setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadHospital, spotlightDoctors } from '../src/hospital.ts';
import { matchLocations, type GbpLocation } from '../src/gbpMatch.ts';

const data = loadHospital();

test('hospital.json is consistent: unique slugs, known departments, required fields', () => {
  const slugs = data.doctors.map((d) => d.slug);
  assert.equal(new Set(slugs).size, slugs.length, 'duplicate doctor slug');
  const depts = new Set(data.departments.map((d) => d.slug));
  assert.equal(depts.size, data.departments.length, 'duplicate department slug');
  for (const d of data.doctors) {
    assert.match(d.slug, /^[a-z0-9-]+$/, d.slug);
    assert.ok(d.name.trim(), `${d.slug} has no name`);
    assert.ok(d.speciality.trim(), `${d.slug} has no speciality`);
    assert.ok(!d.department || depts.has(d.department), `${d.slug} points to unknown department ${d.department}`);
  }
  for (const dep of data.departments) assert.ok(data.doctors.some((d) => d.department === dep.slug), `${dep.slug} has no doctors`);
});

test('physiotherapists and the dietitian are listed but not spotlighted', () => {
  const spot = new Set(spotlightDoctors().map((d) => d.slug));
  for (const slug of ['shruti-gupta', 'sanskruti-kale', 'komal-bhamare']) assert.equal(spot.has(slug), false, slug);
  assert.ok(spot.has('nirmal-patil'));
});

test('the six Patils each match only their own Google profile', () => {
  const loc = (n: number, title: string): GbpLocation => ({ name: `locations/${n}`, account: 'accounts/1', title });
  const m = matchLocations(
    [
      loc(1, 'Chetna Hospital'),
      loc(2, 'Dr. Dhananjay Patil - General Surgeon'),
      loc(3, 'Dr. Nirmal Patil'),
      loc(4, 'Dr Bharati Patil Gynaecologist'),
      loc(5, 'Dr. Hemant Patil'),
      loc(6, 'Dr. Aishwarya Pethe'),
      loc(7, 'Dr. Rachana Tiwari-Patil'),
    ],
    data.doctors,
    { hospitalKeyword: 'Chetna' },
  );
  assert.deepEqual(m.problems, []);
  assert.equal(m.byDoctor.get('dhananjay-patil')?.name, 'locations/2');
  assert.equal(m.byDoctor.get('nirmal-patil')?.name, 'locations/3');
  assert.equal(m.byDoctor.get('bharati-patil')?.name, 'locations/4');
  assert.equal(m.byDoctor.get('hemant-patil')?.name, 'locations/5');
  assert.equal(m.byDoctor.get('aishwarya-patil-pethe')?.name, 'locations/6');
  assert.equal(m.byDoctor.get('rachana-tiwari-patil')?.name, 'locations/7');
});
