// Σφάλμα βάσης στο ingest: θα ξαναδοκιμαστεί με backoff (μετά από 5 → dead + alert).
return $input.all().map((item, i) => ({ json: {
  raw_event_id: $('Only ingest').all()[item.pairedItem?.item ?? i]?.json.raw_event_id ?? item.json.raw_event_id,
  action: 'failed',
  note: 'ingest_lead: ' + (item.json.error?.message || item.json.error?.description || JSON.stringify(item.json.error ?? item.json)),
} }));
