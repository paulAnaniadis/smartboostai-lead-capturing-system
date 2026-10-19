-- Lead Capture System: functions (το API που καλεί το n8n).
-- Όλες security definer με σταθερό search_path. Το n8n_app έχει μόνο EXECUTE.

-- ---------------------------------------------------------------------------
-- Βοηθητικές
-- ---------------------------------------------------------------------------

create or replace function leads._client_lock(p_client_id uuid) returns void
language sql as $$
  select pg_advisory_xact_lock(hashtextextended('leads:' || p_client_id::text, 0));
$$;

-- Ανοίγει review item. Αν υπάρχει ήδη ανοιχτό ίδιο item, δεν κάνει τίποτα.
create or replace function leads._open_review(
  p_client_id uuid, p_kind text, p_blocking boolean, p_raw_event_id bigint,
  p_contact_id uuid default null, p_related_contact_id uuid default null,
  p_inquiry_id bigint default null, p_note text default null
) returns void
language sql as $$
  insert into leads.review_queue
    (client_id, kind, blocking, raw_event_id, contact_id, related_contact_id, inquiry_id, note)
  values
    (p_client_id, p_kind, p_blocking, p_raw_event_id, p_contact_id, p_related_contact_id, p_inquiry_id, p_note)
  on conflict do nothing;
$$;

-- ---------------------------------------------------------------------------
-- Capture: γράφει το γεγονός αυτούσιο. Idempotent.
-- ---------------------------------------------------------------------------

create or replace function leads.capture_raw_event(
  p_channel text, p_external_id text, p_recipient text, p_occurred_at timestamptz, p_payload jsonb
) returns table (raw_event_id bigint, created boolean, client_id uuid)
language plpgsql security definer set search_path = leads, pg_temp as $$
declare
  v_client uuid;
  v_id bigint;
  v_recipient text := lower(trim(p_recipient));
begin
  if p_external_id is null or length(trim(p_external_id)) = 0 then
    raise exception 'capture_raw_event: external_id is required';
  end if;

  select sa.client_id into v_client
  from source_accounts sa
  where sa.channel = p_channel and sa.identifier = v_recipient and sa.active;

  insert into raw_events (client_id, channel, external_id, recipient, occurred_at, payload,
                          status)
  values (v_client, p_channel, trim(p_external_id), v_recipient, coalesce(p_occurred_at, now()), p_payload,
          case when v_client is null then 'needs_review'::raw_status else 'pending'::raw_status end)
  on conflict on constraint raw_events_dedup do nothing
  returning id into v_id;

  if v_id is null then
    select r.id into v_id from raw_events r
    where r.client_id is not distinct from v_client and r.channel = p_channel
      and r.external_id = trim(p_external_id);
    return query select v_id, false, v_client;
    return;
  end if;

  if v_client is null then
    perform _open_review(null, 'unknown_recipient', true, v_id, null, null, null,
                         'Άγνωστος παραλήπτης: ' || coalesce(v_recipient, '(κενό)'));
  end if;

  return query select v_id, true, v_client;
end;
$$;

-- ---------------------------------------------------------------------------
-- Processing: claim / failed / review / ignored / reprocess
-- ---------------------------------------------------------------------------

-- Παίρνει έως p_limit γεγονότα για επεξεργασία, μαζί με τη ρύθμιση του πελάτη
-- και τα email routes, ώστε ο processor να μη χρειάζεται δεύτερη κλήση.
create or replace function leads.claim_raw_events(p_limit int default 10, p_lease interval default interval '5 minutes')
returns table (raw_event_id bigint, client_id uuid, channel text, external_id text,
               occurred_at timestamptz, attempts int, payload jsonb, client jsonb, routes jsonb)
language plpgsql security definer set search_path = leads, pg_temp as $$
begin
  return query
  with picked as (
    select r.id from raw_events r
    where r.client_id is not null
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
         coalesce((select jsonb_agg(jsonb_build_object(
                     'id', er.id, 'source', er.source, 'parser', er.parser, 'match_from', er.match_from,
                     'match_subject', er.match_subject, 'priority', er.priority) order by er.priority, er.id)
                   from email_routes er where er.client_id = u.client_id and er.active), '[]'::jsonb)
  from upd u join clients c on c.id = u.client_id;
end;
$$;

-- Παροδικό σφάλμα: backoff 2,4,8,16 λεπτά, μετά dead. Επιστρέφει {status, alert}.
create or replace function leads.mark_raw_failed(p_raw_event_id bigint, p_error text, p_max_attempts int default 5)
returns jsonb
language plpgsql security definer set search_path = leads, pg_temp as $$
declare
  v_attempts int;
  v_status raw_status;
begin
  select attempts into v_attempts from raw_events where id = p_raw_event_id for update;
  if not found then
    raise exception 'raw_event % not found', p_raw_event_id;
  end if;

  v_status := case when v_attempts >= p_max_attempts then 'dead'::raw_status else 'failed'::raw_status end;

  update raw_events
  set status = v_status, last_error = left(p_error, 4000), locked_until = null,
      next_attempt_at = now() + make_interval(mins => power(2, greatest(v_attempts, 1))::int)
  where id = p_raw_event_id and status = 'processing';

  return jsonb_build_object('status', v_status, 'attempts', v_attempts, 'alert', v_status = 'dead');
end;
$$;

-- Ντετερμινιστικό πρόβλημα: needs_review + blocking review item.
create or replace function leads.mark_raw_review(
  p_raw_event_id bigint, p_kind text, p_note text default null,
  p_source text default null, p_parser_version text default null
) returns void
language plpgsql security definer set search_path = leads, pg_temp as $$
declare
  v_client uuid;
begin
  update raw_events
  set status = 'needs_review', locked_until = null, last_error = p_note,
      source = coalesce(p_source, source), parser_version = coalesce(p_parser_version, parser_version)
  where id = p_raw_event_id and status <> 'processed'
  returning client_id into v_client;

  if not found then
    raise exception 'raw_event % not found or already processed', p_raw_event_id;
  end if;

  perform _open_review(v_client, p_kind, true, p_raw_event_id, null, null, null, p_note);
end;
$$;

-- Δεν είναι lead (π.χ. route με parser=ignore).
create or replace function leads.mark_raw_ignored(p_raw_event_id bigint, p_reason text, p_source text default null)
returns void
language sql security definer set search_path = leads, pg_temp as $$
  update raw_events
  set status = 'ignored', locked_until = null, last_error = p_reason,
      source = coalesce(p_source, source), processed_at = now()
  where id = p_raw_event_id and status <> 'processed';
$$;

create or replace function leads.reprocess_raw_event(p_raw_event_id bigint) returns boolean
language plpgsql security definer set search_path = leads, pg_temp as $$
begin
  update raw_events
  set status = 'pending', attempts = 0, next_attempt_at = now(), locked_until = null
  where id = p_raw_event_id and status in ('needs_review', 'dead', 'failed', 'ignored')
    and client_id is not null;
  return found;
end;
$$;

-- ---------------------------------------------------------------------------
-- ingest_lead: ταυτοποίηση + dedup σε ένα transaction.
--
-- p_lead (παράγεται από lead-core):
-- { source, full_name_raw, first_name, last_name, name_tokens[],
--   phones: [{e164, raw}], emails: [{value, raw}],
--   message, message_hash, property_refs[], context{}, parser, parser_version }
-- ---------------------------------------------------------------------------

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
  v_refs := coalesce(array(select distinct t from jsonb_array_elements_text(coalesce(p_lead->'property_refs', '[]')) t
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
              coalesce(p_lead->'context', '{}'), v_at, v_at, v_returning)
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
-- Outbox
-- ---------------------------------------------------------------------------

-- Επιστρέφει items έτοιμα για αποστολή: inquiry + contact + identifiers + ρύθμιση πελάτη.
create or replace function leads.claim_outbox(p_limit int default 10, p_lease interval default interval '5 minutes')
returns table (outbox_id bigint, kind text, attempts int, item jsonb)
language plpgsql security definer set search_path = leads, pg_temp as $$
begin
  return query
  with picked as (
    select o.id from outbox o
    where (o.status in ('pending', 'failed') and o.next_attempt_at <= now())
       or (o.status = 'processing' and o.locked_until < now())
    order by o.next_attempt_at
    limit p_limit
    for update skip locked
  ), upd as (
    update outbox o
    set status = 'processing', locked_until = now() + p_lease, attempts = o.attempts + 1
    from picked where o.id = picked.id
    returning o.*
  )
  select u.id, u.kind, u.attempts,
         jsonb_build_object(
           'client', jsonb_build_object('id', cl.id, 'slug', cl.slug, 'name', cl.name,
                                        'notify_emails', to_jsonb(cl.notify_emails), 'sheet_id', cl.sheet_id),
           'inquiry', jsonb_build_object('id', i.id, 'source', i.source, 'property_ref', i.property_ref,
                                         'message', i.message, 'context', i.context,
                                         'first_seen_at', i.first_seen_at, 'is_returning', i.is_returning),
           'contact', jsonb_build_object(
             'id', ct.id, 'first_name', ct.first_name, 'last_name', ct.last_name,
             'full_name_raw', ct.full_name_raw,
             'phones', coalesce((select jsonb_agg(ci.value_normalized order by ci.id) from contact_identifiers ci
                                 where ci.contact_id = ct.id and ci.kind = 'phone'), '[]'),
             'emails', coalesce((select jsonb_agg(ci.value_normalized order by ci.id) from contact_identifiers ci
                                 where ci.contact_id = ct.id and ci.kind = 'email'), '[]'),
             'previous_inquiries', (select count(*) from inquiries i2
                                    where i2.contact_id = ct.id and i2.id <> i.id)),
           'flags', coalesce((select jsonb_agg(distinct rq.kind) from review_queue rq
                              join inquiry_events ie on ie.raw_event_id = rq.raw_event_id
                              where ie.inquiry_id = i.id and rq.status = 'open' and not rq.blocking), '[]'))
  from upd u
  join inquiries i on i.id = u.inquiry_id
  join contacts ct on ct.id = i.contact_id
  join clients cl on cl.id = u.client_id;
end;
$$;

create or replace function leads.mark_outbox_sent(p_outbox_id bigint) returns void
language sql security definer set search_path = leads, pg_temp as $$
  update outbox set status = 'sent', sent_at = now(), locked_until = null, last_error = null
  where id = p_outbox_id;
$$;

create or replace function leads.mark_outbox_failed(p_outbox_id bigint, p_error text, p_max_attempts int default 5)
returns jsonb
language plpgsql security definer set search_path = leads, pg_temp as $$
declare
  v_attempts int;
  v_status text;
begin
  select attempts into v_attempts from outbox where id = p_outbox_id for update;
  if not found then
    raise exception 'outbox % not found', p_outbox_id;
  end if;
  v_status := case when v_attempts >= p_max_attempts then 'dead' else 'failed' end;
  update outbox
  set status = v_status, last_error = left(p_error, 4000), locked_until = null,
      next_attempt_at = now() + make_interval(mins => power(2, greatest(v_attempts, 1))::int)
  where id = p_outbox_id;
  return jsonb_build_object('status', v_status, 'attempts', v_attempts, 'alert', v_status = 'dead');
end;
$$;

-- ---------------------------------------------------------------------------
-- Review queue: επίλυση, merge, GDPR erase
-- ---------------------------------------------------------------------------

create or replace function leads.merge_contacts(p_survivor uuid, p_merged uuid) returns void
language plpgsql security definer set search_path = leads, pg_temp as $$
declare
  s contacts%rowtype;
  m contacts%rowtype;
begin
  if p_survivor = p_merged then
    raise exception 'merge_contacts: same contact';
  end if;
  select * into s from contacts where id = p_survivor;
  select * into m from contacts where id = p_merged;
  if s.id is null or m.id is null then
    raise exception 'merge_contacts: contact not found';
  end if;
  if s.client_id <> m.client_id then
    raise exception 'merge_contacts: contacts belong to different clients';
  end if;
  if s.merged_into is not null or m.merged_into is not null then
    raise exception 'merge_contacts: contact already merged';
  end if;

  perform _client_lock(s.client_id);

  update contact_identifiers set contact_id = p_survivor where contact_id = p_merged;
  update inquiries set contact_id = p_survivor where contact_id = p_merged;
  update contacts
  set first_name    = coalesce(first_name, m.first_name),
      last_name     = coalesce(last_name, m.last_name),
      full_name_raw = coalesce(full_name_raw, m.full_name_raw),
      name_tokens   = case when cardinality(name_tokens) = 0 then m.name_tokens else name_tokens end,
      created_at    = least(created_at, m.created_at),
      last_activity_at = greatest(last_activity_at, m.last_activity_at)
  where id = p_survivor;
  update contacts set merged_into = p_survivor where id = p_merged;

  update review_queue
  set status = 'resolved', resolution = 'merged', resolved_at = now(), resolved_by = coalesce(resolved_by, 'system')
  where status = 'open' and kind = 'possible_merge'
    and ((contact_id = p_survivor and related_contact_id = p_merged)
      or (contact_id = p_merged and related_contact_id = p_survivor));
end;
$$;

-- p_action: dismiss | ignore | reprocess | ingest_manual | merge
create or replace function leads.resolve_review(p_review_id bigint, p_action text, p_data jsonb default '{}', p_by text default 'operator')
returns jsonb
language plpgsql security definer set search_path = leads, pg_temp as $$
declare
  q review_queue%rowtype;
  v_result jsonb := '{}';
begin
  select * into q from review_queue where id = p_review_id for update;
  if not found then
    raise exception 'review % not found', p_review_id;
  end if;
  if q.status <> 'open' then
    raise exception 'review % is already resolved', p_review_id;
  end if;

  case p_action
    when 'dismiss' then
      null;
    when 'ignore' then
      if q.raw_event_id is null then raise exception 'ignore needs a raw event'; end if;
      perform mark_raw_ignored(q.raw_event_id, coalesce(p_data->>'reason', 'ignored by operator'));
    when 'reprocess' then
      if q.raw_event_id is null then raise exception 'reprocess needs a raw event'; end if;
      if not reprocess_raw_event(q.raw_event_id) then
        raise exception 'raw event % cannot be reprocessed (status or missing client)', q.raw_event_id;
      end if;
    when 'ingest_manual' then
      if q.raw_event_id is null then raise exception 'ingest_manual needs a raw event'; end if;
      v_result := ingest_lead(q.raw_event_id, p_data);
      if v_result->>'status' <> 'processed' then
        raise exception 'ingest_manual did not produce a lead: %', v_result;
      end if;
    when 'merge' then
      if q.contact_id is null or q.related_contact_id is null then
        raise exception 'merge needs two contacts';
      end if;
      perform merge_contacts(coalesce((p_data->>'survivor')::uuid, q.contact_id),
                             case when (p_data->>'survivor')::uuid = q.related_contact_id
                                  then q.contact_id else q.related_contact_id end);
    else
      raise exception 'unknown action %', p_action;
  end case;

  update review_queue
  set status = 'resolved', resolution = p_action || coalesce(': ' || nullif(p_data->>'note', ''), ''),
      resolved_at = now(), resolved_by = p_by
  where id = p_review_id and status = 'open';

  return jsonb_build_object('review_id', p_review_id, 'action', p_action, 'result', v_result);
end;
$$;

-- GDPR: διαγραφή ανθρώπου (και των shells που είχαν γίνει merge σε αυτόν).
create or replace function leads.erase_contact(p_contact_id uuid) returns jsonb
language plpgsql security definer set search_path = leads, pg_temp as $$
declare
  v_ids uuid[];
  v_inq bigint[];
  v_raw bigint[];
begin
  v_ids := array(select id from contacts where id = p_contact_id or merged_into = p_contact_id);
  if cardinality(v_ids) = 0 then
    raise exception 'contact % not found', p_contact_id;
  end if;
  v_inq := array(select id from inquiries where contact_id = any (v_ids));
  v_raw := array(select distinct raw_event_id from inquiry_events where inquiry_id = any (v_inq));

  update raw_events set payload = '{}', payload_purged_at = now() where id = any (v_raw);
  delete from outbox where inquiry_id = any (v_inq);
  delete from review_queue where contact_id = any (v_ids) or related_contact_id = any (v_ids) or inquiry_id = any (v_inq);
  delete from inquiry_events where inquiry_id = any (v_inq);
  delete from inquiries where id = any (v_inq);
  delete from contact_identifiers where contact_id = any (v_ids);
  update contacts set merged_into = null where id = any (v_ids);
  delete from contacts where id = any (v_ids);

  return jsonb_build_object('contacts', cardinality(v_ids), 'inquiries', cardinality(v_inq),
                            'raw_events_purged', cardinality(v_raw));
end;
$$;

-- ---------------------------------------------------------------------------
-- Παρατηρησιμότητα
-- ---------------------------------------------------------------------------

-- true αν πρέπει να σταλεί το alert (το ίδιο key το πολύ μία φορά ανά p_every).
create or replace function leads.ops_alert_should_send(p_key text, p_every interval default interval '1 day')
returns boolean
language plpgsql security definer set search_path = leads, pg_temp as $$
declare
  v_send boolean;
begin
  insert into ops_alerts as a (key, last_sent_at) values (p_key, now())
  on conflict (key) do update
    set last_sent_at = case when a.last_sent_at <= now() - p_every then now() else a.last_sent_at end,
        count = a.count + 1
  returning last_sent_at = now() into v_send;
  return v_send;
end;
$$;

-- Πηγές που σιώπησαν περισσότερο από το όριό τους.
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
  group by c.slug, er.source, er.heartbeat_max_silence, ls.last_seen, er.created_at;
$$;

create or replace function leads.stale_blocking_reviews(p_older_than interval default interval '4 hours')
returns table (review_id bigint, client_slug text, kind text, raw_event_id bigint, note text, age interval)
language sql security definer set search_path = leads, pg_temp as $$
  select q.id, c.slug, q.kind, q.raw_event_id, q.note, now() - q.created_at
  from review_queue q left join clients c on c.id = q.client_id
  where q.status = 'open' and q.blocking and q.created_at < now() - p_older_than
  order by q.created_at;
$$;

create or replace function leads.daily_report(p_since interval default interval '24 hours') returns jsonb
language sql security definer set search_path = leads, pg_temp as $$
  select jsonb_build_object(
    'generated_at', now(),
    'window', p_since::text,
    'per_source', coalesce((
      select jsonb_agg(x order by x->>'client', x->>'source') from (
        select jsonb_build_object(
          'client', c.slug, 'source', i.source,
          'new_inquiries', count(*) filter (where ie.kind = 'created' and not i.is_returning),
          'returning', count(*) filter (where ie.kind = 'created' and i.is_returning),
          'touches', count(*) filter (where ie.kind = 'touch')) as x
        from inquiry_events ie
        join inquiries i on i.id = ie.inquiry_id
        join clients c on c.id = i.client_id
        where ie.created_at > now() - p_since
        group by c.slug, i.source) s), '[]'),
    'raw_by_status', coalesce((
      select jsonb_object_agg(status, n) from (
        select status::text, count(*) n from raw_events where received_at > now() - p_since group by status) s), '{}'),
    'open_reviews', coalesce((
      select jsonb_agg(jsonb_build_object('kind', kind, 'blocking', blocking, 'count', n)) from (
        select kind, blocking, count(*) n from review_queue where status = 'open' group by kind, blocking) s), '[]'),
    'dead_raw_events', (select count(*) from raw_events where status = 'dead'),
    'dead_outbox', (select count(*) from outbox where status = 'dead'),
    'last_seen', coalesce((
      select jsonb_agg(jsonb_build_object('client', h.client_slug, 'source', h.source,
                                          'last_seen_at', h.last_seen_at, 'alert', h.alert))
      from heartbeat_report() h), '[]'));
$$;

-- Retention: καθαρίζει payloads παλαιότερα από p_older_than (default 12 μήνες).
create or replace function leads.purge_old_payloads(p_older_than interval default interval '12 months') returns int
language plpgsql security definer set search_path = leads, pg_temp as $$
declare
  v_n int;
begin
  update raw_events set payload = '{}', payload_purged_at = now()
  where payload_purged_at is null and received_at < now() - p_older_than
    and status in ('processed', 'ignored');
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------------------
-- Δικαιώματα: n8n_app βλέπει μόνο το API.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'n8n_app') then
    create role n8n_app nologin;  -- login/password ορίζονται έξω από το migration
  end if;
end $$;

revoke all on schema leads from public;
revoke all on all tables in schema leads from public;
revoke execute on all functions in schema leads from public;
grant usage on schema leads to n8n_app;

grant execute on function
  leads.capture_raw_event(text, text, text, timestamptz, jsonb),
  leads.claim_raw_events(int, interval),
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
  leads.purge_old_payloads(interval)
to n8n_app;
