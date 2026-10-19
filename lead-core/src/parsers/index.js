import { extractFields } from '../email/fields.js';
import { bodyCandidates, extractAddresses } from '../email/text.js';
import { websiteFormV1 } from './website_form_v1.js';
import { spitogatosV1 } from './spitogatos_v1.js';

export class ParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ParseError';
  }
}

// Κάθε parser παίρνει { payload, fields, extra, text, forward } και επιστρέφει
// ένα LeadCandidate χωρίς normalization:
// { name, first_name, last_name, phones_raw[], emails_raw[], message, property_refs[], context }
// messageStop: γραμμές που δεν ανήκουν στο μήνυμα του ενδιαφερόμενου (links/footers της πηγής).
export const PARSERS = {
  website_form_v1: { parse: websiteFormV1, messageStop: [] },
  spitogatos_v1: { parse: spitogatosV1, messageStop: [/spitogatos\.gr/i, /^δείτε την αγγελία/i] },
};

const IDENTITY_FIELDS = ['name', 'first_name', 'last_name', 'phone', 'email', 'message'];

// Διαλέγει το σώμα (text ή HTML) που δίνει τα περισσότερα αναγνωρισμένα πεδία.
export function extractBest(payload, forward, options = {}) {
  const texts = forward?.forwarded && forward.body ? [forward.body] : bodyCandidates(payload);
  let best = { fields: {}, extra: {}, labelsFound: 0, text: texts[0] ?? '' };
  for (const text of texts) {
    const r = extractFields(text, options);
    if (r.labelsFound > best.labelsFound) best = { ...r, text };
  }
  return best;
}

export function runParser(name, payload, forward) {
  const parser = PARSERS[name];
  if (!parser) throw new ParseError(`Άγνωστος parser: ${name}`);

  const extracted = extractBest(payload, forward, { messageStop: parser.messageStop });
  const identityLabels = IDENTITY_FIELDS.filter((f) => extracted.fields[f]?.length);
  if (identityLabels.length === 0) {
    // Καμία γνωστή ετικέτα: πιθανότατα άλλαξε το template.
    throw new ParseError('Δεν αναγνωρίστηκε κανένα πεδίο (όνομα/τηλέφωνο/email/μήνυμα). Πιθανή αλλαγή template.');
  }

  const candidate = parser.parse({ payload, forward, ...extracted });

  // Fallback: αν δεν βρέθηκε email στο σώμα, το Reply-To (που τα form plugins
  // συνήθως βάζουν στον ενδιαφερόμενο). Όχι σε forward, όπου είναι ο πελάτης.
  if (!candidate.emails_raw.length && !forward?.forwarded) {
    const replyTo = extractAddresses(payload.headers?.reply_to)[0];
    const from = extractAddresses(payload.headers?.from)[0];
    if (replyTo && replyTo !== from && !/no-?reply/i.test(replyTo)) {
      candidate.emails_raw.push(replyTo);
      candidate.context.email_from_reply_to = true;
    }
  }
  return candidate;
}
