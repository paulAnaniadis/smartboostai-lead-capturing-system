// Σπιτόγατος.
// ΣΗΜΕΙΩΣΗ: γραμμένος πάνω σε ΕΙΚΟΝΙΚΑ emails (fixtures/spitogatos_v1). Πριν πάει σε
// πελάτη πρέπει να ελεγχθεί και να προσαρμοστεί με πραγματικά emails του Σπιτόγατου.
//
// Κωδικός αγγελίας: από πεδίο «Κωδικός αγγελίας» ή από link αγγελίας στο σώμα.
// property_ref = spitogatos:<κωδικός>

const LISTING_URL = /spitogatos\.gr\/[^\s)"'<>]*?(\d{6,})/gi;

export function spitogatosV1({ fields, extra, text, payload }) {
  const first = (k) => fields[k]?.[0] ?? null;

  const codes = new Set();
  for (const c of fields.property_code ?? []) {
    const digits = String(c).match(/\d{5,}/);
    if (digits) codes.add(digits[0]);
  }
  const haystack = [text, payload.html ?? ''].join('\n');
  for (const m of haystack.matchAll(LISTING_URL)) codes.add(m[1]);

  return {
    name: first('name'),
    first_name: first('first_name'),
    last_name: first('last_name'),
    phones_raw: fields.phone ?? [],
    emails_raw: fields.email ?? [],
    message: fields.message?.join('\n\n') ?? null,
    property_refs: [...codes].map((c) => `spitogatos:${c}`),
    context: {
      ...(first('property_url') ? { listing_url: first('property_url') } : {}),
      ...(Object.keys(extra).length ? { extra_fields: extra } : {}),
      ...(codes.size ? {} : { warning: 'no_property_ref' }),
    },
  };
}
