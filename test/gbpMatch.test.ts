import './setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchLocations, type GbpLocation } from '../src/gbpMatch.ts';
import type { Doctor } from '../src/hospital.ts';

const doc = (slug: string, name: string): Doctor => ({ slug, name, qualification: '', speciality: '', department: '', bio: '' });
const doctors = [
  doc('nirmal-patil', 'Dr. Nirmal Patil'),
  doc('hemant-patil', 'Dr. Hemant Patil'),
  doc('bharati-patil', 'Dr. Bharati Patil'),
  doc('aishwarya-patil-pethe', 'Dr. Aishwarya Patil Pethe'),
  doc('mahesh-kharade', 'Dr. Mahesh Kharade'),
];
const loc = (n: number, title: string): GbpLocation => ({ name: `locations/${n}`, account: 'accounts/1', title });

test('matches doctors by first name + surname without mixing up the Patils', () => {
  const m = matchLocations(
    [
      loc(1, 'Chetna Hospital'),
      loc(2, 'Dr. Nirmal Patil - Orthopaedic Surgeon'),
      loc(3, 'Dr Hemant Patil'),
      loc(4, 'Dr. Aishwarya Pethe'),
      loc(5, 'Dr. Mahesh Kharade | Cardiologist'),
    ],
    doctors,
    { hospitalKeyword: 'Chetna' },
  );
  assert.equal(m.hospital?.name, 'locations/1');
  assert.equal(m.byDoctor.get('nirmal-patil')?.name, 'locations/2');
  assert.equal(m.byDoctor.get('hemant-patil')?.name, 'locations/3');
  assert.equal(m.byDoctor.get('aishwarya-patil-pethe')?.name, 'locations/4');
  assert.equal(m.byDoctor.get('mahesh-kharade')?.name, 'locations/5');
  assert.equal(m.byDoctor.has('bharati-patil'), false);
  assert.deepEqual(m.problems, []);
});

test('a title naming two doctors is skipped, not guessed', () => {
  const m = matchLocations([loc(1, 'Chetna Hospital'), loc(2, 'Dr. Hemant Patil & Dr. Bharati Patil Clinic')], doctors, { hospitalKeyword: 'Chetna' });
  assert.equal(m.byDoctor.size, 0);
  assert.equal(m.problems.length, 1);
});

test('two profiles for the same doctor are both skipped', () => {
  const m = matchLocations([loc(1, 'Chetna Hospital'), loc(2, 'Dr. Nirmal Patil'), loc(3, 'Nirmal Patil Clinic')], doctors, { hospitalKeyword: 'Chetna' });
  assert.equal(m.byDoctor.has('nirmal-patil'), false);
});

test('GBP_HOSPITAL_LOCATION overrides the hospital guess', () => {
  const m = matchLocations([loc(1, 'Chetna Hospital'), loc(9, 'Chetna Hospital Pimpri')], doctors, { hospitalKeyword: 'Chetna', hospitalLocation: 'locations/9' });
  assert.equal(m.hospital?.name, 'locations/9');
});

test('unmatched profiles are reported', () => {
  const m = matchLocations([loc(1, 'Chetna Hospital'), loc(2, 'Dr. Someone Else')], doctors, { hospitalKeyword: 'Chetna' });
  assert.ok(m.problems.some((p) => p.includes('Someone Else')));
});
