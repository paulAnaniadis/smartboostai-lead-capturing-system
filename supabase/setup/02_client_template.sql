-- Πρότυπο για νέο πελάτη. Άλλαξε τις τιμές με <...> και τρέξ' το στο Supabase SQL Editor.
-- Για δοκιμή χωρίς πραγματικό πελάτη, άφησέ το όπως είναι (slug 'demo').

with c as (
  insert into leads.clients (slug, name, default_region, notify_emails)
  values ('demo', 'Demo Ακίνητα', 'GR', array['<email-agent>@example.com'])
  returning id
), sa as (
  -- Η plus-διεύθυνση του πελάτη στο lead mailbox (πεζά).
  insert into leads.source_accounts (client_id, channel, identifier)
  select id, 'gmail', 'leads+demo@<το-domain-του-lead-mailbox>' from c
)
insert into leads.email_routes (client_id, source, parser, match_from, match_subject, priority, heartbeat_max_silence)
select id, r.source, r.parser, r.match_from, r.match_subject, r.priority, r.silence
from c, (values
  -- Newsletters/ενημερώσεις του portal: αγνοούνται (μικρότερο priority = ελέγχεται πρώτο).
  ('spitogatos', 'ignore',          array['newsletter@spitogatos.gr'],   null::text,                    10, null::interval),
  -- Ειδοποιήσεις μηνυμάτων του Σπιτόγατου.
  ('spitogatos', 'spitogatos_v1',   array['@spitogatos.gr'],             null,                          50, interval '7 days'),
  -- Φόρμα του site: από ποια διεύθυνση στέλνει το WordPress, και με ποιο θέμα.
  ('website',    'website_form_v1', array['@<domain-του-site-πελάτη>'],  'νέο μήνυμα|new form|φόρμα',   50, interval '14 days')
) as r(source, parser, match_from, match_subject, priority, silence);
