-- Lead Capture System: schema (Φάση 1, με χώρο για Φάσεις 2–3).
-- Όλα ζουν στο schema `leads`, που δεν εκτίθεται στο REST API του Supabase.
-- Το n8n μιλάει μόνο μέσω των functions (βλ. επόμενο migration), με role n8n_app.

create schema if not exists leads;

-- ---------------------------------------------------------------------------
-- Ρύθμιση
-- ---------------------------------------------------------------------------

create table leads.clients (
  id             uuid primary key default gen_random_uuid(),
  slug           text not null unique check (slug ~ '^[a-z0-9-]+$'),
  name           text not null,
  default_region text not null default 'GR' check (default_region in ('GR', 'CY')),
  dedup_window   interval not null default interval '48 hours',
  notify_emails  text[] not null default '{}',
  sheet_id       text,
  active         boolean not null default true,
  created_at     timestamptz not null default now()
);

-- Από πού έρχονται τα γεγονότα. Η ΜΟΝΗ πηγή του client_id.
create table leads.source_accounts (
  id         bigint generated always as identity primary key,
  client_id  uuid not null references leads.clients (id),
  channel    text not null check (channel in ('gmail', 'fb_leadgen', 'whatsapp')),
  identifier text not null,  -- gmail: plus-address (πεζά) · fb: page_id · wa: phone_number_id
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  unique (channel, identifier)
);

-- Ποια πηγή είναι ένα email και ποιος parser το διαβάζει.
create table leads.email_routes (
  id                    bigint generated always as identity primary key,
  client_id             uuid not null references leads.clients (id),
  source                text not null,            -- website | spitogatos | xe | ...
  parser                text not null,            -- π.χ. spitogatos_v1, website_form_v1, ignore
  match_from            text[] not null default '{}', -- διευθύνσεις ή '@domain'
  match_subject         text,                     -- regex (case-insensitive), προαιρετικό
  priority              int not null default 100, -- μικρότερο = πρώτο
  heartbeat_max_silence interval,
  active                boolean not null default true,
  created_at            timestamptz not null default now(),
  check (cardinality(match_from) > 0 or match_subject is not null)
);

-- Blacklist placeholder τιμών (test@test.com κ.λπ.). client_id null = global.
create table leads.placeholder_values (
  id               bigint generated always as identity primary key,
  client_id        uuid references leads.clients (id),
  kind             text not null check (kind in ('phone', 'email')),
  value_normalized text not null,
  unique nulls not distinct (client_id, kind, value_normalized)
);

-- ---------------------------------------------------------------------------
-- Γεγονότα
-- ---------------------------------------------------------------------------

create type leads.raw_status as enum (
  'pending', 'processing', 'processed', 'failed', 'dead', 'needs_review', 'ignored', 'waiting'
);

create table leads.raw_events (
  id                bigint generated always as identity primary key,
  client_id         uuid references leads.clients (id),  -- null μόνο για άγνωστο παραλήπτη
  channel           text not null check (channel in ('gmail', 'fb_leadgen', 'whatsapp')),
  external_id       text not null,
  recipient         text,
  occurred_at       timestamptz not null,
  received_at       timestamptz not null default now(),
  payload           jsonb not null,
  source            text,
  parser_version    text,
  status            leads.raw_status not null default 'pending',
  attempts          int not null default 0,
  next_attempt_at   timestamptz not null default now(),
  locked_until      timestamptz,
  last_error        text,
  processed_at      timestamptz,
  payload_purged_at timestamptz,
  constraint raw_events_dedup unique nulls not distinct (client_id, channel, external_id)
);

create index raw_events_claimable on leads.raw_events (next_attempt_at)
  where status in ('pending', 'failed', 'processing');
create index raw_events_client_source on leads.raw_events (client_id, source, occurred_at desc);

-- ---------------------------------------------------------------------------
-- Άνθρωποι και ενδιαφέροντα
-- ---------------------------------------------------------------------------

create table leads.contacts (
  id               uuid primary key default gen_random_uuid(),
  client_id        uuid not null references leads.clients (id),
  first_name       text,
  last_name        text,
  full_name_raw    text,
  name_tokens      text[] not null default '{}',  -- κανονικοποιημένα (λατινικά, πεζά), μόνο για name_mismatch
  created_at       timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  merged_into      uuid references leads.contacts (id)
);

create index contacts_client on leads.contacts (client_id);

create table leads.contact_identifiers (
  id                 bigint generated always as identity primary key,
  client_id          uuid not null references leads.clients (id),
  contact_id         uuid not null references leads.contacts (id),
  kind               text not null check (kind in ('phone', 'email')),
  value_normalized   text not null,
  value_raw          text,
  first_raw_event_id bigint references leads.raw_events (id),
  created_at         timestamptz not null default now(),
  unique (client_id, kind, value_normalized),
  check (
    (kind = 'phone' and value_normalized ~ '^\+[1-9][0-9]{7,14}$')
    or (kind = 'email' and value_normalized = lower(value_normalized) and value_normalized ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
  )
);

create index contact_identifiers_contact on leads.contact_identifiers (contact_id);

create table leads.inquiries (
  id            bigint generated always as identity primary key,
  client_id     uuid not null references leads.clients (id),
  contact_id    uuid not null references leads.contacts (id),
  source        text not null,
  property_ref  text,
  message       text,
  message_hash  text not null,
  context       jsonb not null default '{}',
  first_seen_at timestamptz not null,
  last_touch_at timestamptz not null,
  touch_count   int not null default 1,
  is_returning  boolean not null default false,
  status        text not null default 'open',
  created_at    timestamptz not null default now()
);

create index inquiries_dedup on leads.inquiries (contact_id, property_ref, first_seen_at desc);

-- Ποια raw events τροφοδότησαν ποιο inquiry. Κάνει το reprocess idempotent.
create table leads.inquiry_events (
  raw_event_id bigint not null references leads.raw_events (id),
  inquiry_id   bigint not null references leads.inquiries (id),
  kind         text not null check (kind in ('created', 'touch')),
  created_at   timestamptz not null default now(),
  primary key (raw_event_id, inquiry_id)
);

create index inquiry_events_inquiry on leads.inquiry_events (inquiry_id);

-- ---------------------------------------------------------------------------
-- Ανθρώπινη απόφαση και έξοδοι
-- ---------------------------------------------------------------------------

create table leads.review_queue (
  id                 bigint generated always as identity primary key,
  client_id          uuid references leads.clients (id),
  kind               text not null check (kind in (
                       'no_identifier', 'placeholder', 'parse_failed', 'unknown_sender',
                       'unknown_recipient', 'possible_merge', 'name_mismatch', 'wa_unclear')),
  blocking           boolean not null,
  raw_event_id       bigint references leads.raw_events (id),
  contact_id         uuid references leads.contacts (id),
  related_contact_id uuid references leads.contacts (id),
  inquiry_id         bigint references leads.inquiries (id),
  note               text,
  status             text not null default 'open' check (status in ('open', 'resolved')),
  resolution         text,
  created_at         timestamptz not null default now(),
  resolved_at        timestamptz,
  resolved_by        text
);

-- Το ίδιο πρόβλημα στο ίδιο raw (ή στο ίδιο ζεύγος contacts) δεν ανοίγει δεύτερο item.
create unique index review_queue_open_unique on leads.review_queue
  (kind, coalesce(raw_event_id, 0), coalesce(contact_id, '00000000-0000-0000-0000-000000000000'::uuid),
   coalesce(related_contact_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where status = 'open';

create table leads.outbox (
  id              bigint generated always as identity primary key,
  client_id       uuid not null references leads.clients (id),
  kind            text not null check (kind in ('new_inquiry')),
  inquiry_id      bigint not null references leads.inquiries (id),
  status          text not null default 'pending' check (status in ('pending', 'processing', 'sent', 'failed', 'dead')),
  attempts        int not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_until    timestamptz,
  last_error      text,
  created_at      timestamptz not null default now(),
  sent_at         timestamptz,
  unique (kind, inquiry_id)
);

create index outbox_claimable on leads.outbox (next_attempt_at)
  where status in ('pending', 'failed', 'processing');

create table leads.ops_alerts (
  key          text primary key,
  last_sent_at timestamptz not null,
  count        int not null default 1
);

-- ---------------------------------------------------------------------------
-- RLS: ενεργό παντού, καμία policy. Μόνο οι functions (security definer) έχουν πρόσβαση.
-- ---------------------------------------------------------------------------

alter table leads.clients             enable row level security;
alter table leads.source_accounts     enable row level security;
alter table leads.email_routes        enable row level security;
alter table leads.placeholder_values  enable row level security;
alter table leads.raw_events          enable row level security;
alter table leads.contacts            enable row level security;
alter table leads.contact_identifiers enable row level security;
alter table leads.inquiries           enable row level security;
alter table leads.inquiry_events      enable row level security;
alter table leads.review_queue        enable row level security;
alter table leads.outbox              enable row level security;
alter table leads.ops_alerts          enable row level security;

-- Global placeholders.
insert into leads.placeholder_values (kind, value_normalized) values
  ('email', 'test@test.com'), ('email', 'test@test.gr'), ('email', 'test@example.com'),
  ('email', 'a@a.com'), ('email', 'asdf@asdf.com'), ('email', 'no@email.com'),
  ('email', 'noemail@noemail.com'), ('email', 'example@example.com'), ('email', 'email@email.com'),
  ('phone', '+300000000000'), ('phone', '+301111111111'), ('phone', '+306900000000'),
  ('phone', '+306999999999'), ('phone', '+306912345678'), ('phone', '+302101234567');
