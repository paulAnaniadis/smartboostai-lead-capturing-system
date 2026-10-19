// HTML → απλό κείμενο, με διατήρηση γραμμών. Τα κελιά πίνακα χωρίζονται με tab,
// ώστε το «Ετικέτα | Τιμή» ενός HTML πίνακα να διαβάζεται όπως το «Ετικέτα: Τιμή».

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    const key = e.toLowerCase();
    if (key.startsWith('#x')) return String.fromCodePoint(parseInt(key.slice(2), 16));
    if (key.startsWith('#')) return String.fromCodePoint(parseInt(key.slice(1), 10));
    return ENTITIES[key] ?? m;
  });
}

export function htmlToText(html) {
  if (!html) return '';
  let s = String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(head|style|script|title)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (m, href, text) => {
      const t = text.replace(/<[^>]+>/g, '').trim();
      if (!t || t === href || /^mailto:|^tel:/i.test(href)) return t || href.replace(/^(mailto|tel):/i, '');
      return `${t} (${href})`;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(td|th)>\s*<(td|th)[^>]*>/gi, '\t')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, '\n')
    .replace(/<(p|div|tr|li|h[1-6]|table|blockquote)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  return s
    .split('\n')
    .map((line) => line.replace(/[  ]+/g, ' ').replace(/\s*\t\s*/g, '\t').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Κείμενο του email για parsing: δοκιμάζει text/plain και HTML και κρατάει
// αυτό που δίνει τα περισσότερα αναγνωρισμένα πεδία (το αποφασίζει ο caller).
export function bodyCandidates(payload) {
  const out = [];
  if (payload.text && payload.text.trim()) out.push(payload.text.replace(/\r\n/g, '\n'));
  if (payload.html && payload.html.trim()) out.push(htmlToText(payload.html));
  return out;
}

const ADDRESS_RE = /[^\s<>()"',;:]+@[^\s<>()"',;:]+\.[a-z]{2,}/gi;

export function extractAddresses(headerValue) {
  if (!headerValue) return [];
  const values = Array.isArray(headerValue) ? headerValue : [headerValue];
  return values.flatMap((v) => String(v).match(ADDRESS_RE) ?? []).map((a) => a.toLowerCase());
}
