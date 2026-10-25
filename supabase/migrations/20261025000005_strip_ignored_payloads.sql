-- Emails που δεν στάλθηκαν σε διεύθυνση πελάτη (π.χ. παλιά/προσωπικά emails του mailbox,
-- spam) δεν είναι leads. Δεν κρατάμε το περιεχόμενό τους: μόνο αποστολέα, θέμα, ημερομηνία
-- και Message-ID (για να μην ξαναδιαβαστούν). Προσωπικά δεδομένα τρίτων δεν μπαίνουν στη βάση.

create or replace function leads.capture_raw_event(
  p_channel text, p_external_id text, p_recipient text, p_occurred_at timestamptz, p_payload jsonb
) returns table (raw_event_id bigint, created boolean, client_id uuid)
language plpgsql security definer set search_path = leads, pg_temp as $$
declare
  v_client uuid;
  v_id bigint;
  v_recipient text := nullif(lower(trim(p_recipient)), '');
  v_status raw_status;
begin
  if p_external_id is null or length(trim(p_external_id)) = 0 then
    raise exception 'capture_raw_event: external_id is required';
  end if;

  select sa.client_id into v_client
  from source_accounts sa
  where sa.channel = p_channel and sa.identifier = v_recipient and sa.active;

  v_status := case
    when v_client is not null then 'pending'
    when v_recipient is null then 'ignored'
    else 'needs_review'
  end;

  insert into raw_events (client_id, channel, external_id, recipient, occurred_at, payload, status,
                          last_error, processed_at, payload_purged_at)
  values (v_client, p_channel, trim(p_external_id), v_recipient, coalesce(p_occurred_at, now()),
          case when v_status = 'ignored'
               then jsonb_build_object('headers', jsonb_build_object(
                      'from', p_payload->'headers'->'from',
                      'subject', p_payload->'headers'->'subject',
                      'date', p_payload->'headers'->'date',
                      'message_id', p_payload->'headers'->'message_id'))
               else p_payload end,
          v_status,
          case when v_status = 'ignored' then 'not addressed to a client address' end,
          case when v_status = 'ignored' then now() end,
          case when v_status = 'ignored' then now() end)
  on conflict on constraint raw_events_dedup do nothing
  returning id into v_id;

  if v_id is null then
    select r.id into v_id from raw_events r
    where r.client_id is not distinct from v_client and r.channel = p_channel
      and r.external_id = trim(p_external_id);
    return query select v_id, false, v_client;
    return;
  end if;

  if v_status = 'needs_review' then
    perform _open_review(null, 'unknown_recipient', true, v_id, null, null, null,
                         'Άγνωστη διεύθυνση πελάτη: ' || v_recipient ||
                         ' (λείπει από τα source_accounts;)');
  end if;

  return query select v_id, true, v_client;
end;
$$;

grant execute on function leads.capture_raw_event(text, text, text, timestamptz, jsonb) to n8n_app;
