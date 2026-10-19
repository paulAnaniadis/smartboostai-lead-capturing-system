import { propertyRefFromCode, propertyRefFromUrl } from '../normalize.js';

// Φόρμες site (Contact Form 7, WPForms, Elementor κ.λπ.): «Ετικέτα: τιμή».
// Το ακίνητο έρχεται από κρυφό πεδίο: κωδικός (προτιμάται) ή URL της σελίδας.
export function websiteFormV1({ fields, extra }) {
  const first = (k) => fields[k]?.[0] ?? null;
  const code = first('property_code');
  const url = first('property_url');

  const refs = [];
  const codeRef = propertyRefFromCode('site', code);
  if (codeRef) refs.push(codeRef);
  else if (url) {
    const urlRef = propertyRefFromUrl(url);
    if (urlRef) refs.push(urlRef);
  }

  return {
    name: first('name'),
    first_name: first('first_name'),
    last_name: first('last_name'),
    phones_raw: fields.phone ?? [],
    emails_raw: fields.email ?? [],
    message: fields.message?.join('\n\n') ?? null,
    property_refs: refs,
    context: {
      ...(url ? { page_url: url } : {}),
      ...(code ? { property_code_raw: code } : {}),
      ...(Object.keys(extra).length ? { extra_fields: extra } : {}),
      ...(refs.length ? {} : { warning: 'no_property_ref' }),
    },
  };
}
