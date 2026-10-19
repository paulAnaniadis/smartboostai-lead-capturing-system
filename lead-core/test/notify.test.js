import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderAgentEmail, buildOpsAlerts } from '../src/index.js';

const item = {
  client: { slug: 'demo', notify_emails: ['agent1@example.com', 'agent2@example.com'] },
  inquiry: {
    source: 'spitogatos', property_ref: 'spitogatos:12345678', message: 'Είναι διαθέσιμο;\n<script>',
    first_seen_at: '2026-10-19T08:30:00Z', is_returning: false,
  },
  contact: {
    full_name_raw: 'Μαρία Κωνσταντίνου', phones: ['+306981234567'], emails: ['maria.k@example.com'], previous_inquiries: 0,
  },
  flags: [],
};

test('email agent: θέμα, παραλήπτες, reply-to στον ενδιαφερόμενο, escaping', () => {
  const m = renderAgentEmail(item);
  assert.equal(m.to, 'agent1@example.com,agent2@example.com');
  assert.equal(m.reply_to, 'maria.k@example.com');
  assert.equal(m.subject, 'Νέο lead: Μαρία Κωνσταντίνου · Σπιτόγατος · Σπιτόγατος #12345678');
  assert.match(m.html, /href="tel:\+306981234567"/);
  assert.match(m.html, /&lt;script&gt;/);
  assert.doesNotMatch(m.html, /<script>/);
  assert.match(m.html, /19\/10\/(20)?26/); // ώρα Ελλάδας
  assert.match(m.html, /11:30/);
});

test('email agent: επανερχόμενος, flags, χωρίς email', () => {
  const m = renderAgentEmail({
    ...item,
    inquiry: { ...item.inquiry, is_returning: true, property_ref: null },
    contact: { ...item.contact, emails: [], previous_inquiries: 2 },
    flags: ['possible_merge'],
  });
  assert.match(m.subject, /^Επανήλθε: Μαρία Κωνσταντίνου · Σπιτόγατος$/);
  assert.equal(m.reply_to, null);
  assert.match(m.html, /Γενικό ενδιαφέρον/);
  assert.match(m.html, /άλλες 2 φορές/);
  assert.match(m.text, /ταιριάζει και με άλλη επαφή/);
});

test('alerts: μόνο ό,τι είναι πρόβλημα, με σταθερά keys', () => {
  const alerts = buildOpsAlerts({
    heartbeat: [
      { client_slug: 'demo', source: 'spitogatos', alert: true, last_seen_at: null, max_silence: '3 days' },
      { client_slug: 'demo', source: 'website', alert: false },
    ],
    staleReviews: [{ review_id: 7, kind: 'parse_failed', client_slug: 'demo', raw_event_id: 99, note: 'x' }],
    report: { dead_raw_events: 0, dead_outbox: 1 },
  });
  assert.deepEqual(alerts.map((a) => a.key), ['heartbeat:demo:spitogatos', 'stale_review:7', 'dead_outbox']);
  assert.deepEqual(buildOpsAlerts({ report: { dead_raw_events: 0, dead_outbox: 0 } }), []);
});
