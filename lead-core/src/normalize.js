import { createHash } from 'node:crypto';
import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { nameTokens, stripAccents } from './translit.js';

// ---------------------------------------------------------------------------
// Τηλέφωνα → E.164. Ό,τι δεν επικυρώνεται δεν «μαντεύεται»: πάει στα unparsed.
// ---------------------------------------------------------------------------

const PHONE_SPLIT = /\s*(?:[\/,;|]|\s(?:ή|or|και|and)\s)\s*/i;

export function normalizePhones(rawValues, region = 'GR') {
  const phones = [];
  const unparsed = [];
  const seen = new Set();
  for (const raw of rawValues.flatMap((v) => String(v ?? '').split(PHONE_SPLIT))) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let candidate = trimmed.replace(/[^\d+]/g, '');
    if (candidate.startsWith('00')) candidate = '+' + candidate.slice(2);
    if (candidate.replace(/\D/g, '').length < 7) {
      unparsed.push(trimmed);
      continue;
    }
    const parsed = parsePhoneNumberFromString(candidate, region);
    if (parsed && parsed.isValid()) {
      if (!seen.has(parsed.number)) {
        seen.add(parsed.number);
        phones.push({ e164: parsed.number, raw: trimmed });
      }
    } else {
      unparsed.push(trimmed);
    }
  }
  return { phones, unparsed };
}

// ---------------------------------------------------------------------------
// Emails: trim + lowercase. Τίποτα «έξυπνο».
// ---------------------------------------------------------------------------

const EMAIL_RE = /[^\s<>()[\]{}:;,"']+@[^\s<>()[\]{}:;,"']+\.[a-z]{2,}/gi;
const EMAIL_VALID = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function normalizeEmails(rawValues) {
  const emails = [];
  const invalid = [];
  const seen = new Set();
  for (const raw of rawValues) {
    const text = String(raw ?? '').trim();
    if (!text) continue;
    const found = text.match(EMAIL_RE);
    if (!found) {
      invalid.push(text);
      continue;
    }
    for (const f of found) {
      const value = f.trim().toLowerCase().replace(/\.+$/, '');
      if (!EMAIL_VALID.test(value) || seen.has(value)) continue;
      seen.add(value);
      emails.push({ value, raw: f.trim() });
    }
  }
  return { emails, invalid };
}

// ---------------------------------------------------------------------------
// Όνομα: full_name_raw όπως ήρθε, first/last best-effort. Ποτέ για matching.
// ---------------------------------------------------------------------------

const clean = (s) => (s == null ? null : String(s).replace(/\s+/g, ' ').trim() || null);

export function normalizeName({ name, first_name, last_name }) {
  let first = clean(first_name);
  let last = clean(last_name);
  const full = clean(name);

  if (!first && !last && full) {
    const parts = full.split(' ');
    first = parts[0];
    last = parts.length > 1 ? parts.slice(1).join(' ') : null;
  } else if (!first && full) {
    first = full; // «Όνομα» + «Επίθετο» σε ξεχωριστά πεδία
  }

  const fullRaw = full && !last_name ? full : [first, last].filter(Boolean).join(' ') || null;
  return {
    full_name_raw: fullRaw,
    first_name: first,
    last_name: last,
    name_tokens: nameTokens(first, last),
  };
}

// ---------------------------------------------------------------------------
// Μήνυμα: αυτούσιο. Hash κανονικοποιημένου κειμένου για dedup χωρίς property_ref.
// ---------------------------------------------------------------------------

export function messageHash(message) {
  const normalized = stripAccents(String(message ?? '').toLowerCase()).replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// property_ref: κανονική μορφή με namespace, ώστε να μη συγκρούονται πηγές.
// ---------------------------------------------------------------------------

export function propertyRefFromCode(namespace, code) {
  const c = clean(code);
  if (!c) return null;
  return `${namespace}:${c.toUpperCase().replace(/\s+/g, '')}`;
}

export function propertyRefFromUrl(url) {
  const u = clean(url);
  if (!u) return null;
  try {
    const parsed = new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const path = decodeURIComponent(parsed.pathname).replace(/\/+$/, '').toLowerCase();
    if (!host.includes('.')) return null;
    return `url:${host}${path}`;
  } catch {
    return null;
  }
}
