import pkg from '../package.json' with { type: 'json' };
import { bodyCandidates, extractAddresses } from './email/text.js';
import { detectForward, routeEmail } from './email/route.js';
import { runParser, ParseError } from './parsers/index.js';
import { normalizeEmails, normalizeName, normalizePhones, messageHash } from './normalize.js';

export const VERSION = pkg.version;

/**
 * LeadCandidate (έξοδος parser) → lead για το ingest_lead().
 */
export function normalizeCandidate(candidate, { source, parser, region = 'GR' }) {
  const { phones, unparsed } = normalizePhones(candidate.phones_raw ?? [], region);
  const { emails, invalid } = normalizeEmails(candidate.emails_raw ?? []);
  const name = normalizeName(candidate);
  const message = candidate.message?.trim() || null;

  const context = { ...(candidate.context ?? {}) };
  if (unparsed.length) context.phones_unparsed = unparsed;
  if (invalid.length) context.emails_invalid = invalid;

  return {
    source,
    ...name,
    phones,
    emails,
    message,
    message_hash: messageHash(message),
    property_refs: [...new Set(candidate.property_refs ?? [])],
    context,
    parser,
    parser_version: `${parser}@${VERSION}`,
  };
}

/**
 * Ολόκληρη η απόφαση για ένα email, χωρίς I/O. Ο processor (n8n) καλεί
 * την αντίστοιχη function της βάσης ανάλογα με το action:
 *   ingest  → leads.ingest_lead(raw_event_id, lead)
 *   ignore  → leads.mark_raw_ignored(raw_event_id, reason, source)
 *   review  → leads.mark_raw_review(raw_event_id, kind, note, source, parser_version)
 */
// Αποστολείς συστήματος που δεν είναι ποτέ leads, π.χ. η επιβεβαίωση που στέλνει η Google
// όταν ο agent ορίζει προώθηση προς τη διεύθυνση του συστήματος. Το email μένει ορατό
// στο Gmail του lead mailbox για να πατηθεί το link επιβεβαίωσης.
const SYSTEM_SENDERS = [/^forwarding-noreply@google\.com$/i, /^mail-noreply@google\.com$/i];

export function processEmail(payload, { client, routes }) {
  const sender = extractAddresses(payload.headers?.from)[0] ?? '';
  if (SYSTEM_SENDERS.some((re) => re.test(sender))) {
    return { action: 'ignore', matchedBy: 'system_sender', source: null, reason: `system sender ${sender}` };
  }
  const forward = detectForward(bodyCandidates(payload));
  const match = routeEmail(payload, routes ?? [], forward);

  if (!match) {
    return {
      action: 'review',
      kind: 'unknown_sender',
      note: `Κανένα route για From: ${payload.headers?.from ?? '(κενό)'}` +
        (forward.innerFrom ? ` (forward από ${forward.innerFrom})` : '') +
        ` · Θέμα: ${payload.headers?.subject ?? '(κενό)'}`,
    };
  }

  const { route } = match;
  if (route.parser === 'ignore') {
    return { action: 'ignore', matchedBy: match.matchedBy, source: route.source, reason: `route ${route.id ?? ''} (ignore)`.trim() };
  }

  try {
    const candidate = runParser(route.parser, payload, forward);
    const lead = normalizeCandidate(candidate, {
      source: route.source,
      parser: route.parser,
      region: client?.default_region ?? 'GR',
    });
    if (forward.forwarded) lead.context.forwarded = true;
    return { action: 'ingest', matchedBy: match.matchedBy, source: route.source, lead };
  } catch (err) {
    if (err instanceof ParseError) {
      return {
        action: 'review',
        kind: 'parse_failed',
        source: route.source,
        parser_version: `${route.parser}@${VERSION}`,
        note: `${route.parser}: ${err.message}`,
      };
    }
    throw err;
  }
}
