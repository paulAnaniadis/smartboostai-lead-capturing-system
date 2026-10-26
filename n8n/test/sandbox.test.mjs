// Τρέχει τα Code nodes των workflows μέσα στο ίδιο sandbox (vm2) που χρησιμοποιεί
// το Code node του n8n 1.x, με ρεαλιστικά inputs. Πιάνει σφάλματα όπως
// «Operation not allowed on contextified object» πριν φτάσουν στον server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { NodeVM } = require('@n8n/vm2');
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'workflows');
const wf = (file) => JSON.parse(readFileSync(join(dir, file), 'utf8'));

// Όπως το JavaScriptSandbox του n8n: NodeVM χωρίς modules, ο κώδικας μέσα σε async function.
async function runCodeNode(workflow, nodeName, items, refs = {}) {
  const node = workflow.nodes.find((n) => n.name === nodeName);
  const wrap = (rows) => {
    const data = rows.map((json) => ({ json }));
    return { all: () => data, first: () => data[0], item: data[0] };
  };
  const input = wrap(items);
  const context = { $input: input, $: (name) => wrap(refs[name] ?? []), items: input.all() };
  const vm = new NodeVM({ console: 'off', sandbox: context, require: { builtin: [], external: false }, wasm: false });
  const out = await vm.run(`module.exports = async function() {${node.parameters.jsCode}\n}()`, import.meta.dirname);
  return JSON.parse(JSON.stringify(out)).map((i) => i.json);
}

const b64 = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const gmailMessage = {
  id: 'g1', threadId: 'g1', internalDate: String(Date.parse('2026-10-25T09:00:00Z')),
  payload: {
    mimeType: 'multipart/mixed',
    headers: [
      { name: 'From', value: 'Pavlos <pavlos@example.com>' },
      { name: 'To', value: 'gananos12+demo@gmail.com' },
      { name: 'Delivered-To', value: 'gananos12+demo@gmail.com' },
      { name: 'Subject', value: 'Δοκιμή' },
      { name: 'Message-ID', value: '<m1@example.com>' },
    ],
    parts: [
      { mimeType: 'multipart/alternative', parts: [
        { mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset="UTF-8"' }],
          body: { data: b64('Όνομα: Δοκιμή\nΕπίθετο: Τεστ\nEmail: test.lead@example.com\nΤηλέφωνο: 6971234560\nΕνδιαφέρον: Θέλω να δω το διαμέρισμα\nΚωδικός ακινήτου: TEST-1') } },
        { mimeType: 'text/html', headers: [{ name: 'Content-Type', value: 'text/html; charset=UTF-8' }],
          body: { data: b64('<p>Όνομα: Δοκιμή</p>') } },
      ] },
      { mimeType: 'image/png', filename: 'logo.png', body: { attachmentId: 'x', size: 3540 } },
    ],
  },
};

test('Capture → Prepare capture: Gmail API μήνυμα → capture args', async () => {
  const [out] = await runCodeNode(wf('1-capture-gmail.json'), 'Prepare capture', [gmailMessage],
    { Config: [{ lead_local_part: 'gananos12' }] });
  assert.equal(out.recipient, 'gananos12+demo@gmail.com');
  assert.equal(out.external_id, '<m1@example.com>');
  assert.equal(out.gmail_id, 'g1');
  assert.match(JSON.parse(out.payload_json).text, /Τηλέφωνο: 6971234560/);
});

test('Process → Decide: email → lead (με normalization τηλεφώνου και hash)', async () => {
  const [prep] = await runCodeNode(wf('1-capture-gmail.json'), 'Prepare capture', [gmailMessage],
    { Config: [{ lead_local_part: 'gananos12' }] });
  const claimed = {
    raw_event_id: 7, client_id: 'c', channel: 'gmail', external_id: prep.external_id, attempts: 1,
    payload: JSON.parse(prep.payload_json),
    client: { slug: 'demo', default_region: 'GR' },
    routes: [{ id: 1, source: 'website', parser: 'website_form_v1', match_from: ['pavlos@example.com'], match_subject: null, priority: 1 }],
  };
  const unknown = { ...claimed, raw_event_id: 8, routes: [] };
  const badPhone = structuredClone(claimed);
  badPhone.raw_event_id = 9;
  badPhone.payload.text = 'Όνομα: Χ\nΤηλέφωνο: 697 12 34 56\nEmail: x@example.com';
  const out = await runCodeNode(wf('2-process.json'), 'Decide', [claimed, unknown, badPhone, {}]);
  assert.deepEqual(out.map((o) => [o.raw_event_id, o.action]), [[7, 'ingest'], [8, 'review'], [9, 'ingest']]);
  const lead = JSON.parse(out[0].lead_json);
  assert.deepEqual(lead.phones, [{ e164: '+306971234560', raw: '6971234560' }]);
  assert.deepEqual(lead.property_refs, ['site:TEST-1']);
  assert.match(lead.message_hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(JSON.parse(out[2].lead_json).context.phones_unparsed, ['697 12 34 56']);
});

test('Notify → Render email', async () => {
  const item = {
    client: { slug: 'demo', notify_emails: ['agent@example.com'] },
    inquiry: { source: 'website', property_ref: 'site:TEST-1', message: 'Γεια', first_seen_at: '2026-10-25T09:00:00Z', is_returning: false },
    contact: { full_name_raw: 'Δοκιμή Τεστ', phones: ['+306971234560'], emails: [], previous_inquiries: 0 },
    flags: [],
  };
  const [out] = await runCodeNode(wf('3-notify-agents.json'), 'Render email', [{ outbox_id: 3, kind: 'new_inquiry', item }]);
  assert.equal(out.outbox_id, 3);
  assert.match(out.subject, /Νέο lead: Δοκιμή Τεστ/);
});

test('Monitor → Build alerts', async () => {
  const out = await runCodeNode(wf('4-monitor.json'), 'Build alerts', [{}], {
    Heartbeat: [{ client_slug: 'demo', source: 'spitogatos', alert: true, last_seen_at: null, max_silence: '7 days' }],
    'Stale reviews': [{}],
    Report: [{ report: { dead_raw_events: 0, dead_outbox: 0 } }],
  });
  assert.deepEqual(out.map((a) => a.key), ['heartbeat:demo:spitogatos']);
});

test('Όλα τα υπόλοιπα Code nodes φορτώνουν στο sandbox χωρίς σφάλμα σύνταξης/φόρτωσης', async () => {
  for (const file of ['0-errors.json', '1-capture-gmail.json', '2-process.json', '3-notify-agents.json', '4-monitor.json']) {
    const w = wf(file);
    for (const n of w.nodes.filter((x) => x.type === 'n8n-nodes-base.code')) {
      // Μόνο ότι ο κώδικας μεταφράζεται στο sandbox (τα inputs διαφέρουν ανά node).
      const vm = new NodeVM({ console: 'off', sandbox: {}, require: { builtin: [], external: false } });
      assert.doesNotThrow(() => vm.run(`module.exports = async function() {${n.parameters.jsCode}\n}`, import.meta.dirname), `${file} / ${n.name}`);
    }
  }
});

test('Capture → Collect saved ids: ένα αίτημα label για όλα τα emails', async () => {
  const out = await runCodeNode(wf('1-capture-gmail.json'), 'Collect saved ids',
    [{ gmail_id: 'a' }, { gmail_id: 'b' }, { gmail_id: 'a' }, { gmail_id: null }]);
  assert.deepEqual(out, [{ ids: ['a', 'b'] }]);
  assert.deepEqual(await runCodeNode(wf('1-capture-gmail.json'), 'Collect saved ids', []), []);
});

// ---------------------------------------------------------------------------
// Facebook
// ---------------------------------------------------------------------------
const fbLead = {
  id: '1234567890123456', created_time: '2026-10-26T09:15:00+0000',
  ad_id: '1202', ad_name: 'Βίλα', campaign_name: 'Q4', form_id: '987', platform: 'fb', is_organic: false,
  field_data: [
    { name: 'full_name', values: ['Ελένη Παπαδοπούλου'] },
    { name: 'phone_number', values: ['+306977123456'] },
    { name: 'email', values: ['eleni@example.com'] },
  ],
};

test('Facebook → Decide: webhook χωρίς στοιχεία → fetch, poll με στοιχεία → ingest', async () => {
  const out = await runCodeNode(wf('5-facebook.json'), 'Decide', [
    { raw_event_id: 1, channel: 'fb_leadgen', payload: { via: 'webhook', leadgen_id: '55', page_id: '111' }, client: { default_region: 'GR' } },
    { raw_event_id: 2, channel: 'fb_leadgen', payload: { via: 'poll', page_id: '111', lead: fbLead }, client: { default_region: 'GR' } },
    {},
  ]);
  assert.deepEqual(out.map((o) => [o.raw_event_id, o.action, o.leadgen_id, o.page_id]),
    [[1, 'fetch', '55', '111'], [2, 'ingest', null, '111']]);
  const lead = JSON.parse(out[1].lead_json);
  assert.deepEqual(lead.phones.map((x) => x.e164), ['+306977123456']);
  assert.deepEqual(lead.property_refs, ['fb_ad:1202']);
});

test('Facebook → After fetch: lead από Graph API → ingest στο σωστό raw_event_id', async () => {
  const out = await runCodeNode(wf('5-facebook.json'), 'After fetch', [fbLead, { id: 'x' }], {
    'Only fetch': [{ raw_event_id: 7, region: 'GR' }, { raw_event_id: 8, region: 'GR' }],
  });
  assert.deepEqual(out.map((o) => [o.raw_event_id, o.action]), [[7, 'ingest'], [8, 'failed']]);
});

test('Facebook reconciliation → Split forms και Prepare capture', async () => {
  const forms = await runCodeNode(wf('6-facebook-reconciliation.json'), 'Split forms',
    [{ data: [{ id: 'f1', name: 'Φόρμα 1' }, { id: 'f2', name: 'Φόρμα 2' }] }],
    { 'Facebook pages': [{ client_slug: 'demo', page_id: '111' }], 'Get page token': [{ access_token: 'PT' }] });
  assert.deepEqual(forms.map((f) => [f.page_id, f.form_id, f.access_token]), [['111', 'f1', 'PT'], ['111', 'f2', 'PT']]);
  assert.equal(JSON.parse(forms[0].filtering)[0].operator, 'GREATER_THAN');

  const caps = await runCodeNode(wf('6-facebook-reconciliation.json'), 'Prepare capture', [{ data: [fbLead] }, { data: [] }],
    { 'Split forms': forms });
  assert.equal(caps.length, 1);
  assert.deepEqual([caps[0].channel, caps[0].external_id, caps[0].recipient], ['fb_leadgen', '1234567890123456', '111']);
  assert.equal(JSON.parse(caps[0].payload_json).lead.form_name, 'Φόρμα 1');
});
