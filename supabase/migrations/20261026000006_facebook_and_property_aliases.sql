-- Φάση 2 (Facebook Lead Ads) και σύνδεση πηγών μεταξύ τους.
--
-- 1. property_aliases: το ίδιο ακίνητο έχει άλλον κωδικό σε κάθε πηγή. Με την αντιστοίχιση,
--    ο ίδιος άνθρωπος για το ίδιο ακίνητο από Σπιτόγατο και από Facebook = ΕΝΑ ενδιαφέρον.
--    (Ο ίδιος άνθρωπος αναγνωρίζεται ήδη από τηλέφωνο/email, ανεξάρτητα από την πηγή.)
-- 2. claim_raw_events ανά κανάλι: το workflow των emails παίρνει μόνο emails.
-- 3. Heartbeat και για πηγές χωρίς email route (Facebook, WhatsApp).
-- 4. Θύρα για τον receiver της Meta (Supabase Edge Function).

-- ---------------------------------------------------------------------------
-- 1. Αντιστοίχιση κωδικών ακινήτων
-- ---------------------------------------------------------------------------

create table if not exists leads.property_aliases (
  id         bigint generated always as identity primary key,
  client_id  uuid not null references leads.clients (id),
  alias      text not null,     -- π.χ. spitogatos:12345678 · fb_ad:120211234567 · url:site.gr/akinita/x
  canonical  text not null,     -- π.χ. site:KAL-102
  note       text,
  created_at timestamptz not null default now(),
  unique (client_id, alias),
  check (alias <> canonical)
);
alter table leads.property_aliases enable row level security;

-- Βοηθητική για χειροκίνητη καταχώριση από το SQL Editor:
--   select leads.set_property_alias('demo', 'fb_ad:120211234567', 'site:KAL-102');
create or replace function leads.set_property_alias(p_client_slug text, p_alias text, p_canonical text, p_note text default null)
returns void
language plpgsql security definer set search_path = leads, pg_temp as $$
declare
  v_client uuid;
begin
  select id into v_client from clients where slug = p_client_slug;
  if v_client is null then
    raise exception 'client % not found', p_client_slug;
  end if;
  insert into property_aliases (client_id, alias, canonical, note)
  values (v_client, trim(p_alias), trim(p_canonical), p_note)
  on conflict (client_id, alias) do update set canonical = excluded.canonical, note = excluded.note;
end;
$$;

-- ingest_lead: ίδια με πριν, με επίλυση των κωδικών μέσω property_aliases.
create or replace function leads.ingest_lead(p_raw_event_id bigint, p_lead jsonb) returns jsonb
language plpgsql security definer set search_path = leads, pg_temp as $$
declare
  r            raw_events%rowtype;
  c            clients%rowtype;
  v_at         timestamptz;
  v_source     text := nullif(trim(p_lead->>'source'), '');
  v_phones     text[];
  v_emails     text[];
  v_dropped    text[];
  v_matched    uuid[];
  v_contact    uuid;
  v_created    boolean := false;
  v_tokens     text[];
  v_old_tokens text[];
  v_hash       text := p_lead->>'message_hash';
  v_refs       text[];
  v_ref        text;
  v_inq        bigint;
  v_returning  boolean;
  v_inserted   int;
  v_results    jsonb := '[]';
  v_reviews    jsonb := '[]';
  v_other      uuid;
begin
  select * into r from raw_events where id = p_raw_event_id for update;
  if not found then
    raise exception 'raw_event % not found', p_raw_event_id;
  end if;

  -- Idempotent: αν έχει ήδη γίνει ingest, επιστρέφει ό,τι έγινε τότε.
  if r.status = 'processed' then
    return jsonb_build_object(
      'status', 'already_processed',
      'inquiries', coalesce((select jsonb_agg(jsonb_build_object('id', ie.inquiry_id, 'action', ie.kind))
                             from inquiry_events ie where ie.raw_event_id = r.id), '[]'));
  end if;
  if r.client_id is null then
    raise exception 'raw_event % has no client', p_raw_event_id;
  end if;
  if v_source is null then
    raise exception 'ingest_lead: lead.source is required';
  end if;
  if v_hash is null or v_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'ingest_lead: lead.message_hash must be a sha256 hex digest';
  end if;

  perform _client_lock(r.client_id);
  select * into c from clients where id = r.client_id;
  v_at := r.occurred_at;

  -- 1. Identifiers: έλεγχος μορφής (bug στο lead-core = exception = failed, όχι σκουπίδια).
  select coalesce(array_agg(distinct p order by p), '{}') into v_phones
  from (select x->>'e164' as p from jsonb_array_elements(coalesce(p_lead->'phones', '[]')) x) s
  where p is not null;
  select coalesce(array_agg(distinct e order by e), '{}') into v_emails
  from (select lower(trim(x->>'value')) as e from jsonb_array_elements(coalesce(p_lead->'emails', '[]')) x) s
  where e is not null and e <> '';

  if exists (select 1 from unnest(v_phones) p where p !~ '^\+[1-9][0-9]{7,14}$') then
    raise exception 'ingest_lead: invalid phone format in %', v_phones;
  end if;
  if exists (select 1 from unnest(v_emails) e where e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then
    raise exception 'ingest_lead: invalid email format in %', v_emails;
  end if;

  -- 2. Placeholders: αφαιρούνται.
  select coalesce(array_agg(pv.value_normalized), '{}') into v_dropped
  from placeholder_values pv
  where (pv.client_id is null or pv.client_id = r.client_id)
    and ((pv.kind = 'phone' and pv.value_normalized = any (v_phones))
         or (pv.kind = 'email' and pv.value_normalized = any (v_emails)));
  v_phones := array(select p from unnest(v_phones) p where p <> all (v_dropped));
  v_emails := array(select e from unnest(v_emails) e where e <> all (v_dropped));

  if cardinality(v_phones) = 0 and cardinality(v_emails) = 0 then
    update raw_events
    set status = 'needs_review', source = v_source, parser_version = p_lead->>'parser_version',
        locked_until = null,
        last_error = case when cardinality(v_dropped) > 0 then 'placeholder identifiers' else 'no identifier' end
    where id = r.id;
    perform _open_review(r.client_id,
                         case when cardinality(v_dropped) > 0 then 'placeholder' else 'no_identifier' end,
                         true, r.id, null, null, null,
                         case when cardinality(v_dropped) > 0
                              then 'Μόνο placeholder στοιχεία: ' || array_to_string(v_dropped, ', ')
                              else 'Ούτε τηλέφωνο ούτε email' end);
    return jsonb_build_object('status', 'needs_review',
                              'review', case when cardinality(v_dropped) > 0 then 'placeholder' else 'no_identifier' end);
  end if;

  -- 3. Ταυτοποίηση.
  v_tokens := coalesce(array(select jsonb_array_elements_text(coalesce(p_lead->'name_tokens', '[]'))), '{}');

  select coalesce(array_agg(distinct ci.contact_id), '{}') into v_matched
  from contact_identifiers ci
  where ci.client_id = r.client_id
    and ((ci.kind = 'phone' and ci.value_normalized = any (v_phones))
         or (ci.kind = 'email' and ci.value_normalized = any (v_emails)));

  if cardinality(v_matched) = 0 then
    insert into contacts (client_id, first_name, last_name, full_name_raw, name_tokens, last_activity_at)
    values (r.client_id, nullif(trim(p_lead->>'first_name'), ''), nullif(trim(p_lead->>'last_name'), ''),
            nullif(trim(p_lead->>'full_name_raw'), ''), v_tokens, v_at)
    returning id into v_contact;
    v_created := true;
  else
    -- Προτεραιότητα στο τηλέφωνο (με τη σειρά που ήρθαν), μετά στο email.
    select ci.contact_id into v_contact
    from jsonb_array_elements(coalesce(p_lead->'phones', '[]')) with ordinality x(j, ord)
    join contact_identifiers ci
      on ci.client_id = r.client_id and ci.kind = 'phone' and ci.value_normalized = x.j->>'e164'
    order by x.ord limit 1;

    if v_contact is null then
      select ci.contact_id into v_contact
      from jsonb_array_elements(coalesce(p_lead->'emails', '[]')) with ordinality x(j, ord)
      join contact_identifiers ci
        on ci.client_id = r.client_id and ci.kind = 'email' and ci.value_normalized = lower(trim(x.j->>'value'))
      order by x.ord limit 1;
    end if;

    -- Συμπλήρωση κενών, ποτέ overwrite.
    select name_tokens into v_old_tokens from contacts where id = v_contact;
    update contacts
    set first_name    = coalesce(first_name, nullif(trim(p_lead->>'first_name'), '')),
        last_name     = coalesce(last_name, nullif(trim(p_lead->>'last_name'), '')),
        full_name_raw = coalesce(full_name_raw, nullif(trim(p_lead->>'full_name_raw'), '')),
        name_tokens   = case when cardinality(name_tokens) = 0 then v_tokens else name_tokens end
    where id = v_contact;

    -- Δύο ή περισσότεροι contacts: attach στο τηλέφωνο + review, όχι αυτόματο merge.
    foreach v_other in array v_matched loop
      if v_other <> v_contact then
        perform _open_review(r.client_id, 'possible_merge', false, r.id, v_contact, v_other, null,
                             'Τα στοιχεία του lead ταιριάζουν σε περισσότερους από έναν contacts');
        v_reviews := v_reviews || jsonb_build_object('kind', 'possible_merge', 'related_contact_id', v_other);
      end if;
    end loop;

    -- Ίδιο identifier με εντελώς διαφορετικό όνομα: attach + flag.
    if cardinality(v_old_tokens) > 0 and cardinality(v_tokens) > 0 and not (v_old_tokens && v_tokens) then
      perform _open_review(r.client_id, 'name_mismatch', false, r.id, v_contact, null, null,
                           format('Υπάρχον όνομα: %s · νέο: %s',
                                  array_to_string(v_old_tokens, ' '), array_to_string(v_tokens, ' ')));
      v_reviews := v_reviews || jsonb_build_object('kind', 'name_mismatch');
    end if;
  end if;

  -- Νέα identifiers. Όσα ανήκουν ήδη σε άλλον contact παραλείπονται (unique).
  insert into contact_identifiers (client_id, contact_id, kind, value_normalized, value_raw, first_raw_event_id)
  select r.client_id, v_contact, 'phone', x->>'e164', x->>'raw', r.id
  from jsonb_array_elements(coalesce(p_lead->'phones', '[]')) x
  where x->>'e164' = any (v_phones)
  on conflict (client_id, kind, value_normalized) do nothing;

  insert into contact_identifiers (client_id, contact_id, kind, value_normalized, value_raw, first_raw_event_id)
  select r.client_id, v_contact, 'email', lower(trim(x->>'value')), x->>'raw', r.id
  from jsonb_array_elements(coalesce(p_lead->'emails', '[]')) x
  where lower(trim(x->>'value')) = any (v_emails)
  on conflict (client_id, kind, value_normalized) do nothing;

  -- 4. Inquiries.
  -- Αντιστοίχιση κωδικών: το ίδιο ακίνητο από διαφορετικές πηγές (π.χ. spitogatos:123 και
  -- fb_ad:456) → ένας κανονικός κωδικός (π.χ. site:KAL-102), ώστε να γίνεται ένα ενδιαφέρον.
  v_refs := coalesce(array(
    select distinct coalesce(pa.canonical, t)
    from jsonb_array_elements_text(coalesce(p_lead->'property_refs', '[]')) t
    left join property_aliases pa on pa.client_id = r.client_id and pa.alias = t
    where nullif(trim(t), '') is not null), '{}');
  if cardinality(v_refs) = 0 then
    v_refs := array[null::text];
  end if;

  foreach v_ref in array v_refs loop
    v_inq := null;

    select i.id into v_inq
    from inquiries i
    where i.contact_id = v_contact
      and i.property_ref is not distinct from v_ref
      and (v_ref is not null or i.message_hash = v_hash)
      and i.first_seen_at > v_at - c.dedup_window
      and i.first_seen_at < v_at + c.dedup_window
    order by i.first_seen_at desc
    limit 1;

    if v_inq is not null then
      insert into inquiry_events (raw_event_id, inquiry_id, kind) values (r.id, v_inq, 'touch')
      on conflict do nothing;
      get diagnostics v_inserted = row_count;
      if v_inserted > 0 then
        update inquiries
        set touch_count = touch_count + 1, last_touch_at = greatest(last_touch_at, v_at)
        where id = v_inq;
      end if;
      v_results := v_results || jsonb_build_object('id', v_inq, 'action', 'touch', 'property_ref', v_ref);
    else
      v_returning := exists (
        select 1 from inquiries i
        where i.contact_id = v_contact and i.property_ref is not distinct from v_ref
          and i.first_seen_at <= v_at - c.dedup_window);

      insert into inquiries (client_id, contact_id, source, property_ref, message, message_hash, context,
                             first_seen_at, last_touch_at, is_returning)
      values (r.client_id, v_contact, v_source, v_ref, p_lead->>'message', v_hash,
              coalesce(p_lead->'context', '{}')
                || jsonb_build_object('source_refs', coalesce(p_lead->'property_refs', '[]')),
              v_at, v_at, v_returning)
      returning id into v_inq;

      insert into inquiry_events (raw_event_id, inquiry_id, kind) values (r.id, v_inq, 'created');
      insert into outbox (client_id, kind, inquiry_id) values (r.client_id, 'new_inquiry', v_inq);
      v_results := v_results || jsonb_build_object('id', v_inq, 'action', 'created', 'property_ref', v_ref,
                                                   'is_returning', v_returning);
    end if;
  end loop;

  -- 5. Κλείσιμο.
  update contacts set last_activity_at = greatest(last_activity_at, v_at) where id = v_contact;

  update raw_events
  set status = 'processed', source = v_source, parser_version = p_lead->>'parser_version',
      processed_at = now(), locked_until = null, last_error = null
  where id = r.id;

  -- Αν ήταν σε review (π.χ. reprocess μετά από διόρθωση parser), κλείνουν τα blocking items του.
  update review_queue
  set status = 'resolved', resolution = 'auto: ingested', resolved_at = now(), resolved_by = 'system'
  where raw_event_id = r.id and blocking and status = 'open';

  return jsonb_build_object(
    'status', 'processed',
    'contact_id', v_contact,
    'contact_created', v_created,
    'dropped_placeholders', to_jsonb(v_dropped),
    'inquiries', v_results,
    'reviews', v_reviews);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. claim ανά κανάλι
-- ---------------------------------------------------------------------------

create or replace function leads.claim_raw_events(p_limit int, p_lease interval, p_channel text)
returns table (raw_event_id bigint, client_id uuid, channel text, external_id text,
               occurred_at timestamptz, attempts int, payload jsonb, client jsonb, routes jsonb)
language plpgsql security definer set search_path = leads, pg_temp as $$
begin
  return query
  with picked as (
    select r.id from raw_events r
    where r.client_id is not null
      and r.channel = p_channel
      and ((r.status in ('pending', 'failed') and r.next_attempt_at <= now())
           or (r.status = 'processing' and r.locked_until < now()))
    order by r.next_attempt_at
    limit p_limit
    for update skip locked
  ), upd as (
    update raw_events r
    set status = 'processing', locked_until = now() + p_lease, attempts = r.attempts + 1
    from picked where r.id = picked.id
    returning r.*
  )
  select u.id, u.client_id, u.channel, u.external_id, u.occurred_at, u.attempts, u.payload,
         jsonb_build_object('id', c.id, 'slug', c.slug, 'name', c.name, 'default_region', c.default_region),
         case when u.channel = 'gmail' then
           coalesce((select jsonb_agg(jsonb_build_object(
                       'id', er.id, 'source', er.source, 'parser', er.parser, 'match_from', er.match_from,
                       'match_subject', er.match_subject, 'priority', er.priority) order by er.priority, er.id)
                     from email_routes er where er.client_id = u.client_id and er.active), '[]'::jsonb)
         else '[]'::jsonb end
  from upd u join clients c on c.id = u.client_id;
end;
$$;

-- Η παλιά μορφή (που καλεί το υπάρχον workflow «2 Process») παίρνει πλέον ΜΟΝΟ emails.
create or replace function leads.claim_raw_events(p_limit int default 10, p_lease interval default interval '5 minutes')
returns table (raw_event_id bigint, client_id uuid, channel text, external_id text,
               occurred_at timestamptz, attempts int, payload jsonb, client jsonb, routes jsonb)
language sql security definer set search_path = leads, pg_temp as $$
  select * from leads.claim_raw_events(p_limit, p_lease, 'gmail');
$$;

-- ---------------------------------------------------------------------------
-- 3. Heartbeat για πηγές χωρίς email route
-- ---------------------------------------------------------------------------

alter table leads.source_accounts add column if not exists heartbeat_max_silence interval;

create or replace function leads.heartbeat_report()
returns table (client_slug text, source text, max_silence interval, last_seen_at timestamptz, silent_for interval, alert boolean)
language sql security definer set search_path = leads, pg_temp as $$
  select c.slug, er.source, er.heartbeat_max_silence, ls.last_seen,
         now() - coalesce(ls.last_seen, er.created_at),
         now() - coalesce(ls.last_seen, er.created_at) > er.heartbeat_max_silence
  from email_routes er
  join clients c on c.id = er.client_id and c.active
  left join lateral (
    select max(r.occurred_at) as last_seen from raw_events r
    where r.client_id = er.client_id and r.source = er.source
  ) ls on true
  where er.active and er.heartbeat_max_silence is not null
  union all
  select c.slug, sa.channel, sa.heartbeat_max_silence, ls.last_seen,
         now() - coalesce(ls.last_seen, sa.created_at),
         now() - coalesce(ls.last_seen, sa.created_at) > sa.heartbeat_max_silence
  from source_accounts sa
  join clients c on c.id = sa.client_id and c.active
  left join lateral (
    select max(r.occurred_at) as last_seen from raw_events r
    where r.client_id = sa.client_id and r.channel = sa.channel and r.recipient = sa.identifier
  ) ls on true
  where sa.active and sa.channel <> 'gmail' and sa.heartbeat_max_silence is not null;
$$;

-- Σελίδες Facebook ανά πελάτη, για το reconciliation.
create or replace function leads.fb_pages()
returns table (client_slug text, page_id text)
language sql security definer set search_path = leads, pg_temp as $$
  select c.slug, sa.identifier
  from source_accounts sa join clients c on c.id = sa.client_id and c.active
  where sa.channel = 'fb_leadgen' and sa.active
  order by c.slug, sa.identifier;
$$;

-- ---------------------------------------------------------------------------
-- 4. Θύρα για τον receiver της Meta (Edge Function, με service_role)
-- ---------------------------------------------------------------------------
-- Το schema leads δεν εκτίθεται στο REST API. Η Edge Function καλεί αυτή τη μία
-- function στο public, που επιτρέπεται ΜΟΝΟ στο service_role.

create or replace function public.leads_capture_meta_event(
  p_channel text, p_external_id text, p_recipient text, p_occurred_at timestamptz, p_payload jsonb
) returns table (raw_event_id bigint, created boolean, client_id uuid)
language plpgsql security definer set search_path = leads, pg_temp as $$
begin
  if p_channel not in ('fb_leadgen', 'whatsapp') then
    raise exception 'channel % not allowed here', p_channel;
  end if;
  return query select * from leads.capture_raw_event(p_channel, p_external_id, p_recipient, p_occurred_at, p_payload);
end;
$$;

revoke all on function public.leads_capture_meta_event(text, text, text, timestamptz, jsonb) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.leads_capture_meta_event(text, text, text, timestamptz, jsonb) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.leads_capture_meta_event(text, text, text, timestamptz, jsonb) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.leads_capture_meta_event(text, text, text, timestamptz, jsonb) to service_role;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Δικαιώματα για το n8n
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema leads from public;
grant execute on function
  leads.capture_raw_event(text, text, text, timestamptz, jsonb),
  leads.claim_raw_events(int, interval),
  leads.claim_raw_events(int, interval, text),
  leads.mark_raw_failed(bigint, text, int),
  leads.mark_raw_review(bigint, text, text, text, text),
  leads.mark_raw_ignored(bigint, text, text),
  leads.reprocess_raw_event(bigint),
  leads.ingest_lead(bigint, jsonb),
  leads.claim_outbox(int, interval),
  leads.mark_outbox_sent(bigint),
  leads.mark_outbox_failed(bigint, text, int),
  leads.resolve_review(bigint, text, jsonb, text),
  leads.merge_contacts(uuid, uuid),
  leads.erase_contact(uuid),
  leads.ops_alert_should_send(text, interval),
  leads.heartbeat_report(),
  leads.stale_blocking_reviews(interval),
  leads.daily_report(interval),
  leads.purge_old_payloads(interval),
  leads.set_property_alias(text, text, text, text),
  leads.fb_pages()
to n8n_app;
