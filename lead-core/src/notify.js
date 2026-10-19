// Κείμενα προς τα έξω: ειδοποίηση του agent για νέο lead, και alerts σφαλμάτων.

const SOURCE_LABELS = {
  website: 'Site',
  spitogatos: 'Σπιτόγατος',
  xe: 'xe.gr',
  fb_leadgen: 'Facebook',
  whatsapp: 'WhatsApp',
};

const FLAG_LABELS = {
  possible_merge: 'Το τηλέφωνο ή το email ταιριάζει και με άλλη επαφή (θα ελεγχθεί).',
  name_mismatch: 'Το ίδιο τηλέφωνο/email έχει έρθει στο παρελθόν με διαφορετικό όνομα.',
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const sourceLabel = (s) => SOURCE_LABELS[s] ?? s;

export function propertyLabel(ref) {
  if (!ref) return null;
  const [ns, ...rest] = ref.split(':');
  const value = rest.join(':');
  if (ns === 'url') return { text: value, href: `https://${value}` };
  if (ns === 'spitogatos') return { text: `Σπιτόγατος #${value}`, href: `https://www.spitogatos.gr/aggelia/${value}` };
  if (ns === 'site') return { text: `Κωδικός ${value}`, href: null };
  return { text: ref, href: null };
}

function formatAthens(iso) {
  try {
    return new Intl.DateTimeFormat('el-GR', {
      timeZone: 'Europe/Athens', dateStyle: 'short', timeStyle: 'short',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/**
 * Email προς τον agent, από ένα item του leads.claim_outbox().
 * Το Reply-To είναι ο ενδιαφερόμενος: ο agent πατάει «Απάντηση» και του γράφει απευθείας.
 */
export function renderAgentEmail(item) {
  const { client, inquiry, contact } = item;
  const flags = item.flags ?? [];
  const name = contact.full_name_raw || [contact.first_name, contact.last_name].filter(Boolean).join(' ') || '(χωρίς όνομα)';
  const prop = propertyLabel(inquiry.property_ref);
  const src = sourceLabel(inquiry.source);
  const prefix = inquiry.is_returning ? 'Επανήλθε' : 'Νέο lead';

  const subject = [`${prefix}: ${name}`, src, prop?.text].filter(Boolean).join(' · ');

  const rows = [
    ['Όνομα', esc(name)],
    ['Τηλέφωνο', contact.phones.map((p) => `<a href="tel:${esc(p)}">${esc(p)}</a>`).join('<br>') || '—'],
    ['Email', contact.emails.map((e) => `<a href="mailto:${esc(e)}">${esc(e)}</a>`).join('<br>') || '—'],
    ['Πηγή', esc(src)],
    ['Ακίνητο', prop ? (prop.href ? `<a href="${esc(prop.href)}">${esc(prop.text)}</a>` : esc(prop.text)) : 'Γενικό ενδιαφέρον'],
    ['Μήνυμα', inquiry.message ? esc(inquiry.message).replace(/\n/g, '<br>') : '—'],
    ['Ώρα', esc(formatAthens(inquiry.first_seen_at))],
  ];
  if (contact.previous_inquiries > 0) {
    rows.push(['Ιστορικό', `Έχει εκδηλώσει ενδιαφέρον άλλες ${contact.previous_inquiries} φορές`]);
  }

  const notes = [
    inquiry.is_returning ? 'Ο ίδιος άνθρωπος είχε ξαναρωτήσει για αυτό το ακίνητο στο παρελθόν.' : null,
    ...flags.map((f) => FLAG_LABELS[f]).filter(Boolean),
  ].filter(Boolean);

  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">
<h2 style="margin:0 0 12px">${esc(prefix)}</h2>
<table cellpadding="6" style="border-collapse:collapse">
${rows.map(([k, v]) => `<tr><td style="color:#666;vertical-align:top"><b>${k}</b></td><td>${v}</td></tr>`).join('\n')}
</table>
${notes.length ? `<p style="background:#fff4e5;padding:8px">${notes.map(esc).join('<br>')}</p>` : ''}
</div>`;

  const text = [
    prefix,
    '',
    `Όνομα: ${name}`,
    `Τηλέφωνο: ${contact.phones.join(', ') || '—'}`,
    `Email: ${contact.emails.join(', ') || '—'}`,
    `Πηγή: ${src}`,
    `Ακίνητο: ${prop ? prop.text : 'Γενικό ενδιαφέρον'}`,
    `Μήνυμα: ${inquiry.message ?? '—'}`,
    ...(notes.length ? ['', ...notes] : []),
  ].join('\n');

  return {
    to: client.notify_emails.join(','),
    reply_to: contact.emails[0] ?? null,
    subject,
    html,
    text,
  };
}

/**
 * Alerts σφαλμάτων προς τον διαχειριστή, από τα reports της βάσης.
 * Κάθε alert έχει σταθερό key, ώστε το leads.ops_alert_should_send(key)
 * να μην ξαναστέλνει το ίδιο πρόβλημα πάνω από μία φορά τη μέρα.
 */
export function buildOpsAlerts({ heartbeat = [], staleReviews = [], report = null } = {}) {
  const alerts = [];

  for (const h of heartbeat.filter((x) => x.alert)) {
    alerts.push({
      key: `heartbeat:${h.client_slug}:${h.source}`,
      subject: `Σιωπή: ${sourceLabel(h.source)} / ${h.client_slug}`,
      text: `Δεν έχει έρθει τίποτα από ${sourceLabel(h.source)} για τον πελάτη ${h.client_slug} ` +
        `(τελευταίο: ${h.last_seen_at ?? 'ποτέ'}, όριο: ${h.max_silence}).\n` +
        'Πιθανές αιτίες: άλλαξε ο παραλήπτης στο portal/φόρμα, σβήστηκε κανόνας forwarding, άλλαξε το template.',
    });
  }

  for (const r of staleReviews) {
    alerts.push({
      key: `stale_review:${r.review_id}`,
      subject: `Lead περιμένει έλεγχο: ${r.kind} (${r.client_slug ?? 'χωρίς πελάτη'})`,
      text: `Review #${r.review_id} (${r.kind}) για raw event #${r.raw_event_id} περιμένει πάνω από 4 ώρες.\n${r.note ?? ''}`,
    });
  }

  if (report?.dead_raw_events > 0) {
    alerts.push({
      key: 'dead_raw_events',
      subject: `${report.dead_raw_events} γεγονότα απέτυχαν οριστικά`,
      text: 'Υπάρχουν raw events σε κατάσταση dead (5 αποτυχημένες προσπάθειες). ' +
        'Δες το last_error τους και κάνε reprocess μετά τη διόρθωση.',
    });
  }
  if (report?.dead_outbox > 0) {
    alerts.push({
      key: 'dead_outbox',
      subject: `${report.dead_outbox} ειδοποιήσεις προς agents δεν στάλθηκαν`,
      text: 'Υπάρχουν ειδοποιήσεις σε κατάσταση dead στο outbox. Οι agents ΔΕΝ έχουν μάθει για αυτά τα leads.',
    });
  }
  return alerts;
}
