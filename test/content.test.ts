import './setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanCaption, gbpSummary, socialCaption } from '../src/captions.ts';
import { complianceWarnings } from '../src/compliance.ts';

test('compliance flags NMC-unsafe wording', () => {
  assert.ok(complianceWarnings('Meet the best cardiologist in Pune').length > 0);
  assert.ok(complianceWarnings('We are No. 1 in knee replacement').length > 0);
  assert.ok(complianceWarnings('Guaranteed relief').length > 0);
  assert.ok(complianceWarnings('This surgery cures arthritis').length > 0);
  assert.ok(complianceWarnings('Read what our happy patients say').length > 0);
  assert.ok(complianceWarnings('Free consultation this week').length > 0);
});

test('compliance passes a normal informative caption', () => {
  const ok = 'Chest pain, breathlessness or palpitations? Our cardiology team can help you understand your heart health. Consult a doctor early.';
  assert.deepEqual(complianceWarnings(ok), []);
});

test('Facebook/Instagram caption gets booking link, phone and hashtags', () => {
  const c = socialCaption('Look after your heart.');
  assert.match(c, /Look after your heart\./);
  assert.match(c, /https:\/\/wa\.me\/910000000000/);
  assert.match(c, /\+91 00000 00000/);
  assert.match(c, /#ChetnaHospital/);
});

test('Google post text has no phone numbers, links or hashtags', () => {
  const s = gbpSummary('Call us on +91 98765 43210 today! #Health\nVisit https://example.com');
  assert.doesNotMatch(s, /\d{5}/);
  assert.doesNotMatch(s, /https?:/);
  assert.doesNotMatch(s, /#Health/);
  assert.match(s, /Call us on/);
});

test('Google post text is capped at 1500 characters', () => {
  assert.ok(gbpSummary('word '.repeat(600)).length <= 1500);
});

test('cleanCaption strips hashtag lines and links the model added anyway', () => {
  const c = cleanCaption('Stay healthy.\nBook: https://wa.me/123\n#Pune #Health');
  assert.equal(c, 'Stay healthy.\nBook:');
});
