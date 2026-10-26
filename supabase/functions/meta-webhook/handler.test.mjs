import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { handleMetaWebhook, eventsFromWebhook } from './handler.js';
import { captureArgsFromLeadgenChange } from '../../../lead-core/src/index.js';

const SECRET = 'app-secret';
const sign = (body) => 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex');
const leadgenBody = {
  object: 'page',
  entry: [{ id: '111', time: 1792919700, changes: [{ field: 'leadgen', value: {
    ad_id: '120211111111111111', form_id: '987654321', leadgen_id: '1234567890123456',
    created_time: 1792919700, page_id: '111', adgroup_id: '120200000000000000',
  } }] }],
};

async function call(method, body, { signature, query = '' } = {}) {
  const captured = [];
  const raw = body === undefined ? undefined : JSON.stringify(body);
  const req = new Request(`https://x.supabase.co/functions/v1/meta-webhook${query}`, {
    method, body: raw, headers: signature === false ? {} : { 'x-hub-signature-256': signature ?? sign(raw ?? '') },
  });
  const res = await handleMetaWebhook(req, { appSecret: SECRET, verifyToken: 'vt', capture: async (e) => captured.push(e) });
  return { status: res.status, text: await res.text(), captured };
}

test('GET: επιβεβαίωση συνδρομής μόνο με σωστό verify token', async () => {
  const ok = await call('GET', undefined, { query: '?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=42' });
  assert.deepEqual([ok.status, ok.text], [200, '42']);
  const bad = await call('GET', undefined, { query: '?hub.mode=subscribe&hub.verify_token=no&hub.challenge=42' });
  assert.equal(bad.status, 403);
});

test('POST χωρίς ή με λάθος υπογραφή → 401, τίποτα δεν σώζεται', async () => {
  assert.equal((await call('POST', leadgenBody, { signature: false })).status, 401);
  const r = await call('POST', leadgenBody, { signature: 'sha256=' + '0'.repeat(64) });
  assert.equal(r.status, 401);
  assert.equal(r.captured.length, 0);
});

test('Facebook leadgen → capture με τα ίδια ορίσματα που περιμένει ο lead-core', async () => {
  const r = await call('POST', leadgenBody);
  assert.equal(r.status, 200);
  assert.equal(r.captured.length, 1);
  assert.deepEqual(r.captured[0], captureArgsFromLeadgenChange(leadgenBody.entry[0].changes[0].value));
});

test('WhatsApp: εισερχόμενα και echoes σώζονται, τα statuses όχι', () => {
  const evs = eventsFromWebhook({
    object: 'whatsapp_business_account',
    entry: [{ id: 'waba', changes: [
      { field: 'messages', value: {
        metadata: { phone_number_id: '555' },
        contacts: [{ wa_id: '306977123456', profile: { name: 'Νίκος' } }],
        messages: [{ id: 'wamid.A', from: '306977123456', timestamp: '1792919700', type: 'text', text: { body: 'Καλησπέρα' } }],
        statuses: [{ id: 'wamid.S', status: 'read' }],
      } },
      { field: 'smb_message_echoes', value: {
        metadata: { phone_number_id: '555' },
        message_echoes: [{ id: 'wamid.E', from: '30210000000', to: '306977123456', timestamp: '1792919760', type: 'text', text: { body: 'Γεια σας!' } }],
      } },
    ] }],
  });
  assert.deepEqual(evs.map((e) => [e.channel, e.external_id, e.recipient, e.payload.direction]),
    [['whatsapp', 'wamid.A', '555', 'in'], ['whatsapp', 'wamid.E', '555', 'echo']]);
  assert.equal(evs[0].payload.contact.profile.name, 'Νίκος');
});

test('αποτυχία βάσης → 500 (η Meta ξαναστέλνει)', async () => {
  const raw = JSON.stringify(leadgenBody);
  const req = new Request('https://x/f', { method: 'POST', body: raw, headers: { 'x-hub-signature-256': sign(raw) } });
  const res = await handleMetaWebhook(req, { appSecret: SECRET, verifyToken: 'vt', capture: async () => { throw new Error('db down'); } });
  assert.equal(res.status, 500);
});
