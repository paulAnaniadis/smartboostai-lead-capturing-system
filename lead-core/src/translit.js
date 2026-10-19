// Κανονικοποίηση ονομάτων για ΣΥΓΚΡΙΣΗ (name_mismatch), όχι για εμφάνιση.
// Ελληνικά → λατινικά (απλοποιημένο ΕΛΟΤ 743), πεζά, χωρίς τόνους,
// ώστε «Γιώργος» και «Giorgos» να δίνουν το ίδιο token.

const DIGRAPHS = [
  ['ου', 'ou'], ['αυ', 'av'], ['ευ', 'ev'], ['γγ', 'ng'],
];

const LETTERS = {
  α: 'a', β: 'v', γ: 'g', δ: 'd', ε: 'e', ζ: 'z', η: 'i', θ: 'th', ι: 'i', κ: 'k',
  λ: 'l', μ: 'm', ν: 'n', ξ: 'x', ο: 'o', π: 'p', ρ: 'r', σ: 's', ς: 's', τ: 't',
  υ: 'y', φ: 'f', χ: 'ch', ψ: 'ps', ω: 'o',
};

export function stripAccents(s) {
  return s.normalize('NFD').replace(/\p{M}/gu, '').normalize('NFC');
}

export function transliterate(s) {
  let out = stripAccents(String(s).toLowerCase());
  for (const [g, l] of DIGRAPHS) out = out.split(g).join(l);
  return out.replace(/[α-ως]/g, (ch) => LETTERS[ch] ?? ch);
}

// Tokens για σύγκριση ονομάτων: λατινικά, πεζά, μόνο γράμματα, ≥2 χαρακτήρες, μοναδικά.
export function nameTokens(...parts) {
  const tokens = parts
    .filter(Boolean)
    .join(' ')
    .split(/[\s,.\-_/]+/)
    .map((t) => transliterate(t).replace(/[^a-z]/g, ''))
    .filter((t) => t.length >= 2);
  return [...new Set(tokens)];
}
