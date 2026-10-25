// Αποκωδικοποίηση base64url και charsets χωρίς να εξαρτόμαστε από Node built-ins,
// ώστε ο κώδικας να τρέχει και μέσα στο sandbox του Code node του n8n.

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]));

export function base64UrlToBytes(data) {
  const s = String(data).replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const n = (B64_INDEX.get(s[i]) << 18) | ((B64_INDEX.get(s[i + 1]) ?? 0) << 12)
      | ((B64_INDEX.get(s[i + 2]) ?? 0) << 6) | (B64_INDEX.get(s[i + 3]) ?? 0);
    out[o++] = (n >> 16) & 0xff;
    if (i + 2 < s.length) out[o++] = (n >> 8) & 0xff;
    if (i + 3 < s.length) out[o++] = n & 0xff;
  }
  return out.subarray(0, o);
}

function utf8Decode(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i];
    let cp;
    if (b < 0x80) { cp = b; i += 1; }
    else if ((b & 0xe0) === 0xc0) { cp = ((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f); i += 2; }
    else if ((b & 0xf0) === 0xe0) { cp = ((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f); i += 3; }
    else { cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f); i += 4; }
    out += Number.isFinite(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : '\ufffd';
  }
  return out;
}

// ISO-8859-7 (ελληνικά). Τα windows-1253 διαφέρουν σε λίγες θέσεις.
const ISO_8859_7_HIGH = {
  0xa1: 0x2018, 0xa2: 0x2019, 0xa4: 0x20ac, 0xa5: 0x20af, 0xaa: 0x037a, 0xaf: 0x2015,
  0xb4: 0x0384, 0xb5: 0x0385, 0xb6: 0x0386, 0xb8: 0x0388, 0xb9: 0x0389, 0xba: 0x038a,
  0xbc: 0x038c, 0xbe: 0x038e, 0xbf: 0x038f,
};
const WIN_1253_DIFF = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021,
  0x89: 0x2030, 0x8b: 0x2039, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022,
  0x96: 0x2013, 0x97: 0x2014, 0x99: 0x2122, 0x9b: 0x203a, 0xa1: 0x0385, 0xa2: 0x0386, 0xb5: 0x00b5,
  0xb6: 0x00b6,
};

function greekSingleByte(bytes, windows) {
  let out = '';
  for (const b of bytes) {
    let cp = b;
    if (windows && WIN_1253_DIFF[b]) cp = WIN_1253_DIFF[b];
    else if (b >= 0xc0) cp = 0x0390 + (b - 0xc0);
    else if (ISO_8859_7_HIGH[b]) cp = ISO_8859_7_HIGH[b];
    out += String.fromCodePoint(cp);
  }
  return out;
}

// ΣΗΜΕΙΩΣΗ: δεν χρησιμοποιούμε TextDecoder/TextEncoder. Στο sandbox (vm2) του n8n 1.x
// είναι αντικείμενα του host και πετάνε «Operation not allowed on contextified object»
// όταν τους δώσεις Uint8Array του sandbox.
const WIN_1252_80 = [0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039,
  0x0152, 0x8d, 0x017d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161,
  0x203a, 0x0153, 0x9d, 0x017e, 0x0178];

function singleByte(bytes, map80) {
  let out = '';
  for (const b of bytes) out += String.fromCharCode(map80 && b >= 0x80 && b <= 0x9f ? map80[b - 0x80] : b);
  return out;
}

// Έγκυρο UTF-8 με τουλάχιστον έναν πολυbyte χαρακτήρα. Ελληνικό κείμενο σε ISO-8859-7 /
// Windows-1253 σχεδόν ποτέ δεν είναι έγκυρο UTF-8 (π.χ. «Ό» = 0xBC, μόνο του byte συνέχειας).
export function looksLikeUtf8(bytes) {
  let multibyte = false;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b < 0x80) continue;
    let n;
    if (b >= 0xc2 && b <= 0xdf) n = 1;
    else if (b >= 0xe0 && b <= 0xef) n = 2;
    else if (b >= 0xf0 && b <= 0xf4) n = 3;
    else return false;
    if (i + n >= bytes.length) return false; // κομμένος χαρακτήρας στο τέλος
    for (let k = 1; k <= n; k++) {
      if ((bytes[i + k] & 0xc0) !== 0x80) return false;
    }
    i += n;
    multibyte = true;
  }
  return multibyte;
}

export function decodeBytes(bytes, charset = 'utf-8') {
  const cs = String(charset || 'utf-8').toLowerCase().replace(/^"|"$/g, '');
  // Κάποιοι providers (π.χ. Hotmail/Outlook) δηλώνουν ελληνικό charset ενώ το περιεχόμενο,
  // όπως το παραδίδει το Gmail API, είναι UTF-8. Αν είναι έγκυρο UTF-8, μετράει αυτό.
  if (looksLikeUtf8(bytes)) return utf8Decode(bytes);
  if (cs === 'iso-8859-7' || cs === 'iso8859-7' || cs === 'greek') return greekSingleByte(bytes, false);
  if (cs === 'windows-1253' || cs === 'cp1253') return greekSingleByte(bytes, true);
  if (cs === 'windows-1252' || cs === 'cp1252') return singleByte(bytes, WIN_1252_80);
  if (cs === 'iso-8859-1' || cs === 'latin1' || cs === 'us-ascii' || cs === 'ascii') return singleByte(bytes, null);
  return utf8Decode(bytes);
}

export function utf8Encode(str) {
  const bytes = [];
  for (const ch of String(str)) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) bytes.push(cp);
    else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return new Uint8Array(bytes);
}
