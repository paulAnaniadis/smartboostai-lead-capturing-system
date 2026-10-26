// Σφάλμα Graph API (token, δικαιώματα, δίκτυο): retry με backoff, μετά dead + alert.
const src = $('Only fetch').all();
return $input.all().map((item, i) => ({ json: {
  raw_event_id: src[item.pairedItem?.item ?? i]?.json.raw_event_id,
  action: 'failed',
  note: 'graph: ' + (item.json.error?.message || item.json.error?.description || JSON.stringify(item.json.error ?? item.json)),
} }));
