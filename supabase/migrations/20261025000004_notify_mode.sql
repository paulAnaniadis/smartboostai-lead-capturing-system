-- Ειδοποίηση agent ανά πελάτη.
--
-- Ο agent λαμβάνει τα leads απευθείας (το σύστημα παίρνει αντίγραφο με προώθηση),
-- οπότε από προεπιλογή το σύστημα ΔΕΝ του στέλνει email: μόνο καταγράφει.
--   notify_mode = 'none' → καμία ειδοποίηση (default)
--   notify_mode = 'all'  → email «Νέο lead» στα notify_emails για κάθε νέο inquiry

alter table leads.clients
  add column if not exists notify_mode text not null default 'none'
  check (notify_mode in ('none', 'all'));

-- Αντί να αλλάξουμε το ingest_lead: το outbox απλώς δεν γράφεται για πελάτες
-- χωρίς ειδοποιήσεις (ή χωρίς παραλήπτες).
create or replace function leads._outbox_respect_notify_mode() returns trigger
language plpgsql as $$
begin
  if exists (
    select 1 from leads.clients c
    where c.id = new.client_id
      and (c.notify_mode = 'none' or cardinality(c.notify_emails) = 0)
  ) then
    return null;
  end if;
  return new;
end;
$$;

drop trigger if exists outbox_respect_notify_mode on leads.outbox;
create trigger outbox_respect_notify_mode
  before insert on leads.outbox
  for each row execute function leads._outbox_respect_notify_mode();

revoke execute on function leads._outbox_respect_notify_mode() from public;
