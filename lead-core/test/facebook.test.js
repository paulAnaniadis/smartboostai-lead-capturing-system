import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processFacebookLead, captureArgsFromLeadgenChange, captureArgsFromPolledLead } from '../src/index.js';

// ΕΙΚΟΝΙΚΟ lead, στη μορφή του Graph API (GET /{leadgen_id}).
const graphLead = {
  id: '1234567890123456',
  created_time: '2026-10-26T09:15:00+0000',
  ad_id: '120211111111111111', ad_name: 'Βίλα Πανόραμα - Carousel',
  adset_name: 'Θεσσαλονίκη 35-60', campaign_name: 'Πωλήσεις Q4',
  form_id: '987654321', platform: 'ig', is_organic: false,
  field_data: [
    { name: 'full_name', values: ['Ελένη Παπαδοπούλου'] },
    { name: 'phone_number', values: ['+306977123456'] },
    { name: 'email', values: ['Eleni.P@Example.com'] },
    { name: 'πότε_θέλετε_να_σας_καλέσουμε;', values: ['Απόγευμα'] },
    { name: 'μήνυμα', values: ['Ενδιαφέρομαι για επίσκεψη'] },
  ],
};

test('Facebook lead → κανονικοποιημένο lead', () => {
  const d = processFacebookLead({ via: 'poll', lead: graphLead }, { client: { default_region: 'GR' } });
  assert.equal(d.action, 'ingest');
  const l = d.lead;
  assert.equal(l.source, 'facebook');
  assert.equal(l.full_name_raw, 'Ελένη Παπαδοπούλου');
  assert.deepEqual(l.phones.map((p) => p.e164), ['+306977123456']);
  assert.deepEqual(l.emails.map((e) => e.value), ['eleni.p@example.com']);
  assert.equal(l.message, 'Ενδιαφέρομαι για επίσκεψη');
  assert.deepEqual(l.property_refs, ['fb_ad:120211111111111111']);
  assert.equal(l.context.campaign_name, 'Πωλήσεις Q4');
  assert.equal(l.context.platform, 'ig');
  assert.deepEqual(l.context.answers, { 'πότε_θέλετε_να_σας_καλέσουμε;': 'Απόγευμα' });
  assert.equal(l.parser_version.startsWith('facebook_v1@'), true);
});

test('Organic lead χωρίς διαφήμιση → fb_form', () => {
  const d = processFacebookLead({ lead: { ...graphLead, ad_id: undefined, is_organic: true } });
  assert.deepEqual(d.lead.property_refs, ['fb_form:987654321']);
});

test('Webhook χωρίς στοιχεία → fetch από το Graph API', () => {
  assert.deepEqual(processFacebookLead({ via: 'webhook', leadgen_id: '55' }), { action: 'fetch', leadgen_id: '55' });
  assert.equal(processFacebookLead({ via: 'webhook' }).action, 'review');
});

test('capture args από webhook και από reconciliation έχουν το ΙΔΙΟ external_id (dedup)', () => {
  // Η Meta στέλνει τα ids ως strings (είναι πολύ μεγάλα για αριθμούς JS).
  const w = captureArgsFromLeadgenChange({ leadgen_id: '1234567890123456', page_id: '111', form_id: '987654321', ad_id: '120211111111111111', created_time: 1792919700 });
  const p = captureArgsFromPolledLead(graphLead, '111');
  assert.equal(w.external_id, p.external_id);
  assert.equal(w.channel, p.channel);
  assert.equal(w.recipient, '111');
  assert.equal(p.occurred_at, '2026-10-26T09:15:00.000Z');
});
