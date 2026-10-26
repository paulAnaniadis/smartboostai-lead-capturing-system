// Facebook / Instagram Lead Ads → lead για το ingest_lead().
//
// Το raw payload είναι είτε:
//   · από webhook: { via: 'webhook', leadgen_id, page_id, form_id, ad_id, created_time } (χωρίς στοιχεία)
//   · από reconciliation ή μετά το fetch: { via: ..., lead: <Graph API lead με field_data> }
// Αν λείπει το lead, ο processor πρέπει πρώτα να το φέρει από το Graph API (action: 'fetch').

import { fieldForLabel } from './email/fields.js';
import { normalizeCandidate } from './process.js';

// Τυπικά πεδία των φορμών της Meta.
const STANDARD = {
  full_name: 'name', first_name: 'first_name', last_name: 'last_name',
  email: 'email', work_email: 'email', phone_number: 'phone', phone: 'phone', work_phone_number: 'phone',
};
const MESSAGE_HINT = /(message|comment|question|μηνυμα|σχολι|ερωτηση|ενδιαφερ|περιγραφ)/;

const strip = (s) => String(s).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

function classifyField(name) {
  const key = String(name).toLowerCase();
  if (STANDARD[key]) return STANDARD[key];
  const asLabel = fieldForLabel(key.replace(/_/g, ' ').replace(/[?:]+$/, ''));
  if (asLabel && ['name', 'first_name', 'last_name', 'phone', 'email', 'message'].includes(asLabel)) return asLabel;
  if (MESSAGE_HINT.test(strip(key))) return 'message';
  return null;
}

export function parseFacebookLead(lead) {
  const fields = { name: [], first_name: [], last_name: [], phone: [], email: [], message: [] };
  const answers = {};
  for (const f of lead.field_data ?? []) {
    const values = (f.values ?? []).map((v) => String(v).trim()).filter(Boolean);
    if (!values.length) continue;
    const target = classifyField(f.name);
    if (target) fields[target].push(...values);
    else answers[f.name] = values.join(', ');
  }
  const refs = lead.ad_id ? [`fb_ad:${lead.ad_id}`] : lead.form_id ? [`fb_form:${lead.form_id}`] : [];
  const context = Object.fromEntries(Object.entries({
    leadgen_id: lead.id,
    ad_id: lead.ad_id, ad_name: lead.ad_name,
    adset_name: lead.adset_name, campaign_name: lead.campaign_name,
    form_id: lead.form_id, form_name: lead.form_name,
    platform: lead.platform, is_organic: lead.is_organic,
    answers: Object.keys(answers).length ? answers : undefined,
  }).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  return {
    name: fields.name[0] ?? null,
    first_name: fields.first_name[0] ?? null,
    last_name: fields.last_name[0] ?? null,
    phones_raw: fields.phone,
    emails_raw: fields.email,
    message: fields.message.length ? fields.message.join('\n\n') : null,
    property_refs: refs,
    context,
  };
}

/**
 * Απόφαση για ένα γεγονός fb_leadgen, χωρίς I/O:
 *   fetch  → φέρε το lead από το Graph API (GET /{leadgen_id}) και ξανακάλεσε με payload.lead
 *   ingest → leads.ingest_lead(raw_event_id, lead)
 *   review → leads.mark_raw_review(...)  (φόρμα χωρίς κανένα πεδίο)
 */
export function processFacebookLead(payload, { client } = {}) {
  const lead = payload?.lead;
  if (!lead || !Array.isArray(lead.field_data)) {
    const id = payload?.leadgen_id ?? payload?.lead?.id;
    if (!id) return { action: 'review', kind: 'parse_failed', source: 'facebook', note: 'fb_leadgen χωρίς leadgen_id' };
    return { action: 'fetch', leadgen_id: String(id) };
  }
  if (!lead.field_data.length) {
    return { action: 'review', kind: 'parse_failed', source: 'facebook', note: `Lead ${lead.id} χωρίς πεδία` };
  }
  const candidate = parseFacebookLead(lead);
  const normalized = normalizeCandidate(candidate, {
    source: 'facebook', parser: 'facebook_v1', region: client?.default_region ?? 'GR',
  });
  return { action: 'ingest', source: 'facebook', lead: normalized };
}

// Από webhook (entry[].changes[].value με field=leadgen) → ορίσματα capture_raw_event.
export function captureArgsFromLeadgenChange(value) {
  return {
    channel: 'fb_leadgen',
    external_id: String(value.leadgen_id),
    recipient: String(value.page_id),
    occurred_at: value.created_time ? new Date(Number(value.created_time) * 1000).toISOString() : new Date().toISOString(),
    payload: { via: 'webhook', ...value },
  };
}

// Από reconciliation (GET /{form_id}/leads) → ορίσματα capture_raw_event, με το lead μέσα.
export function captureArgsFromPolledLead(lead, pageId) {
  const created = lead.created_time ? new Date(String(lead.created_time).replace(/\+0000$/, 'Z')) : new Date();
  return {
    channel: 'fb_leadgen',
    external_id: String(lead.id),
    recipient: String(pageId),
    occurred_at: Number.isNaN(created.getTime()) ? new Date().toISOString() : created.toISOString(),
    payload: { via: 'poll', leadgen_id: String(lead.id), page_id: String(pageId), lead },
  };
}
