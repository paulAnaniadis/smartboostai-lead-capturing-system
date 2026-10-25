// Integration tests για τις functions της βάσης. Τρέχουν με scripts/test-db.sh,
// που στήνει προσωρινή Postgres και ορίζει DATABASE_URL.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { normalizeCandidate, processEmail } from '../../lead-core/src/index.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
after(() => pool.end());

const q = async (sql, params = []) => (await pool.query(sql, params)).rows;
const one = async (sql, params = []) => (await q(sql, params))[0];

const T0 = new Date('2026-10-19T08:00:00Z');
const hoursLater = (h) => new Date(T0.getTime() + h * 3600_000).toISOString();

// Νέος δοκιμαστικός πελάτης ανά test, ώστε τα tests να μην επηρεάζουν το ένα το άλλο.
async function newClient(region = 'GR') {
  const slug = `t-${randomUUID().slice(0, 8)}`;
  const c = await one(
    `insert into leads.clients (slug, name, default_region, notify_emails, notify_mode)
     values ($1, $1, $2, array['agent@example.com'], 'all') returning *`, [slug, region]);
  await q(`insert into leads.source_accounts (client_id, channel, identifier) values ($1, 'gmail', $2)`,
    [c.id, `leads+${slug}@example.com`]);
  await q(`insert into leads.email_routes (client_id, source, parser, match_from, priority)
           values ($1, 'spitogatos', 'spitogatos_v1', array['@spitogatos.gr'], 50),
                  ($1, 'website', 'website_form_v1', array['@demo-akinita.example'], 50)`, [c.id]);
  return { ...c, recipient: `leads+${slug}@example.com` };
}

async function capture(client, { externalId = randomUUID(), at = T0.toISOString(), payload = {} } = {}) {
  return one(`select * from leads.capture_raw_event('gmail', $1, $2, $3, $4)`,
    [externalId, client.recipient, at, payload]);
}

function lead({ phones = [], emails = [], name = 'Μαρία Κωνσταντίνου', refs = [], message = 'Ενδιαφέρομαι', source = 'spitogatos' } = {}) {
  return normalizeCandidate(
    { name, phones_raw: phones, emails_raw: emails, message, property_refs: refs, context: {} },
    { source, parser: 'spitogatos_v1' });
}

async function ingest(client, l, opts) {
  const raw = await capture(client, opts);
  const res = await one(`select leads.ingest_lead($1, $2) as r`, [raw.raw_event_id, l]);
  return { rawId: raw.raw_event_id, ...res.r };
}

const contactsOf = (client) => q(`select * from leads.contacts where client_id = $1 order by created_at`, [client.id]);
const inquiriesOf = (client) => q(`select * from leads.inquiries where client_id = $1 order by id`, [client.id]);
const reviewsOf = (client) => q(`select * from leads.review_queue where client_id = $1 order by id`, [client.id]);
const outboxOf = (client) => q(`select * from leads.outbox where client_id = $1 order by id`, [client.id]);

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

test('capture: το ίδιο γεγονός δεν μπαίνει δύο φορές', async () => {
  const c = await newClient();
  const a = await capture(c, { externalId: '<same@x>' });
  const b = await capture(c, { externalId: '<same@x>' });
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(a.raw_event_id, b.raw_event_id);
  assert.equal(a.client_id, c.id);
});

test('capture: άγνωστος παραλήπτης → needs_review + unknown_recipient, δεν γίνεται claim', async () => {
  const ext = `<unknown-${randomUUID()}@x>`;
  const r = await one(`select * from leads.capture_raw_event('gmail', $1, 'leads+nobody@example.com', now(), '{}')`, [ext]);
  assert.equal(r.client_id, null);
  const raw = await one(`select status from leads.raw_events where id = $1`, [r.raw_event_id]);
  assert.equal(raw.status, 'needs_review');
  const rq = await one(`select kind, blocking from leads.review_queue where raw_event_id = $1`, [r.raw_event_id]);
  assert.deepEqual(rq, { kind: 'unknown_recipient', blocking: true });
  const again = await one(`select * from leads.capture_raw_event('gmail', $1, 'leads+nobody@example.com', now(), '{}')`, [ext]);
  assert.equal(again.created, false);
});

test('capture: email χωρίς διεύθυνση πελάτη (σκέτο mailbox) → σώζεται ως ignored, χωρίς review', async () => {
  const r = await one(`select * from leads.capture_raw_event('gmail', $1, null, now(), $2)`,
    [`<bare-${randomUUID()}@x>`, { headers: { from: 'a@b.c', subject: 'προσωπικό' }, text: 'ιδιωτικό περιεχόμενο', html: '<p>x</p>' }]);
  assert.equal(r.created, true);
  const raw = await one(`select status, last_error, payload from leads.raw_events where id = $1`, [r.raw_event_id]);
  assert.equal(raw.status, 'ignored');
  assert.deepEqual(Object.keys(raw.payload), ['headers']);
  const rq = await q(`select 1 from leads.review_queue where raw_event_id = $1`, [r.raw_event_id]);
  assert.equal(rq.length, 0);
});

// ---------------------------------------------------------------------------
// Ταυτοποίηση
// ---------------------------------------------------------------------------

test('νέος άνθρωπος → contact + identifiers + inquiry + outbox', async () => {
  const c = await newClient();
  const r = await ingest(c, lead({ phones: ['6981234567'], emails: ['Maria.K@example.com'], refs: ['spitogatos:111'] }));
  assert.equal(r.status, 'processed');
  assert.equal(r.contact_created, true);
  const ids = await q(`select kind, value_normalized from leads.contact_identifiers where contact_id = $1 order by kind`, [r.contact_id]);
  assert.deepEqual(ids, [{ kind: 'email', value_normalized: 'maria.k@example.com' }, { kind: 'phone', value_normalized: '+306981234567' }]);
  assert.equal((await inquiriesOf(c)).length, 1);
  assert.equal((await outboxOf(c)).length, 1);
  const raw = await one(`select status, source, parser_version from leads.raw_events where id = $1`, [r.rawId]);
  assert.equal(raw.status, 'processed');
  assert.equal(raw.source, 'spitogatos');
});

test('ίδιος άνθρωπος με νέο identifier → attach, προστίθεται το email, τίποτα δεν γίνεται overwrite', async () => {
  const c = await newClient();
  const a = await ingest(c, lead({ phones: ['6981234567'], name: 'Μαρία' }));
  const b = await ingest(c, lead({ phones: ['+30 698 123 4567'], emails: ['maria@example.com'], name: 'Μαρία Κ.', refs: ['spitogatos:2'] }));
  assert.equal(b.contact_created, false);
  assert.equal(b.contact_id, a.contact_id);
  assert.equal((await contactsOf(c)).length, 1);
  const ct = (await contactsOf(c))[0];
  assert.equal(ct.full_name_raw, 'Μαρία');
  assert.equal(ct.last_name, 'Κ.'); // ήταν κενό, συμπληρώθηκε
  const ids = await q(`select kind from leads.contact_identifiers where contact_id = $1 order by kind`, [a.contact_id]);
  assert.deepEqual(ids.map((i) => i.kind), ['email', 'phone']);
});

test('τηλέφωνο → Α, email → Β: attach στο τηλέφωνο, possible_merge, κανένα αυτόματο merge', async () => {
  const c = await newClient();
  const A = await ingest(c, lead({ phones: ['6981111111'], name: 'Νίκος Παππάς' }));
  const B = await ingest(c, lead({ emails: ['shared@example.com'], name: 'Ελένη Παππά' }));
  const r = await ingest(c, lead({ phones: ['6981111111'], emails: ['shared@example.com'], name: 'Νίκος Παππάς', refs: ['spitogatos:9'] }));
  assert.equal(r.contact_id, A.contact_id);
  assert.deepEqual(r.reviews.map((x) => x.kind), ['possible_merge']);
  const rq = (await reviewsOf(c)).find((x) => x.kind === 'possible_merge');
  assert.equal(rq.contact_id, A.contact_id);
  assert.equal(rq.related_contact_id, B.contact_id);
  assert.equal(rq.blocking, false);
  // Το email μένει στον Β.
  const owner = await one(`select contact_id from leads.contact_identifiers where client_id = $1 and value_normalized = 'shared@example.com'`, [c.id]);
  assert.equal(owner.contact_id, B.contact_id);
  assert.equal((await contactsOf(c)).length, 2);
});

test('ίδιο τηλέφωνο με εντελώς διαφορετικό όνομα → attach + name_mismatch. Γιώργος/Giorgos δεν είναι mismatch', async () => {
  const c = await newClient();
  await ingest(c, lead({ phones: ['6982222222'], name: 'Γιώργος Παπαδόπουλος' }));
  const ok = await ingest(c, lead({ phones: ['6982222222'], name: 'Giorgos', refs: ['spitogatos:1'] }));
  assert.deepEqual(ok.reviews, []);
  const bad = await ingest(c, lead({ phones: ['6982222222'], name: 'Αικατερίνη Σταύρου', refs: ['spitogatos:2'] }));
  assert.deepEqual(bad.reviews.map((x) => x.kind), ['name_mismatch']);
  assert.equal((await contactsOf(c)).length, 1);
});

test('το ίδιο τηλέφωνο σε δύο πελάτες → δύο ανεξάρτητοι contacts', async () => {
  const c1 = await newClient();
  const c2 = await newClient();
  const a = await ingest(c1, lead({ phones: ['6983333333'] }));
  const b = await ingest(c2, lead({ phones: ['6983333333'] }));
  assert.equal(a.contact_created, true);
  assert.equal(b.contact_created, true);
  assert.notEqual(a.contact_id, b.contact_id);
});

// ---------------------------------------------------------------------------
// Inquiry dedup
// ---------------------------------------------------------------------------

test('διπλό email του portal μέσα σε 48 ώρες → touch, χωρίς νέα ειδοποίηση', async () => {
  const c = await newClient();
  const l = lead({ phones: ['6984444444'], refs: ['spitogatos:555'] });
  const a = await ingest(c, l, { at: hoursLater(0) });
  const b = await ingest(c, l, { at: hoursLater(3) }); // άλλο Message-ID, ίδιο lead
  assert.equal(b.inquiries[0].action, 'touch');
  assert.equal(b.inquiries[0].id, a.inquiries[0].id);
  const [inq] = await inquiriesOf(c);
  assert.equal(inq.touch_count, 2);
  assert.equal(new Date(inq.last_touch_at).toISOString(), hoursLater(3));
  assert.equal((await outboxOf(c)).length, 1);
});

test('reprocess του ίδιου raw δεν ξαναμετράει', async () => {
  const c = await newClient();
  const l = lead({ phones: ['6985555555'], refs: ['spitogatos:1'] });
  await ingest(c, l);
  const b = await ingest(c, l, { at: hoursLater(1) });
  const again = await one(`select leads.ingest_lead($1, $2) as r`, [b.rawId, l]);
  assert.equal(again.r.status, 'already_processed');
  assert.equal((await inquiriesOf(c))[0].touch_count, 2);
});

test('διαφορετικό ακίνητο → νέο inquiry στον ίδιο contact', async () => {
  const c = await newClient();
  await ingest(c, lead({ phones: ['6986666666'], refs: ['spitogatos:1'] }));
  const b = await ingest(c, lead({ phones: ['6986666666'], refs: ['spitogatos:2'] }), { at: hoursLater(1) });
  assert.equal(b.inquiries[0].action, 'created');
  assert.equal((await inquiriesOf(c)).length, 2);
  assert.equal((await contactsOf(c)).length, 1);
  assert.equal((await outboxOf(c)).length, 2);
});

test('ίδιο ακίνητο μετά από 48 ώρες → νέο inquiry με is_returning', async () => {
  const c = await newClient();
  const l = lead({ phones: ['6987777777'], refs: ['site:KAL-102'], source: 'website' });
  await ingest(c, l, { at: hoursLater(0) });
  const b = await ingest(c, l, { at: hoursLater(50) });
  assert.equal(b.inquiries[0].action, 'created');
  assert.equal(b.inquiries[0].is_returning, true);
  // Το παράθυρο μετράει από το πρώτο, όχι από το τελευταίο touch:
  const c2 = await newClient();
  await ingest(c2, l, { at: hoursLater(0) });
  await ingest(c2, l, { at: hoursLater(40) }); // touch
  const late = await ingest(c2, l, { at: hoursLater(60) });
  assert.equal(late.inquiries[0].action, 'created');
});

test('χωρίς property_ref: ίδιο μήνυμα → touch, άλλο μήνυμα → νέο inquiry', async () => {
  const c = await newClient();
  await ingest(c, lead({ emails: ['x@example.com'], message: 'Θέλω πληροφορίες' }));
  const same = await ingest(c, lead({ emails: ['x@example.com'], message: '  θέλω   ΠΛΗΡΟΦΟΡΊΕΣ ' }), { at: hoursLater(1) });
  assert.equal(same.inquiries[0].action, 'touch');
  const other = await ingest(c, lead({ emails: ['x@example.com'], message: 'Και για οικόπεδο;' }), { at: hoursLater(2) });
  assert.equal(other.inquiries[0].action, 'created');
});

test('πολλά ακίνητα σε ένα γεγονός → ένα inquiry ανά ακίνητο, στο ίδιο raw', async () => {
  const c = await newClient();
  const r = await ingest(c, lead({ phones: ['6988888888'], refs: ['spitogatos:1', 'spitogatos:2', 'spitogatos:1'] }));
  assert.equal(r.inquiries.length, 2);
  const links = await q(`select count(*)::int n from leads.inquiry_events where raw_event_id = $1`, [r.rawId]);
  assert.equal(links[0].n, 2);
});

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

test('χωρίς τηλέφωνο και email → needs_review (no_identifier), κανένας contact', async () => {
  const c = await newClient();
  const r = await ingest(c, lead({ name: 'Νίκος' }));
  assert.deepEqual([r.status, r.review], ['needs_review', 'no_identifier']);
  assert.equal((await contactsOf(c)).length, 0);
  const [rq] = await reviewsOf(c);
  assert.equal(rq.blocking, true);
});

test('placeholder στοιχεία: μόνα τους → review, μαζί με πραγματικά → αγνοούνται', async () => {
  const c = await newClient();
  const r = await ingest(c, lead({ emails: ['test@test.com'], phones: ['6900000000'] }));
  assert.deepEqual([r.status, r.review], ['needs_review', 'placeholder']);
  const ok = await ingest(c, lead({ emails: ['test@test.com', 'real@example.com'] }));
  assert.equal(ok.status, 'processed');
  assert.deepEqual(ok.dropped_placeholders, ['test@test.com']);
  const ids = await q(`select value_normalized from leads.contact_identifiers where client_id = $1`, [c.id]);
  assert.deepEqual(ids.map((i) => i.value_normalized), ['real@example.com']);
});

test('resolve_review: ingest_manual με διορθωμένα στοιχεία, και merge', async () => {
  const c = await newClient();
  const r = await ingest(c, lead({ name: 'Νίκος' }));
  const [rq] = await reviewsOf(c);
  const fixed = lead({ name: 'Νίκος', phones: ['6981212121'] });
  const res = await one(`select leads.resolve_review($1, 'ingest_manual', $2, 'paul') as r`, [rq.id, fixed]);
  assert.equal(res.r.result.status, 'processed');
  const raw = await one(`select status from leads.raw_events where id = $1`, [r.rawId]);
  assert.equal(raw.status, 'processed');
  assert.equal((await one(`select status from leads.review_queue where id = $1`, [rq.id])).status, 'resolved');

  // merge
  const A = await ingest(c, lead({ phones: ['6981313131'], name: 'Άννα Λ' }));
  const B = await ingest(c, lead({ emails: ['anna@example.com'], name: 'Άννα Λ' }));
  await ingest(c, lead({ phones: ['6981313131'], emails: ['anna@example.com'], name: 'Άννα Λ', refs: ['spitogatos:3'] }));
  const pm = (await reviewsOf(c)).find((x) => x.kind === 'possible_merge');
  await q(`select leads.resolve_review($1, 'merge', '{}', 'paul')`, [pm.id]);
  const ids = await q(`select distinct contact_id from leads.contact_identifiers where client_id = $1 and value_normalized in ('+306981313131','anna@example.com')`, [c.id]);
  assert.deepEqual(ids.map((i) => i.contact_id), [A.contact_id]);
  const merged = await one(`select merged_into from leads.contacts where id = $1`, [B.contact_id]);
  assert.equal(merged.merged_into, A.contact_id);
});

// ---------------------------------------------------------------------------
// Ταυτόχρονα ingestions
// ---------------------------------------------------------------------------

test('δύο ταυτόχρονα ingestions του ίδιου ανθρώπου → ένας contact', async () => {
  const c = await newClient();
  const raws = await Promise.all([...Array(6)].map(() => capture(c)));
  const leads = raws.map((_, i) => lead({ phones: ['6989999999'], emails: [i % 2 ? 'same@example.com' : 'same@example.com'], refs: [`spitogatos:${i}`] }));
  await Promise.all(raws.map((r, i) => pool.query(`select leads.ingest_lead($1, $2)`, [r.raw_event_id, leads[i]])));
  assert.equal((await contactsOf(c)).length, 1);
  assert.equal((await inquiriesOf(c)).length, 6);
});

// ---------------------------------------------------------------------------
// Retries, leases, outbox
// ---------------------------------------------------------------------------

test('claim → failed με backoff → dead μετά από 5 προσπάθειες, με alert', async () => {
  const c = await newClient();
  const raw = await capture(c);
  let last;
  for (let i = 1; i <= 5; i++) {
    await q(`update leads.raw_events set next_attempt_at = now() - interval '1 second' where id = $1`, [raw.raw_event_id]);
    const claimed = await q(`select * from leads.claim_raw_events(100)`);
    const mine = claimed.find((x) => x.raw_event_id === raw.raw_event_id);
    assert.ok(mine, `claimed on attempt ${i}`);
    assert.equal(mine.attempts, i);
    assert.equal(mine.client.slug, c.slug);
    assert.equal(mine.routes.length, 2);
    last = (await one(`select leads.mark_raw_failed($1, 'timeout') as r`, [raw.raw_event_id])).r;
  }
  assert.deepEqual([last.status, last.alert], ['dead', true]);
  const claimedAfter = await q(`select raw_event_id from leads.claim_raw_events(100)`);
  assert.ok(!claimedAfter.some((x) => x.raw_event_id === raw.raw_event_id));
});

test('processing με ληγμένο lease ξαναπιάνεται (το n8n έπεσε στη μέση)', async () => {
  const c = await newClient();
  const raw = await capture(c);
  await q(`select * from leads.claim_raw_events(100)`);
  const notYet = await q(`select raw_event_id from leads.claim_raw_events(100)`);
  assert.ok(!notYet.some((x) => x.raw_event_id === raw.raw_event_id));
  await q(`update leads.raw_events set locked_until = now() - interval '1 second' where id = $1`, [raw.raw_event_id]);
  const again = await q(`select raw_event_id, attempts from leads.claim_raw_events(100)`);
  assert.equal(again.find((x) => x.raw_event_id === raw.raw_event_id)?.attempts, 2);
});

test('outbox: claim δίνει έτοιμο item, sent δεν ξαναστέλνεται', async () => {
  const c = await newClient();
  await ingest(c, lead({ phones: ['6981414141'], emails: ['o@example.com'], refs: ['spitogatos:77'] }));
  const items = (await q(`select * from leads.claim_outbox(100)`)).filter((x) => x.item.client.id === c.id);
  assert.equal(items.length, 1);
  const { item } = items[0];
  assert.deepEqual(item.client.notify_emails, ['agent@example.com']);
  assert.deepEqual(item.contact.phones, ['+306981414141']);
  assert.equal(item.inquiry.property_ref, 'spitogatos:77');
  await q(`select leads.mark_outbox_sent($1)`, [items[0].outbox_id]);
  await q(`update leads.outbox set next_attempt_at = now() - interval '1 day' where id = $1`, [items[0].outbox_id]);
  const again = (await q(`select * from leads.claim_outbox(100)`)).filter((x) => x.item.client.id === c.id);
  assert.equal(again.length, 0);
});

test('notify_mode none (default): καταγραφή χωρίς ειδοποίηση στον agent', async () => {
  const c = await newClient();
  await q(`update leads.clients set notify_mode = 'none' where id = $1`, [c.id]);
  const r = await ingest(c, lead({ phones: ['6981717171'], refs: ['spitogatos:5'] }));
  assert.equal(r.status, 'processed');
  assert.equal((await inquiriesOf(c)).length, 1);
  assert.equal((await outboxOf(c)).length, 0);
  const fresh = await one(`insert into leads.clients (slug, name) values ($1, $1) returning notify_mode`, [`t-${randomUUID().slice(0, 8)}`]);
  assert.equal(fresh.notify_mode, 'none');
});

// ---------------------------------------------------------------------------
// Από άκρη σε άκρη: fixture email → lead-core → βάση
// ---------------------------------------------------------------------------

test('end-to-end: email Σπιτόγατου → processEmail → ingest_lead', async () => {
  const c = await newClient();
  const payload = {
    headers: { from: 'Spitogatos <noreply@spitogatos.gr>', subject: 'Νέο μήνυμα', message_id: '<e2e@x>' },
    text: 'Ονοματεπώνυμο: Πέτρος Ιωάννου\nΤηλέφωνο: 6945 000 111\nΚωδικός αγγελίας: 24681357\nΜήνυμα: Ενδιαφέρομαι',
  };
  const raw = await capture(c, { externalId: '<e2e@x>', payload });
  const [claimed] = (await q(`select * from leads.claim_raw_events(100)`)).filter((x) => x.raw_event_id === raw.raw_event_id);
  const decision = processEmail(claimed.payload, { client: claimed.client, routes: claimed.routes });
  assert.equal(decision.action, 'ingest');
  const res = (await one(`select leads.ingest_lead($1, $2) as r`, [claimed.raw_event_id, decision.lead])).r;
  assert.equal(res.status, 'processed');
  const [inq] = await inquiriesOf(c);
  assert.equal(inq.property_ref, 'spitogatos:24681357');
  assert.equal(inq.source, 'spitogatos');
});

// ---------------------------------------------------------------------------
// Δικαιώματα, GDPR, alerts
// ---------------------------------------------------------------------------

test('n8n_app: εκτελεί functions, δεν διαβάζει πίνακες', async () => {
  const conn = await pool.connect();
  try {
    await conn.query('set role n8n_app');
    await assert.rejects(conn.query('select * from leads.contacts limit 1'), /permission denied/);
    await assert.rejects(conn.query('select leads._client_lock(gen_random_uuid())'), /permission denied/);
    const r = await conn.query('select leads.daily_report() as r');
    assert.ok(r.rows[0].r.generated_at);
  } finally {
    await conn.query('reset role');
    conn.release();
  }
});

test('erase_contact: σβήνει contact, inquiries και payloads', async () => {
  const c = await newClient();
  const r = await ingest(c, lead({ phones: ['6981515151'] }), { payload: { secret: 'personal data' } });
  await q(`select leads.erase_contact($1)`, [r.contact_id]);
  assert.equal((await contactsOf(c)).length, 0);
  assert.equal((await inquiriesOf(c)).length, 0);
  const raw = await one(`select payload, payload_purged_at from leads.raw_events where id = $1`, [r.rawId]);
  assert.deepEqual(raw.payload, {});
  assert.ok(raw.payload_purged_at);
});

test('ops alert: το ίδιο key το πολύ μία φορά τη μέρα', async () => {
  const key = `test:${randomUUID()}`;
  assert.equal((await one(`select leads.ops_alert_should_send($1) as s`, [key])).s, true);
  assert.equal((await one(`select leads.ops_alert_should_send($1) as s`, [key])).s, false);
  await q(`update leads.ops_alerts set last_sent_at = now() - interval '25 hours' where key = $1`, [key]);
  assert.equal((await one(`select leads.ops_alert_should_send($1) as s`, [key])).s, true);
});

test('heartbeat: σιωπηλή πηγή → alert', async () => {
  const c = await newClient();
  await q(`update leads.email_routes set heartbeat_max_silence = interval '3 days', created_at = now() - interval '10 days'
           where client_id = $1 and source = 'spitogatos'`, [c.id]);
  const rows = (await q(`select * from leads.heartbeat_report()`)).filter((x) => x.client_slug === c.slug);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].alert, true);
  await ingest(c, lead({ phones: ['6981616161'] }), { at: new Date().toISOString() });
  const after = (await q(`select * from leads.heartbeat_report()`)).find((x) => x.client_slug === c.slug);
  assert.equal(after.alert, false);
});
