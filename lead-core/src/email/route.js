import { extractAddresses } from './text.js';

// Forwarded emails: ο «αποστολέας» είναι ο πελάτης. Η πραγματική πηγή φαίνεται
// στο εσωτερικό block «From:/Από:» του forward.
const FORWARD_MARKERS = [
  /-{3,}\s*forwarded message\s*-{3,}/i,
  /-{3,}\s*προωθημένο μήνυμα\s*-{3,}/i,
  /-{3,}\s*original message\s*-{3,}/i,
  /-{3,}\s*αρχικό μήνυμα\s*-{3,}/i,
  /begin forwarded message:/i,
  /^_{10,}$/m, // Outlook
];

export function detectForward(texts) {
  for (const text of texts) {
    for (const marker of FORWARD_MARKERS) {
      const m = marker.exec(text);
      if (!m) continue;
      const after = text.slice(m.index + m[0].length);
      const fromLine = after.match(/^\s*(?:from|από)\s*:\s*(.+)$/im);
      const innerFrom = fromLine ? extractAddresses(fromLine[1])[0] ?? null : null;
      return { forwarded: true, innerFrom, body: after };
    }
  }
  return { forwarded: false, innerFrom: null, body: null };
}

function fromMatches(entry, address) {
  if (!address) return false;
  const e = entry.toLowerCase().trim();
  return e.startsWith('@') ? address.endsWith(e) : address === e;
}

/**
 * Βρίσκει το route (πηγή + parser) για ένα email.
 * Δοκιμάζει πρώτα το From header και μετά τον εσωτερικό αποστολέα ενός forward.
 */
export function routeEmail(payload, routes, forward) {
  const headerFrom = extractAddresses(payload.headers?.from)[0] ?? null;
  const subject = payload.headers?.subject ?? '';
  const header = { address: headerFrom, matchedBy: 'from' };
  const inner = { address: forward?.innerFrom ?? null, matchedBy: 'forwarded_from' };
  // Σε forward προηγείται ο αρχικός αποστολέας, σε ΟΛΑ τα routes, ώστε ένα forward
  // από το inbox του πελάτη να μη ληφθεί ως email του site του.
  const candidates = forward?.forwarded && inner.address ? [inner, header] : [header, inner];
  const sorted = [...routes].sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100) || (a.id ?? 0) - (b.id ?? 0));
  const subjectOk = (route) => !route.match_subject || new RegExp(route.match_subject, 'i').test(subject);

  for (const c of candidates) {
    if (!c.address) continue;
    for (const route of sorted) {
      if (route.match_from?.length && subjectOk(route) && route.match_from.some((e) => fromMatches(e, c.address))) {
        return { route, matchedBy: c.matchedBy };
      }
    }
  }
  const bySubject = sorted.find((route) => !route.match_from?.length && subjectOk(route));
  return bySubject ? { route: bySubject, matchedBy: 'subject' } : null;
}
