// Παράγει τα n8n workflows (n8n/workflows/*.json) για import στο n8n.
// Ο κώδικας του lead-core μπαίνει αυτούσιος (bundle) στα Code nodes που τον χρειάζονται,
// ώστε να μη χρειάζεται καμία αλλαγή στον server του n8n.
//
//   node scripts/build-n8n.mjs
//
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBundle } from './build-lead-core-bundle.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'n8n', 'workflows');

const CRED_GMAIL = { gmailOAuth2: { id: 'REPLACE_GMAIL', name: 'Leads Gmail' } };
const CRED_PG = { postgres: { id: 'REPLACE_POSTGRES', name: 'Leads Supabase' } };
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

// ---------------------------------------------------------------------------
// Βοηθητικά για nodes και connections
// ---------------------------------------------------------------------------

const uuid = (seed) => {
  const h = createHash('sha1').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

function workflow(name, build) {
  const nodes = [];
  const connections = {};
  let x = 0;
  const api = {
    add(nodeName, type, typeVersion, parameters, extra = {}) {
      const pos = extra.position ?? [x, extra.y ?? 0];
      if (!extra.position) x += 260;
      const { y, position, ...rest } = extra;
      nodes.push({ id: uuid(`${name}/${nodeName}`), name: nodeName, type, typeVersion, position: pos, parameters, ...rest });
      return nodeName;
    },
    link(from, to, output = 0) {
      connections[from] ??= { main: [] };
      while (connections[from].main.length <= output) connections[from].main.push([]);
      connections[from].main[output].push({ node: to, type: 'main', index: 0 });
    },
    chain(...names) {
      for (let i = 0; i < names.length - 1; i++) api.link(names[i], names[i + 1]);
    },
  };
  build(api);
  return {
    name,
    nodes,
    connections,
    settings: { executionOrder: 'v1', saveDataSuccessExecution: 'none', saveDataErrorExecution: 'all' },
    pinData: {},
    active: false,
  };
}

const schedule = (minutes) => ['n8n-nodes-base.scheduleTrigger', 1.2, {
  rule: { interval: [{ field: 'minutes', minutesInterval: minutes }] },
}];
const scheduleHours = (hours) => ['n8n-nodes-base.scheduleTrigger', 1.2, {
  rule: { interval: [{ field: 'hours', hoursInterval: hours }] },
}];
const scheduleDaily = (hour, minute) => ['n8n-nodes-base.scheduleTrigger', 1.2, {
  rule: { interval: [{ field: 'days', daysInterval: 1, triggerAtHour: hour, triggerAtMinute: minute }] },
}];

const code = (jsCode) => ['n8n-nodes-base.code', 2, { mode: 'runOnceForAllItems', language: 'javaScript', jsCode }];

// Postgres με παραμέτρους ($1, $2, …) από expression που επιστρέφει πίνακα.
// queryBatching=independently: κάθε item τρέχει σε δικό του transaction. Με το default
// («single») όλα τα items στέλνονται μαζί, και ένα σφάλμα ακυρώνει όλη την παρτίδα.
// Προσοχή: τιμές undefined παραλείπονται από το n8n και μετακινούν τα $N, γι' αυτό
// κάθε παράμετρος περνάει με «?? null».
const pg = (query, params) => ['n8n-nodes-base.postgres', 2.6, {
  operation: 'executeQuery',
  query,
  options: {
    queryBatching: 'independently',
    ...(params ? { queryReplacement: `={{ ${params} }}` } : {}),
  },
}];
const p = (...exprs) => `[${exprs.map((e) => `${e} ?? null`).join(', ')}]`;

const gmailHttp = (method, url, extra = {}) => ['n8n-nodes-base.httpRequest', 4.2, {
  method,
  url,
  authentication: 'predefinedCredentialType',
  nodeCredentialType: 'gmailOAuth2',
  ...extra,
  options: {},
}];

const gmailSend = ({ to, subject, message, emailType = 'html', replyTo }) => ['n8n-nodes-base.gmail', 2.1, {
  resource: 'message',
  operation: 'send',
  sendTo: to,
  subject,
  emailType,
  message,
  options: { appendAttribution: false, ...(replyTo ? { replyTo } : {}) },
}];

// ---------------------------------------------------------------------------
// Κώδικας των Code nodes
// ---------------------------------------------------------------------------

const BUNDLE_MARK = '/* @lead-core-bundle */';
const withLeadCore = (body) => `${BUNDLE_MARK}\n${body}`;

const CONFIG_HELP = `// ΡΥΘΜΙΣΕΙΣ: άλλαξε μόνο τις τιμές εδώ.
// alert_email:     πού έρχονται τα alerts σφαλμάτων (μόνο σφάλματα, τίποτα άλλο)
// healthcheck_url: ping URL από το healthchecks.io (κενό = απενεργοποιημένο)`;

const capture = workflow('Leads · 1 Capture (Gmail)', (w) => {
  const t = w.add('Every minute', ...schedule(1));
  const cfg = w.add('Config', ...code(`${CONFIG_HELP}
// lead_local_part: το τμήμα πριν το «+» στις διευθύνσεις των πελατών (leads+demo@…)
return [{ json: {
  healthcheck_url: '',
  lead_local_part: 'leads',
  label_name: 'lead-captured',
  query: 'in:anywhere -in:trash -in:sent -in:drafts -label:lead-captured newer_than:30d',
} }];`));
  const labels = w.add('Get labels', ...gmailHttp('GET', `${GMAIL_API}/labels`), { credentials: CRED_GMAIL });
  const findLabel = w.add('Find label', ...code(`const name = $('Config').first().json.label_name;
const label = ($input.first().json.labels || []).find((l) => l.name === name);
if (!label) throw new Error('Λείπει το Gmail label "' + name + '". Φτιάξ\\' το στο Gmail (βλ. docs/SETUP.md).');
return [{ json: { label_id: label.id } }];`));
  const list = w.add('List new emails', ...gmailHttp('GET', `${GMAIL_API}/messages`, {
    sendQuery: true,
    queryParameters: { parameters: [
      { name: 'q', value: "={{ $('Config').first().json.query }}" },
      { name: 'maxResults', value: '50' },
    ] },
  }), { credentials: CRED_GMAIL });
  const hc = w.add('Healthcheck enabled?', ...code(`const url = $('Config').first().json.healthcheck_url;
return url ? [{ json: { url } }] : [];`), { y: 220, position: [1300, 220] });
  const ping = w.add('Ping healthcheck', 'n8n-nodes-base.httpRequest', 4.2, { url: '={{ $json.url }}', options: { timeout: 10000 } },
    { position: [1560, 220], onError: 'continueRegularOutput' });
  const split = w.add('Split messages', ...code(`const msgs = $input.first().json.messages || [];
return msgs.map((m) => ({ json: { id: m.id } }));`));
  const get = w.add('Get email', ...gmailHttp('GET', `=${GMAIL_API}/messages/{{ $json.id }}`, {
    sendQuery: true,
    queryParameters: { parameters: [{ name: 'format', value: 'full' }] },
  }), { credentials: CRED_GMAIL });
  const prep = w.add('Prepare capture', ...code(withLeadCore(`const localPart = $('Config').first().json.lead_local_part;
return $input.all().map((item) => {
  const a = LeadCore.captureArgsFromGmailMessage(item.json, { localPart });
  return { json: {
    channel: a.channel, external_id: a.external_id, recipient: a.recipient, occurred_at: a.occurred_at,
    payload_json: JSON.stringify(a.payload), gmail_id: a.payload.gmail_id,
  } };
});`)));
  const save = w.add('Save raw event', ...pg(
    'select raw_event_id, created, client_id, $6::text as gmail_id from leads.capture_raw_event($1, $2, $3, $4::timestamptz, $5::jsonb)',
    p('$json.channel', '$json.external_id', '$json.recipient', '$json.occurred_at', '$json.payload_json', '$json.gmail_id'),
  ), { credentials: CRED_PG });
  const label = w.add('Label as captured', ...gmailHttp('POST', `=${GMAIL_API}/messages/{{ $json.gmail_id }}/modify`, {
    sendBody: true,
    specifyBody: 'json',
    jsonBody: "={{ JSON.stringify({ addLabelIds: [$('Find label').first().json.label_id] }) }}",
  }), { credentials: CRED_GMAIL });

  w.chain(t, cfg, labels, findLabel, list, split, get, prep, save, label);
  w.link(list, hc);
  w.link(hc, ping);
});

const process_ = workflow('Leads · 2 Process', (w) => {
  const t = w.add('Every minute', ...schedule(1));
  const cfg = w.add('Config', ...code(`${CONFIG_HELP}
return [{ json: { healthcheck_url: '' } }];`));
  const claim = w.add('Claim events', ...pg('select * from leads.claim_raw_events(20)'),
    { credentials: CRED_PG, alwaysOutputData: true });
  const hc = w.add('Healthcheck enabled?', ...code(`const url = $('Config').first().json.healthcheck_url;
return url ? [{ json: { url } }] : [];`), { position: [780, 220] });
  const ping = w.add('Ping healthcheck', 'n8n-nodes-base.httpRequest', 4.2, { url: '={{ $json.url }}', options: { timeout: 10000 } },
    { position: [1040, 220], onError: 'continueRegularOutput' });
  const decide = w.add('Decide', ...code(withLeadCore(`// Για κάθε γεγονός: τι πρέπει να γίνει (ingest / review / ignore / failed).
const out = [];
for (const item of $input.all()) {
  const ev = item.json;
  if (!ev.raw_event_id) continue; // κανένα γεγονός σε αναμονή
  try {
    if (ev.channel !== 'gmail') throw new Error('Μη υποστηριζόμενο κανάλι: ' + ev.channel);
    const d = LeadCore.processEmail(ev.payload, { client: ev.client, routes: ev.routes });
    out.push({ json: {
      raw_event_id: ev.raw_event_id, action: d.action,
      lead_json: d.lead ? JSON.stringify(d.lead) : null,
      kind: d.kind || null, note: d.note || d.reason || null,
      source: d.source || null, parser_version: d.parser_version || null,
    } });
  } catch (err) {
    out.push({ json: { raw_event_id: ev.raw_event_id, action: 'failed', note: String(err && err.stack || err) } });
  }
}
return out;`)), { position: [1040, 0] });
  const route = (action) => w.add(`Only ${action}`, ...code(`return $input.all().filter((i) => i.json.action === '${action}');`));
  const onlyIngest = route('ingest');
  const onlyReview = route('review');
  const onlyIgnore = route('ignore');
  const onlyFailed = route('failed');
  const ingest = w.add('Ingest lead', ...pg('select $1::bigint as raw_event_id, leads.ingest_lead($1, $2::jsonb) as result',
    p('$json.raw_event_id', '$json.lead_json')), { credentials: CRED_PG, onError: 'continueErrorOutput' });
  const review = w.add('Mark review', ...pg('select leads.mark_raw_review($1, $2, $3, $4, $5)',
    p('$json.raw_event_id', '$json.kind', '$json.note', '$json.source', '$json.parser_version')), { credentials: CRED_PG });
  const ignore = w.add('Mark ignored', ...pg('select leads.mark_raw_ignored($1, $2, $3)',
    p('$json.raw_event_id', '$json.note', '$json.source')), { credentials: CRED_PG });
  const ingestErr = w.add('Ingest error', ...code(`// Σφάλμα βάσης στο ingest: θα ξαναδοκιμαστεί με backoff (μετά από 5 → dead + alert).
return $input.all().map((item, i) => ({ json: {
  raw_event_id: $('Only ingest').all()[item.pairedItem?.item ?? i]?.json.raw_event_id ?? item.json.raw_event_id,
  action: 'failed',
  note: 'ingest_lead: ' + (item.json.error?.message || item.json.error?.description || JSON.stringify(item.json.error ?? item.json)),
} }));`));
  const failed = w.add('Mark failed', ...pg('select leads.mark_raw_failed($1, $2) as result',
    p('$json.raw_event_id', '$json.note')), { credentials: CRED_PG });

  w.chain(t, cfg, claim, decide);
  w.link(claim, hc);
  w.link(hc, ping);
  for (const r of [onlyIngest, onlyReview, onlyIgnore, onlyFailed]) w.link(decide, r);
  w.link(onlyIngest, ingest);
  w.link(ingest, ingestErr, 1);
  w.link(ingestErr, failed);
  w.link(onlyReview, review);
  w.link(onlyIgnore, ignore);
  w.link(onlyFailed, failed);
});

// Τοποθέτηση: οι 4 κλάδοι του Process σε σκάλα, για να διαβάζεται.
{
  const ys = { 'Only ingest': -300, 'Only review': -100, 'Only ignore': 100, 'Only failed': 300,
    'Ingest lead': -300, 'Mark review': -100, 'Mark ignored': 100, 'Ingest error': -120, 'Mark failed': 300 };
  const xs = { 'Only ingest': 1300, 'Only review': 1300, 'Only ignore': 1300, 'Only failed': 1300,
    'Ingest lead': 1560, 'Mark review': 1560, 'Mark ignored': 1560, 'Ingest error': 1820, 'Mark failed': 2080 };
  for (const n of process_.nodes) if (n.name in ys) n.position = [xs[n.name], ys[n.name]];
}

const notify = workflow('Leads · 3 Notify agents', (w) => {
  const t = w.add('Every minute', ...schedule(1));
  const claim = w.add('Claim notifications', ...pg('select * from leads.claim_outbox(20)'), { credentials: CRED_PG });
  const render = w.add('Render email', ...code(withLeadCore(`return $input.all().filter((i) => i.json.outbox_id).map((i) => {
  const m = LeadCore.renderAgentEmail(i.json.item);
  return { json: { outbox_id: i.json.outbox_id, ...m } };
});`)));
  const send = w.add('Send to agent', ...gmailSend({
    to: '={{ $json.to }}',
    subject: '={{ $json.subject }}',
    message: '={{ $json.html }}',
    replyTo: "={{ $json.reply_to || '' }}",
  }), { credentials: CRED_GMAIL, onError: 'continueErrorOutput' });
  const sent = w.add('Mark sent', ...pg('select leads.mark_outbox_sent($1)',
    p("$('Render email').item.json.outbox_id")), { credentials: CRED_PG });
  const failed = w.add('Mark failed', ...pg('select leads.mark_outbox_failed($1, $2) as result',
    p("$('Render email').item.json.outbox_id", "String($json.error?.message || $json.error?.description || JSON.stringify($json.error) || 'send failed')")),
  { credentials: CRED_PG, position: [1300, 200] });
  w.chain(t, claim, render, send, sent);
  w.link(send, failed, 1);
});

const monitor = workflow('Leads · 4 Monitor', (w) => {
  const t = w.add('Every hour', ...scheduleHours(1));
  const cfg = w.add('Config', ...code(`${CONFIG_HELP}
return [{ json: { alert_email: 'ΒΑΛΕ-ΤΟ-EMAIL-ΣΟΥ@example.com' } }];`));
  const hb = w.add('Heartbeat', ...pg('select * from leads.heartbeat_report()'), { credentials: CRED_PG, alwaysOutputData: true, executeOnce: true });
  const stale = w.add('Stale reviews', ...pg('select * from leads.stale_blocking_reviews()'), { credentials: CRED_PG, alwaysOutputData: true, executeOnce: true });
  const report = w.add('Report', ...pg('select leads.daily_report() as report'), { credentials: CRED_PG, executeOnce: true });
  const build = w.add('Build alerts', ...code(withLeadCore(`const rows = (name) => $(name).all().map((i) => i.json).filter((r) => Object.keys(r).length);
const alerts = LeadCore.buildOpsAlerts({
  heartbeat: rows('Heartbeat'),
  staleReviews: rows('Stale reviews'),
  report: $('Report').first().json.report,
});
return alerts.map((a) => ({ json: a }));`)));
  const should = w.add('Not sent today?', ...pg('select $1::text as key, $2::text as subject, $3::text as body, leads.ops_alert_should_send($1) as send',
    p('$json.key', '$json.subject', '$json.text')), { credentials: CRED_PG });
  const only = w.add('Only new alerts', ...code('return $input.all().filter((i) => i.json.send === true);'));
  const mail = w.add('Email alert', ...gmailSend({
    to: "={{ $('Config').first().json.alert_email }}",
    subject: "=[Leads] {{ $json.subject }}",
    message: '={{ $json.body }}',
    emailType: 'text',
  }), { credentials: CRED_GMAIL });
  w.chain(t, cfg, hb, stale, report, build, should, only, mail);

  const nightly = w.add('Every night 03:15', ...scheduleDaily(3, 15), { position: [0, 300] });
  const purge = w.add('Purge old payloads', ...pg('select leads.purge_old_payloads() as purged'), { credentials: CRED_PG, position: [260, 300] });
  w.link(nightly, purge);
});

const errors = workflow('Leads · 0 Errors', (w) => {
  const t = w.add('On workflow error', 'n8n-nodes-base.errorTrigger', 1, {});
  const cfg = w.add('Config', ...code(`${CONFIG_HELP}
return [{ json: { alert_email: 'ΒΑΛΕ-ΤΟ-EMAIL-ΣΟΥ@example.com' } }];`));
  const fmt = w.add('Format', ...code(`const e = $('On workflow error').first().json;
const wf = e.workflow?.name || 'unknown workflow';
const node = e.execution?.lastNodeExecuted || 'unknown node';
const msg = e.execution?.error?.message || e.trigger?.error?.message || 'unknown error';
return [{ json: {
  key: 'n8n_error:' + wf + ':' + node,
  subject: 'Σφάλμα στο "' + wf + '" (' + node + ')',
  text: msg + '\\n\\nExecution: ' + (e.execution?.url || e.execution?.id || '-'),
} }];`));
  const should = w.add('Not sent recently?', ...pg("select $1::text as key, $2::text as subject, $3::text as body, leads.ops_alert_should_send($1, interval '1 hour') as send",
    p('$json.key', '$json.subject', '$json.text')), { credentials: CRED_PG, onError: 'continueRegularOutput' });
  const only = w.add('Only new alerts', ...code(`// Αν η βάση δεν απαντάει, στέλνουμε έτσι κι αλλιώς.
return $input.all().filter((i) => i.json.send !== false).map((i, n) => ({ json: {
  subject: i.json.subject || $('Format').first().json.subject,
  body: i.json.body || $('Format').first().json.text,
} }));`));
  const mail = w.add('Email alert', ...gmailSend({
    to: "={{ $('Config').first().json.alert_email }}",
    subject: '=[Leads] {{ $json.subject }}',
    message: '={{ $json.body }}',
    emailType: 'text',
  }), { credentials: CRED_GMAIL });
  w.chain(t, cfg, fmt, should, only, mail);
});

// ---------------------------------------------------------------------------
// Γράψιμο, με το bundle μέσα στα Code nodes
// ---------------------------------------------------------------------------

export async function buildWorkflows() {
  const bundle = readFileSync(await buildBundle(), 'utf8');
  const inject = (wf) => {
    for (const n of wf.nodes) {
      const js = n.parameters?.jsCode;
      if (js?.startsWith(BUNDLE_MARK)) {
        n.parameters.jsCode = `// lead-core (παράγεται από scripts/build-n8n.mjs — μην το αλλάζεις με το χέρι)\n${bundle.trim()}\n// ---- τέλος lead-core ----\n\n${js.slice(BUNDLE_MARK.length + 1)}`;
      }
    }
    return wf;
  };
  mkdirSync(outDir, { recursive: true });
  const all = { '0-errors': errors, '1-capture-gmail': capture, '2-process': process_, '3-notify-agents': notify, '4-monitor': monitor };
  const written = [];
  for (const [file, wf] of Object.entries(all)) {
    const path = join(outDir, `${file}.json`);
    writeFileSync(path, JSON.stringify(inject(structuredClone(wf)), null, 2) + '\n');
    written.push(path);
  }
  return written;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const p of await buildWorkflows()) console.log(p);
}
