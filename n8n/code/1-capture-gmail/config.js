// ΡΥΘΜΙΣΕΙΣ: άλλαξε μόνο τις τιμές εδώ.
// alert_email:     πού έρχονται τα alerts σφαλμάτων (μόνο σφάλματα, τίποτα άλλο)
// healthcheck_url: ping URL από το healthchecks.io (κενό = απενεργοποιημένο)
// lead_local_part: το τμήμα πριν το «+» στις διευθύνσεις των πελατών (leads+demo@…)
return [{ json: {
  healthcheck_url: '',
  lead_local_part: 'leads',
  label_name: 'lead-captured',
  query: 'in:anywhere -in:trash -in:sent -in:drafts -label:lead-captured newer_than:30d',
} }];
