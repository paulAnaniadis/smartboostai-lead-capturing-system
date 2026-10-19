import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePhones, normalizeEmails, normalizeName, messageHash, nameTokens,
  propertyRefFromCode, propertyRefFromUrl,
} from '../src/index.js';

test('τηλέφωνα: ελληνικές μορφές → E.164', () => {
  const inputs = ['6971234567', '00306971234567', '+30 697-123-4567', '0030 697 123 4567', '(+30) 697.123.4567'];
  for (const i of inputs) {
    assert.deepEqual(normalizePhones([i]).phones.map((p) => p.e164), ['+306971234567'], i);
  }
  assert.deepEqual(normalizePhones(['2101234567']).phones[0].e164, '+302101234567');
});

test('τηλέφωνα: Κύπρος με +357, και με default region CY', () => {
  assert.equal(normalizePhones(['+357 99 123456']).phones[0].e164, '+35799123456');
  assert.equal(normalizePhones(['99123456'], 'CY').phones[0].e164, '+35799123456');
});

test('τηλέφωνα: αμφίσημα δεν μαντεύονται', () => {
  const r = normalizePhones(['99123456', '697123456', '12']);
  assert.deepEqual(r.phones, []);
  assert.deepEqual(r.unparsed, ['99123456', '697123456', '12']);
});

test('τηλέφωνα: πολλά σε ένα πεδίο, χωρίς διπλά', () => {
  const r = normalizePhones(['6971234567 / 210 1234567 ή 6971234567']);
  assert.deepEqual(r.phones.map((p) => p.e164), ['+306971234567', '+302101234567']);
});

test('email: trim + lowercase, χωρίς «έξυπνα» κόλπα', () => {
  const r = normalizeEmails(['  John.Doe+x@GMAIL.com ', 'όχι email']);
  assert.deepEqual(r.emails, [{ value: 'john.doe+x@gmail.com', raw: 'John.Doe+x@GMAIL.com' }]);
  assert.deepEqual(r.invalid, ['όχι email']);
});

test('όνομα: ονοματεπώνυμο σε ένα πεδίο', () => {
  assert.deepEqual(normalizeName({ name: '  Μαρία   Κωνσταντίνου ' }), {
    full_name_raw: 'Μαρία Κωνσταντίνου', first_name: 'Μαρία', last_name: 'Κωνσταντίνου',
    name_tokens: ['maria', 'konstantinou'],
  });
});

test('όνομα: Γιώργος == Giorgos, Χρήστος == Christos, Ευάγγελος == Evangelos', () => {
  assert.deepEqual(nameTokens('Γιώργος Παπαδόπουλος'), nameTokens('Giorgos Papadopoulos'));
  assert.deepEqual(nameTokens('Χρήστος'), ['christos']);
  assert.deepEqual(nameTokens('Ευάγγελος'), ['evangelos']);
});

test('message hash: αγνοεί κεφαλαία, τόνους και κενά', () => {
  assert.equal(messageHash('Ενδιαφέρομαι  για το\nσπίτι'), messageHash('ενδιαφερομαι για το σπιτι '));
  assert.notEqual(messageHash('α'), messageHash('β'));
  assert.equal(messageHash(null), messageHash(''));
});

test('property_ref: κωδικός και URL σε κανονική μορφή', () => {
  assert.equal(propertyRefFromCode('site', ' kal-102 '), 'site:KAL-102');
  assert.equal(propertyRefFromUrl('https://WWW.Site.gr/Akinita/X/?utm=1#top'), 'url:site.gr/akinita/x');
  assert.equal(propertyRefFromUrl('site.gr/akinita/x/'), 'url:site.gr/akinita/x');
  assert.equal(propertyRefFromUrl('όχι url'), null);
});
