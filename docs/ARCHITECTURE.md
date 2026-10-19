# Lead Capture System: Engineering Design (v1)

Βάση: η αρχική περιγραφή του συστήματος και οι απαντήσεις στις ανοιχτές ερωτήσεις. Εδώ κλείνονται όλες οι σχεδιαστικές αποφάσεις, ώστε να μπορεί να ξεκινήσει η υλοποίηση. Όπου κάτι είναι **υπόθεση** που χρειάζεται επιβεβαίωση, σημειώνεται ως τέτοια.

---

## 0. Αποφάσεις-πλαίσιο

| Θέμα | Απόφαση |
|---|---|
| Φάσεις | **Φάση 1:** email (website forms και portals). **Φάση 2:** FB Lead Ads. **Φάση 3:** WhatsApp. Το schema σχεδιάζεται από τώρα για όλες, αλλά υλοποιείται μόνο ό,τι χρειάζεται η Φάση 1. |
| Hosting | Το υπάρχον self-hosted n8n στο VPS της Hostinger. Supabase (Pro) με μία κοινή Postgres για όλους τους πελάτες. |
| Ειδοποιήσεις προς εσένα | **Μόνο σφάλματα.** Όταν όλα δουλεύουν δεν λαμβάνεις τίποτα. Δεν υπάρχει ημερήσιο report. |
| WhatsApp | Coexistence: ο αριθμός μένει στο WhatsApp Business app και οι agents απαντάνε κανονικά. Το σύστημα απλώς διαβάζει τα εισερχόμενα μέσω webhook. Ταξινομεί από το 1ο μήνυμα, και από το 2ο μόνο αν χρειαστεί. Δεν στέλνει τίποτα. |
| Review queue και ειδοποιήσεις | Δύο διαφορετικά πράγματα. **Review queue:** πίνακας με αποφάσεις που περιμένουν άνθρωπο (§8). **Ειδοποιήσεις:** μηνύματα ότι κάτι συνέβη, σε τρεις τύπους με διαφορετικούς παραλήπτες (§9). |

### Κατανομή ευθύνης (ποιο κομμάτι κάνει τι)

- **Postgres (Supabase):** όλες οι εγγυήσεις. Uniqueness, idempotency, ταυτοποίηση, dedup, καταστάσεις, retries. Ό,τι «δεν πρέπει να γίνει ποτέ δύο φορές» γίνεται εδώ.
- **`lead-core` (JS package σε αυτό το repo, με tests):** parsing των emails και normalization (τηλέφωνο, email, όνομα, property_ref). Είναι ντετερμινιστικό, έχει versioning και ελέγχεται με fixtures από πραγματικά emails. Φορτώνεται στο n8n ως external module (`NODE_FUNCTION_ALLOW_EXTERNAL`).
- **n8n:** μόνο orchestration. Κάνει polling, καλεί functions, στέλνει μηνύματα. Δεν κρατάει δική του κατάσταση και δεν παίρνει αποφάσεις dedup.

Γιατί το parsing είναι σε package και όχι σε Code node: είναι το κομμάτι που θα σπάει πιο συχνά (αλλαγή template). Χρειάζεται tests, ιστορικό στο git και reprocess με τη διορθωμένη έκδοση. Αυτά δεν γίνονται μέσα σε ένα Code node.

---

## 1. Ροή (Φάση 1)

```
Gmail mailbox (leads+<client>@…)
   │  W1 email-capture (κάθε 1')
   ▼
capture_raw_event()  ──►  raw_events (pending)   ──► Gmail label "lead-captured"
   │  W2 processor (αμέσως + από W4)
   ▼
claim_raw_events() → lead-core.parse() → lead-core.normalize()
   │
   ├─ ingest_lead()        → contacts / inquiries / review_queue / outbox   → raw: processed
   ├─ mark_raw_review()    → review_queue (blocking)                        → raw: needs_review
   └─ mark_raw_failed()    → backoff ή dead + alert                         → raw: failed/dead
   │
   ▼  W3 dispatcher
outbox → email στον agent (+ Google Sheet προαιρετικά)

W4 sweeper (5')     : ξαναπιάνει pending/failed/stuck-processing, outbox που έμειναν
W5 heartbeat (ημερ.): σιωπή ανά πελάτη/πηγή → alert
W7 retention (εβδ.) : καθάρισμα payloads > 12 μηνών
healthchecks.io     : εξωτερικό dead-man's-switch για το ίδιο το n8n
```

---

## 2. Schema

Κοινοί κανόνες: όλοι οι χρόνοι σε `timestamptz` (UTC). Όλοι οι πίνακες έχουν `client_id`. RLS ενεργό παντού, χωρίς policies μέχρι να υπάρξει UI πελάτη (§11).

### 2.1 Ρύθμιση

**`clients`**
`id uuid PK`, `slug text UNIQUE` (χρησιμοποιείται στο plus-address), `name`, `default_region text` (`GR`/`CY`), `dedup_window interval` (default `48h`), `notify_emails text[]`, `sheet_id text null`, `active bool`.

**`source_accounts`**: από πού έρχονται τα γεγονότα και σε ποιον πελάτη ανήκουν. Είναι η **μόνη** πηγή του `client_id`.
`id`, `client_id`, `channel` (`gmail` | `fb_page` | `wa_number`), `identifier` (π.χ. `leads+kalogirou@gmail.com`, page_id, phone_number_id), `active`. `UNIQUE(channel, identifier)`.

**`email_routes`**: για ένα email του πελάτη, ποια πηγή είναι και ποιος parser το διαβάζει.
`id`, `client_id`, `source` (`website` | `spitogatos` | `xe` | …), `match_from text[]` (διευθύνσεις ή domains), `match_subject text null` (regex), `parser text` (π.χ. `spitogatos_v1`, `cf7_generic`), `priority int`, `heartbeat_max_silence interval null`, `active`.

**`placeholder_values`**: blacklist για test και σκουπίδια.
`kind` (`phone`/`email`/`name`), `value_normalized`, `client_id null` (null σημαίνει global). Σπέρνεται με τιμές όπως `test@test.com`, `a@a.com`, `+300000000000`, `+306900000000`, `asdf`. Είναι πίνακας και όχι κώδικας, ώστε να επεκτείνεται χωρίς deploy.

### 2.2 Γεγονότα

**`raw_events`**

| πεδίο | σημείωση |
|---|---|
| `id bigint identity` | |
| `client_id uuid null` | null μόνο όταν ο παραλήπτης είναι άγνωστος (→ review) |
| `channel` | `gmail` / `fb_leadgen` / `whatsapp`: το **κανάλι παραλαβής**, σταθερό |
| `external_id` | Message-ID header (fallback: Gmail message id) / leadgen_id / wamid |
| `occurred_at` | χρόνος του γεγονότος (Gmail internalDate, FB created_time, WA timestamp) |
| `received_at` | πότε το πιάσαμε |
| `payload jsonb` | αυτούσιο (§4.3) |
| `source text null` | η **προέλευση** (website/spitogatos/…), συμπληρώνεται στο processing |
| `parser_version text null` | ποια έκδοση του lead-core το διάβασε |
| `status` | βλ. παρακάτω |
| `attempts int`, `next_attempt_at`, `locked_until`, `last_error` | retry/lease |
| `processed_at`, `payload_purged_at` | |

`UNIQUE NULLS NOT DISTINCT (client_id, channel, external_id)`

Το `channel` και το `source` είναι χωριστά πεδία, γιατί το source βγαίνει από parsing. Αν ήταν μέρος του unique κλειδιού, ένα reprocess με άλλο αποτέλεσμα θα έσπαγε το dedup.

**Καταστάσεις raw_events**

| status | σημασία | ποιος το βγάζει από εκεί |
|---|---|---|
| `pending` | περιμένει επεξεργασία | processor |
| `processing` | κάποιος worker το έχει (lease ως `locked_until`) | ο ίδιος worker, ή ο sweeper αν λήξει το lease |
| `processed` | έγινε ingest | — |
| `failed` | παροδικό σφάλμα, θα ξαναδοκιμαστεί στο `next_attempt_at` | processor |
| `dead` | 5 αποτυχίες → alert | άνθρωπος (reprocess) |
| `needs_review` | ντετερμινιστικό πρόβλημα, ανοιχτό blocking review item | άνθρωπος |
| `ignored` | δεν είναι lead (απόφαση ανθρώπου ή κανόνα) | — |
| `waiting` | *Φάση 3*: WA μήνυμα που περιμένει 2ο μήνυμα για ταξινόμηση | WA classifier / sweeper |

### 2.3 Άνθρωποι και ενδιαφέροντα

**`contacts`**
`id`, `client_id`, `first_name`, `last_name`, `full_name_raw`, `created_at`, `last_activity_at`, `merged_into uuid null` (μετά από merge ο contact δεν σβήνεται, δείχνει στον επιζώντα).

**`contact_identifiers`**
`id`, `client_id`, `contact_id`, `kind` (`phone`/`email`), `value_normalized`, `value_raw`, `first_raw_event_id`, `created_at`.
`UNIQUE(client_id, kind, value_normalized)`. Check constraints: phone `^\+[1-9][0-9]{7,14}$`, email lowercase με `@`.

**`inquiries`**
`id`, `client_id`, `contact_id`, `source`, `property_ref text null`, `message`, `message_hash` (sha256 του κανονικοποιημένου μηνύματος), `context jsonb` (στοιχεία που δεν ταιριάζουν αλλού: ακατέργαστο τηλέφωνο που δεν αναγνωρίστηκε, URL σελίδας, απαντήσεις φόρμας, ad/campaign στη Φάση 2), `first_seen_at` (= occurred_at του πρώτου raw), `last_touch_at`, `touch_count`, `is_returning bool`, `status` (`open` στη v1. Ο κύκλος ζωής ανήκει στο CRM).

**`inquiry_events`**: ποια raw events τροφοδότησαν ποιο inquiry.
`raw_event_id`, `inquiry_id`, `kind` (`created`/`touch`), `created_at`. `PRIMARY KEY (raw_event_id, inquiry_id)`.

Αυτός ο πίνακας αντικαθιστά το `UNIQUE(raw_event_id, property_ref)` της αρχικής περιγραφής και λύνει δύο προβλήματα. (α) Τα NULL property_ref προστατεύονται κι αυτά. (β) Ένα reprocess δεν ξαναμετράει touch, γιατί το ίδιο raw_event δεν μπορεί να γίνει touch δεύτερη φορά στο ίδιο inquiry.

### 2.4 Ανθρώπινη απόφαση και έξοδοι

**`review_queue`**
`id`, `client_id`, `kind`, `blocking bool`, `raw_event_id null`, `contact_id null`, `related_contact_id null`, `inquiry_id null`, `note`, `status` (`open`/`resolved`), `resolution text null`, `resolved_at`, `resolved_by`.
Partial unique `(kind, raw_event_id) WHERE status='open'`, ώστε να μη διπλασιάζονται items στο reprocess.

**`outbox`**: ό,τι πρέπει να φύγει προς τα έξω.
`id`, `client_id`, `kind` (`new_inquiry`), `inquiry_id`, `status` (`pending`/`sent`/`failed`/`dead`), `attempts`, `next_attempt_at`, `locked_until`, `last_error`, `sent_at`. `UNIQUE(kind, inquiry_id)`.

Το outbox γράφεται στο **ίδιο transaction** με το inquiry. Αν η ειδοποίηση του agent αποτύχει, το lead είναι ουσιαστικά χαμένο, οπότε χρειάζεται την ίδια εγγύηση με το ingestion.

**`ops_alerts`**: dedup των alerts.
`key text PK` (π.χ. `parse_failed:route:17`), `last_sent_at`, `count`. Το ίδιο πρόβλημα στέλνει alert το πολύ μία φορά τη μέρα.

**`wa_conversations`** (*Φάση 3*, §13).

---

## 3. Database functions (το API που καλεί το n8n)

Όλες είναι `SECURITY DEFINER` με σταθερό `search_path`. Το n8n συνδέεται με δικό του role (`n8n_app`), που έχει **μόνο EXECUTE** σε αυτές και κανένα δικαίωμα σε πίνακες (§11).

| function | τι κάνει |
|---|---|
| `capture_raw_event(channel, external_id, recipient, occurred_at, payload)` | Βρίσκει τον client από το `source_accounts` με βάση το `recipient`. Κάνει insert με `ON CONFLICT DO NOTHING` και επιστρέφει `{id, created}`. Αν ο παραλήπτης είναι άγνωστος → insert με `client_id null`, `needs_review` και review item `unknown_recipient`. |
| `claim_raw_events(limit)` | `FOR UPDATE SKIP LOCKED` σε όσα είναι `pending`, ή `failed` με `next_attempt_at <= now()`, ή `processing` με ληγμένο lease. Τα κάνει `processing`, βάζει `locked_until = now()+5'` και `attempts+1`, και τα επιστρέφει. |
| `ingest_lead(raw_event_id, lead jsonb)` | Η καρδιά του συστήματος (§6). |
| `mark_raw_review(raw_event_id, kind, note, source)` | Βάζει `needs_review` και ανοίγει blocking review item. |
| `mark_raw_failed(raw_event_id, error)` | Αν `attempts >= 5` → `dead` και επιστρέφει `alert=true`. Αλλιώς `failed` με `next_attempt_at = now() + 2^attempts λεπτά`. |
| `claim_outbox(limit)` / `mark_outbox_sent(id)` / `mark_outbox_failed(id, error)` | Το ίδιο μοτίβο για το outbox. |
| `reprocess_raw_event(id)` | `needs_review`/`dead`/`failed` → `pending`, `attempts=0`. Για `processed` δεν κάνει τίποτα (βλ. §6). |
| `resolve_review(id, action, data)` | §8 |
| `merge_contacts(survivor, merged)` | Μεταφέρει identifiers και inquiries και βάζει `merged_into`. Γίνεται μόνο από άνθρωπο. |
| `erase_contact(contact_id)` | GDPR: σβήνει contact, identifiers, inquiries και τα payloads των σχετικών raw events. |
| `heartbeat_report()`, `daily_report()` | Επιστρέφουν έτοιμα δεδομένα για το Monitor workflow (το `daily_report` χρησιμοποιείται μόνο για τα dead counts). |
| `ops_alert_should_send(key)` | Αποφασίζει αν στέλνεται alert (dedup). |

---

## 4. Φάση 1: Email ingestion

### 4.1 Mailbox
- Ένας **αποκλειστικός** λογαριασμός Gmail, με 2FA. Δεν χρησιμοποιείται για τίποτα άλλο.
- Plus-address ανά πελάτη: `leads+<slug>@…`. Γράφεται στο `source_accounts`.
- Gmail filter για `to:(leads+*)` → «Never send to Spam». Τα portals πέφτουν συχνά σε spam, και αυτή είναι μια σιωπηλή απώλεια που δεν θα έπιανε κανείς.
- **OAuth:** το Google Cloud project πρέπει να είναι σε publishing status **«In production»**. Σε «Testing» το refresh token λήγει σε 7 μέρες και το polling σταματάει σιωπηλά. Είναι το αντίστοιχο του token που λήγει στο FB. Για προσωπική χρήση το unverified production app δουλεύει, με μια προειδοποίηση στο login.

### 4.2 W1 email-capture: ένας μηχανισμός και όχι trigger + sweep
Η αρχική περιγραφή είχε Gmail trigger και ξεχωριστό rescan κάθε 6 ώρες. Αντί γι' αυτό, ένα **schedule κάθε 1'** που ρωτάει το Gmail API:

```
in:anywhere -in:trash -in:sent -label:lead-captured newer_than:30d
```

Το trigger και το δίχτυ ασφαλείας γίνονται το ίδιο πράγμα. Το label είναι η μόνη κατάσταση που κρατάει το mailbox. Αν το n8n μείνει κάτω για μέρες, όταν ξανανέβει μαζεύει όλα όσα έχουν έρθει στο μεταξύ.

Για κάθε μήνυμα:
1. `messages.get(format=full)` → χτίζεται το payload (§4.3).
2. Βρίσκεται ο παραλήπτης: ελέγχονται κατά σειρά `Delivered-To` (μπορεί να υπάρχουν πολλά), `X-Original-To`, `To`, `Cc`, και κρατιέται το πρώτο που ταιριάζει στο pattern `leads+*@`.
3. `capture_raw_event()`.
4. **Μετά** την επιτυχία μπαίνει το label `lead-captured`.

Αν το n8n πέσει ανάμεσα στο 3 και στο 4, στο επόμενο λεπτό το insert σκάει στο unique (`created=false`) και απλώς μπαίνει το label. Αυτό είναι idempotent.

Το label σημαίνει «σώθηκε στη βάση» και όχι «επεξεργάστηκε». Η κατάσταση επεξεργασίας ζει μόνο στη βάση. Το read/unread δεν χρησιμοποιείται πουθενά.

Μετά το capture, το W1 καλεί αμέσως το W2 (fast path). Ο sweeper είναι μόνο για τα υπόλοιπα.

### 4.3 Payload email
`gmail_id`, `thread_id`, `internal_date`, `headers` (Message-ID, From, Reply-To, To, Cc, Delivered-To[], X-Original-To, Subject, Date), `text`, `html`, `attachments: [{filename, mime, size}]` (χωρίς περιεχόμενο).
Τα attachments δεν αποθηκεύονται. Κανένα form ή portal δεν βάζει lead σε attachment, και θα φούσκωναν τη βάση με προσωπικά δεδομένα.

### 4.4 Routing: ποια πηγή είναι
Το processor ταιριάζει το email με τα `email_routes` του πελάτη, κατά `priority`:
- **Portals:** με `From` (π.χ. domain του Σπιτόγατου). Είναι αξιόπιστο.
- **Website forms:** με `From` (π.χ. `wordpress@<domain πελάτη>`) και/ή `match_subject`.
- **Forwarded emails** (το portal στέλνει στο inbox του πελάτη, που κάνει forward): το `From` είναι ο ίδιος ο πελάτης. Τότε το routing κοιτάζει το εσωτερικό block «From:» του forward στο σώμα. Το lead-core το εξάγει.
- **Κανένα match** → `needs_review` / `unknown_sender`. Εκεί θα πέσουν και τα emails επιβεβαίωσης forwarding του Gmail, που πρέπει να τα δεις για να ενεργοποιηθεί το forward, καθώς και τα newsletters των portals. Τα newsletters κλείνουν με `ignore`, και αν επαναλαμβάνονται προστίθεται κανόνας `ignore` στα routes (route με `parser = 'ignore'`).

### 4.5 Parsing (lead-core)
- HTML → text, με διατήρηση των αλλαγών γραμμής. Αν το HTML δίνει φτωχό αποτέλεσμα, fallback στο `text/plain`.
- Parser ανά route. Η βάση είναι ένας γενικός parser «Ετικέτα: τιμή» με λεξικό συνωνύμων:
  - Όνομα / Ονοματεπώνυμο / Name / Full name
  - Τηλέφωνο / Κινητό / Phone / Tel
  - Email / E-mail
  - Μήνυμα / Σχόλια / Message / Comments
  - Κωδικός / Κωδ. αγγελίας / Listing ID / Ref
  - URL / Σελίδα

  Οι parsers των portals προσθέτουν ό,τι ειδικό έχει το template τους.
- **Συμβόλαιο εξόδου** (`LeadCandidate`):
  `{source, full_name_raw, first_name, last_name, phones_raw[], emails_raw[], message, property_refs[], context, parser, parser_version}`
- **Ανίχνευση αλλαγής template:** κάθε parser δηλώνει ποιες ετικέτες περιμένει. Αν δεν βρεθεί καμία ετικέτα identifier → `parse_failed` (review, blocking) και alert για αυτό το route. Ποτέ insert με κενά πεδία.
- **Fixtures:** κάθε route έχει τουλάχιστον 3 πραγματικά emails (ανωνυμοποιημένα) στο `lead-core/fixtures/<parser>/`, με το αναμενόμενο αποτέλεσμα δίπλα. Τα tests τρέχουν σε CI. **Κανένα route δεν μπαίνει σε παραγωγή χωρίς fixtures.**

### 4.6 Normalization (lead-core)
- **Τηλέφωνο:** `libphonenumber-js`, με default region το `clients.default_region`. Δέχεται `0030`, `+30`, `00357`, κενά, παύλες, τελείες και παρενθέσεις. Το αποτέλεσμα είναι E.164 μόνο αν το νούμερο είναι `isValid`. Ό,τι δεν επικυρώνεται πηγαίνει στο `phones_unparsed[]`, κρατιέται στο `inquiry.context` και **δεν γίνεται identifier**. Σταθερά και ξένα νούμερα (+44, +49) γίνονται δεκτά κανονικά.
- **Email:** trim και lowercase, και βασική επικύρωση σύνταξης. Τίποτα «έξυπνο» (π.χ. αφαίρεση τελειών στο Gmail).
- **Όνομα:** `full_name_raw` όπως ήρθε, και first/last ως best-effort split στο τελευταίο κενό. Δεν χρησιμοποιείται για matching.
- **property_ref:** σε κανονική μορφή με namespace, ώστε να μη συγκρούονται κωδικοί διαφορετικών πηγών:
  - portal → `spitogatos:12345678`
  - site με κωδικό → `site:KAL-102` (κεφαλαία, trim)
  - site μόνο με URL → `url:<host><path>` (πεζά, χωρίς query/fragment/τελική κάθετο)
  - Φάση 2: `fb_ad:<ad_id>` ή `fb_form:<form_id>`
- **message_hash:** sha256 του μηνύματος σε πεζά, χωρίς τόνους και με τα διαδοχικά κενά συμπτυγμένα σε ένα.

Η βάση **ξαναελέγχει** τις μορφές με check constraints. Αν το lead-core έχει bug, το αποτέλεσμα είναι failed και όχι λάθος δεδομένα στη βάση.

---

## 5. Processor και retries (W2, W4)

```
claim_raw_events(10)
 για κάθε raw:
   route = match(email_routes)                       → καμία: mark_raw_review(unknown_sender)
   cand  = lead-core.parse(route.parser, payload)    → exception/κενό: mark_raw_review(parse_failed)
   lead  = lead-core.normalize(cand, client.region)
   ingest_lead(raw.id, lead)                         → σφάλμα DB/δικτύου: mark_raw_failed
```

Τα σφάλματα χωρίζονται σε δύο είδη:
- **Ντετερμινιστικά** (parsing, validation) → **αμέσως** `needs_review`. Το να ξαναδοκιμάσεις 5 φορές το ίδιο email με τον ίδιο parser δεν αλλάζει τίποτα.
- **Παροδικά** (timeout, DB unavailable) → `failed` με backoff 2, 4, 8, 16 λεπτά, και μετά `dead` + alert.

Υπάρχει **ένας** μηχανισμός retry, μέσα στη βάση. Τα retries των nodes του n8n χρησιμοποιούνται μόνο σε εξωτερικές HTTP κλήσεις (Sheets, SMTP).

Το W4 (κάθε 5') τρέχει το W2 για ό,τι έμεινε, και το W3 για το outbox. Ένα `processing` με ληγμένο lease (το n8n έπεσε στη μέση) ξαναπιάνεται αυτόματα.

---

## 6. `ingest_lead(raw_event_id, lead)`: βήμα-βήμα

Ένα transaction.

1. **Κλείδωμα του raw:** `SELECT … FROM raw_events WHERE id = $1 FOR UPDATE`.
   - Το `client_id` παίρνεται **από το raw** και ποτέ από το `lead`.
   - Αν είναι ήδη `processed` → επιστρέφει το προηγούμενο αποτέλεσμα από το `inquiry_events` (idempotent).
2. `pg_advisory_xact_lock(hashtextextended(client_id::text, 0))`, που σειριοποιεί όλα τα ingestions του πελάτη.
3. **Validation και blacklist:**
   - Αφαιρούνται identifiers που υπάρχουν στο `placeholder_values`. Σημειώνεται ποιοι αφαιρέθηκαν.
   - Αν δεν μείνει κανένας identifier → review `no_identifier` (ή `placeholder` αν αφαιρέθηκαν όλοι), blocking, raw `needs_review`, return.
4. **Ταυτοποίηση:** βρίσκονται τα contacts με `contact_identifiers ∈ lead`. Αν κάποιος έχει `merged_into`, ακολουθείται ο επιζών.
   - **0 matches** → νέος contact και όλα τα identifiers του.
   - **1 match** → attach.
     - Τα νέα identifiers προστίθενται.
     - Τα στοιχεία συμπληρώνονται μόνο όπου είναι κενά, ποτέ overwrite.
   - **≥2 contacts** → επιλέγεται ο contact του **τηλεφώνου**. Αν πολλά τηλέφωνα δείχνουν σε διαφορετικούς contacts, μετράει το πρώτο τηλέφωνο του lead.
     - Γίνεται attach σε αυτόν.
     - Identifiers που ανήκουν σε άλλον contact **δεν μετακινούνται**. Όσα είναι εντελώς νέα προστίθενται στον επιλεγμένο.
     - Review `possible_merge` (non-blocking) με `contact_id` και `related_contact_id`.
   - **Έλεγχος ονόματος σε attach:**
     - Και τα δύο ονόματα κανονικοποιούνται: πεζά, χωρίς τόνους, μεταγραφή ελληνικών σε λατινικά κατά ΕΛΟΤ 743, ώστε «Γιώργος» και «Giorgos» να βγαίνουν ίδια.
     - Αν τα tokens δεν έχουν **καμία** επικάλυψη → review `name_mismatch` (non-blocking).
     - Αν ένα από τα δύο ονόματα είναι κενό, δεν γίνεται έλεγχος.
5. **Inquiries:** για κάθε `property_ref` του lead, ή για ένα `NULL` αν δεν υπάρχει κανένα:
   - Αναζητείται inquiry του ίδιου contact με ίδιο `property_ref`. Όταν το property_ref είναι NULL, η σύγκριση γίνεται με property_ref NULL **και** ίδιο `message_hash`.
   - Η αναζήτηση κοιτάζει μόνο inquiries με `first_seen_at > occurred_at − client.dedup_window`.
     - **Βρέθηκε** → touch: `touch_count+1`, `last_touch_at`, `inquiry_events(kind='touch')`. Ο agent δεν ειδοποιείται.
     - **Δεν βρέθηκε** → νέο inquiry.
       - `is_returning = true` αν υπάρχει παλαιότερο inquiry με ίδιο contact και ίδιο property_ref.
       - Γράφονται `inquiry_events(kind='created')` και `outbox(new_inquiry)`.
   - Μαζικό ενδιαφέρον (πολλά property_refs στο ίδιο γεγονός): ένα inquiry ανά ref, όλα δεμένα στο ίδιο raw.
6. Ενημερώνεται το `contacts.last_activity_at`. Το raw γίνεται `processed` και γράφεται το `source`.
7. Return: `{contact_id, contact_created, inquiries:[{id, action}], reviews:[…]}`.

**Δύο αποφάσεις που κλείνουν ασάφειες της αρχικής περιγραφής:**
- Το παράθυρο μετράει από το **`first_seen_at` του inquiry** (σταθερό), όχι από το τελευταίο touch (κυλιόμενο). Ένα inquiry «απορροφά» διπλά για 48 ώρες από τη στιγμή που ανοίγει. Μετά από αυτό, το ίδιο ενδιαφέρον ανοίγει νέο inquiry με `is_returning`. Αν το παράθυρο ήταν κυλιόμενο, ένα portal που στέλνει συνέχεια διπλά θα κρατούσε το inquiry ανοιχτό για πάντα, και ο agent δεν θα μάθαινε ποτέ ότι ο άνθρωπος επανήλθε.
- Ο χρόνος σύγκρισης είναι το **`occurred_at` του raw** και όχι το `now()`. Έτσι, όταν το σύστημα μαζεύει backlog μετά από downtime, τα διπλά αναγνωρίζονται σωστά.

**Reprocess ενός ήδη `processed` raw** (π.χ. ο parser έβγαλε λάθος όνομα): στη v1 δεν γίνεται αυτόματα. Η διόρθωση γίνεται με το χέρι στο contact. Το αυτόματο «undo και redo» είναι πολύπλοκο και σπάνιο, και θα το δούμε αν χρειαστεί.

---

## 7. Downstream (W3 dispatcher)

- Το W3 τρέχει αμέσως μετά από κάθε ingest που δημιούργησε outbox, και επίσης κάθε 5' μέσω του W4.
- Κάνει `claim_outbox`. Για κάθε item:
  - στέλνει email στα `clients.notify_emails`, με όνομα, τηλέφωνο (link `tel:`), email, πηγή, ακίνητο, μήνυμα και flags («Επανήλθε», «Πιθανό διπλό contact»).
  - αν ο πελάτης έχει `sheet_id`, κάνει append στο Google Sheet.
  - στο τέλος καλεί `mark_outbox_sent`.
- Αποτυχία → backoff. Μετά από 5 αποτυχίες → `dead` + alert.
- Ένα inquiry μπορεί να βγει **μία φορά** ανά kind, γιατί υπάρχει `UNIQUE(kind, inquiry_id)`.
- Τα touches δεν ειδοποιούν. Τα returning ειδοποιούν, με την ένδειξη «Επανήλθε».
- **Υπόθεση:** στη Φάση 1 ο agent ειδοποιείται με email (και Sheet όπου θέλει ο πελάτης). Push σε CRM έρχεται αργότερα ως νέος τύπος στο outbox.

---

## 8. Review queue

Ο ορισμός είναι αυτός που έδωσες: λίστα με αποφάσεις που περιμένουν άνθρωπο, γιατί μια λάθος αυτόματη απόφαση θα έκανε ζημιά. Το lead δεν χάνεται όσο περιμένει. Αυτό αντιστοιχεί στο πεδίο `blocking`:

| kind | blocking | κατάσταση του lead | πιθανές ενέργειες |
|---|---|---|---|
| `no_identifier` | ναι | μόνο raw | `ingest_manual` (με διορθωμένα στοιχεία), `ignore` |
| `placeholder` | ναι | μόνο raw | `ingest_manual`, `ignore` |
| `parse_failed` | ναι | μόνο raw | διόρθωση parser → `reprocess` · `ingest_manual` · `ignore` |
| `unknown_sender` | ναι | μόνο raw | νέο `email_route` → `reprocess` · `ignore` |
| `unknown_recipient` | ναι | μόνο raw (χωρίς client) | διόρθωση `source_accounts` → `reprocess` · `ignore` |
| `possible_merge` | όχι | καταχωρημένο, με flag | `merge` · `dismiss` (διαφορετικοί άνθρωποι) |
| `name_mismatch` | όχι | καταχωρημένο, με flag | `dismiss` · `merge`/μεταφορά με το χέρι |
| `wa_unclear` | ναι | *Φάση 3* | `ingest_manual` · `ignore` |

- Το `ingest_manual` καλεί το `ingest_lead` με τα διορθωμένα δεδομένα. Το raw μένει όπως ήρθε, και η διόρθωση καταγράφεται στο `resolution`.
- **Ποιος το δουλεύει:** εσύ, στη Φάση 1. Μέσα από Supabase Studio, με saved views (`open_reviews`) και κλήσεις του `resolve_review`. Ένα μικρό UI αξίζει όταν ο όγκος το δικαιολογήσει.
- Τα **blocking items παλαιότερα από 4 ώρες** στέλνουν alert, γιατί μπορεί να είναι πραγματικό lead που περιμένει. Τα non-blocking (possible_merge, name_mismatch) δεν στέλνουν alert. Ο agent τα βλέπει ως σημείωση στο email του lead και τα κοιτάς όταν θες.

---

## 9. Ειδοποιήσεις: τρεις διαφορετικοί τύποι

| τύπος | παραλήπτης | πότε | κανάλι |
|---|---|---|---|
| **Lead notification** | agent του πελάτη | νέο inquiry (μέσω outbox) | email (+ Sheet) |
| **Ops alert** | εσύ | **μόνο** όταν κάτι χάλασε ή θέλει ανθρώπινη ματιά | email (από το lead mailbox) |
| **Healthcheck** | εσύ | μόνο αν σταματήσει να τρέχει το n8n | healthchecks.io (εξωτερικό) |

**Ops alerts** (το πολύ ένα τη μέρα για το ίδιο key, μέσω `ops_alerts`):
- raw ή outbox σε `dead`
- `parse_failed` σε ένα route (πιθανή αλλαγή template)
- heartbeat: σιωπή μιας πηγής
- blocking review παλαιότερο από 4 ώρες
- σφάλμα auth στο Gmail (λήξη ή ανάκληση του OAuth)

**Dead-man's switch** (healthchecks.io, δωρεάν): αν πέσει το ίδιο το n8n, κανένα workflow δεν μπορεί να στείλει alert. Γι' αυτό ο έλεγχος γίνεται από έξω:
- Τα workflows Capture και Process κάνουν ping σε κάθε run (period 1', grace 15').
- Αν σταματήσουν τα pings, το healthchecks.io σε ειδοποιεί **απ' έξω**.
- Αυτό πιάνει πτώση του VPS, πτώση του n8n και σπασμένο Gmail auth.

---

## 10. Heartbeat (W5, ημερήσιο)

Για κάθε `email_route` με `heartbeat_max_silence`:
- Υπολογίζεται `now() − max(raw_events.occurred_at)` για το συγκεκριμένο route.
- Αν ξεπερνάει το όριο → alert «καμία εγγραφή από <πηγή> για <πελάτη> εδώ και N μέρες».

Το όριο ορίζεται στο στήσιμο από τον όγκο που αναφέρει ο πελάτης, και ρυθμίζεται μετά από 2–3 εβδομάδες πραγματικών δεδομένων. Αν ένα route δεν έχει όριο, δεν ελέγχεται.

---

## 11. Ασφάλεια και multi-tenancy

- Το `client_id` καθορίζεται **μόνο** από το `source_accounts`, κατά το capture, και από εκεί ρέει παντού μέσω του raw. Καμία function δεν δέχεται `client_id` από το input του lead.
- Το n8n συνδέεται με role `n8n_app`: μόνο EXECUTE στις functions του §3, χωρίς SELECT/INSERT σε πίνακες. **Όχι service_role.** Έτσι, αν ένα λάθος ή κακόβουλο query περάσει από το n8n, δεν μπορεί να αγγίξει δεδομένα πελατών εκτός του API.
- RLS ενεργό σε όλους τους πίνακες, χωρίς policies για `anon`/`authenticated`. Όταν έρθει UI πελάτη, προστίθενται policies `client_id = <claim του χρήστη>`.
- Self-hosted n8n:
  - HTTPS μέσω reverse proxy (Caddy).
  - Owner account με 2FA.
  - Το n8n χρησιμοποιεί Postgres για τη δική του βάση (όχι SQLite).
  - Το **`N8N_ENCRYPTION_KEY` κρατιέται αντίγραφο εκτός VPS**. Χωρίς αυτό χάνονται όλα τα credentials.
  - Ημερήσιο backup του volume.
  - Τα workflows γίνονται export σε JSON σε αυτό το repo (`n8n/workflows/`).

---

## 12. Hosting

- **VPS:** το υπάρχον n8n στη Hostinger. Δεν χρειάζεται καμία αλλαγή στον server: ο κώδικας του lead-core μπαίνει αυτούσιος στα Code nodes (bundle).
- **Supabase Pro:** ένα project για όλους τους πελάτες, με ημερήσια backups. Η τιμή ανεβαίνει με το compute και όχι με τον αριθμό πελατών. Οι τρέχουσες τιμές να επιβεβαιωθούν πριν το στήσιμο.
- **Μονό σημείο αποτυχίας είναι το VPS.** Ανά φάση:
  - **Email:** ανεκτικό. Το mailbox λειτουργεί ως buffer, και το W1 μαζεύει τα 30 τελευταία 24ωρα όταν ξανανέβει.
  - **FB:** ανεκτικό. Το reconciliation poll ανακτά ό,τι χάθηκε.
  - **WhatsApp:** **δεν** είναι ανεκτικό, γιατί δεν υπάρχει API για ανάκτηση μηνυμάτων. Στη Φάση 3 ο webhook receiver μπαίνει σε Supabase Edge Function, που γράφει μόνο στο `raw_events` και είναι ανεξάρτητη από το VPS (§13).

---

## 13. Φάσεις 2 και 3: τι αλλάζει (σύνοψη)

### Φάση 2: FB Lead Ads
- **Ένα** κοινό webhook για όλους τους πελάτες (το Meta App έχει ένα callback URL). Δρομολόγηση με `page_id` → `source_accounts(channel='fb_page')`. Τα workflows **δεν** είναι ανά πελάτη. Ανά πελάτη είναι μόνο η ρύθμιση.
- Έλεγχος `X-Hub-Signature-256` πάνω στο raw body.
- Raw = webhook payload (leadgen_id, form_id, ad_id, page_id). Το fetch από το Graph API γίνεται στο processing, άρα ένα Graph error είναι `failed` με retry και το lead δεν χάνεται. Το reconciliation poll (κάθε 2 ώρες) γράφει raw με όλο το lead. Το processing ελέγχει αν υπάρχει ήδη `field_data` και τότε δεν κάνει fetch.
- System User token από Business Manager (δεν λήγει). Health check του token στο W5.
- `property_ref` = `fb_ad:<ad_id>`, ή `fb_form:<form_id>` για organic leads. Στο `inquiry.context` μπαίνουν ad_name, campaign και οι απαντήσεις στις custom ερωτήσεις. Στο `message` μπαίνει μόνο το ελεύθερο κείμενο.

### Φάση 3: WhatsApp (coexistence)
- **Να επιβεβαιωθεί πριν τη Φάση 3:** ότι το coexistence (WhatsApp Business app και Cloud API στον ίδιο αριθμό) είναι διαθέσιμο για ελληνικούς και κυπριακούς αριθμούς, και ποιοι είναι οι περιορισμοί του τη στιγμή εκείνη.
- Receiver σε Edge Function: έλεγχος υπογραφής → `capture_raw_event(channel='whatsapp', external_id=wamid)` → 200. Το n8n επεξεργάζεται μετά, όπως στο email.
- Αγνοούνται τα echoes των μηνυμάτων που στέλνει ο agent από το app, και τα status updates.
- **`wa_conversations`**: `client_id`, `wa_id`, `state` (`classifying`/`awaiting_second`/`lead`/`not_lead`/`unclear`), `raw_event_ids[]`, `classification jsonb`, `version int`, `decided_at`, `last_message_at`. Partial unique: μία ενεργή συνομιλία ανά `(client_id, wa_id)`.
- **Lock χωρίς να κρατιέται κατά την κλήση LLM:**
  1. claim (`state → classifying`, `version+1`, commit)
  2. κλήση LLM, εκτός transaction
  3. `UPDATE … WHERE version = <αυτό που διάβασα>`
  4. Αν στο μεταξύ ήρθε νέο μήνυμα (το version άλλαξε), το αποτέλεσμα απορρίπτεται και η ταξινόμηση ξανατρέχει με όλα τα μηνύματα.
- Πρώτα ντετερμινιστικοί κανόνες (link αγγελίας, κωδικός), μετά το LLM. Το `property_ref` μπαίνει **μόνο** όταν υπάρχει κωδικός ή link. Η περιγραφή του LLM («βίλα στο Πανόραμα») πάει στο `context`, γιατί η ίδια περιγραφή γράφεται διαφορετικά κάθε φορά και δεν δουλεύει ως κλειδί dedup.
- **Μετά την απόφαση:**
  - `lead`: τα επόμενα μηνύματα μένουν μόνο ως raw, συνδεδεμένα με τη συνομιλία. Δεν φτιάχνουν νέο inquiry, εκτός αν περιέχουν **νέο** κωδικό ή link αγγελίας (ντετερμινιστικός έλεγχος, χωρίς LLM).
  - `not_lead`: μετά από 30 μέρες σιωπής ξεκινάει νέα ταξινόμηση.
  - **Retention:** τα payloads των συνομιλιών `not_lead` σβήνονται μετά από 30 μέρες. Είναι προσωπικά μηνύματα τρίτων που δεν χρειαζόμαστε.

---

## 14. GDPR και retention (W7)

- Payload των `raw_events` παλαιότερων από 12 μήνες → `payload = '{}'` και `payload_purged_at`. Τα metadata κρατιούνται.
- WA `not_lead` → 30 μέρες (Φάση 3).
- `erase_contact()` για αιτήματα διαγραφής.
- Η σύμβαση ορίζει τον πελάτη ως controller και εσένα ως processor. Αυτό ανήκει στο client agreement και όχι στο σύστημα.

---

## 15. Δομή repo (σχεδιαζόμενη)

```
docs/ARCHITECTURE.md          ← αυτό το έγγραφο
supabase/migrations/          ← schema + functions (SQL)
supabase/tests/               ← tests για ingest_lead κ.λπ.
lead-core/                    ← parsers, normalization (JS)
  src/  test/  fixtures/<parser>/
n8n/docker-compose.yml        ← n8n + postgres + caddy
n8n/workflows/                ← exported workflows (W1–W7)
```

---

## 16. Πλάνο Φάσης 1

**Πρόοδος:** ✅ βήματα 1–2 (schema, functions, lead-core, με tests). ⚠️ βήμα 3 μόνο με εικονικά emails (Σπιτόγατος + φόρμα site με πεδία όνομα, επίθετο, email, ενδιαφέρον, κρυφό πεδίο ακινήτου). ⏳ βήματα 4–7.

1. **Schema και functions** (migrations), με tests για όλα τα σενάρια του §6: 0/1/2 matches, παράθυρο, returning, reprocess, placeholder, ταυτόχρονα ingestions.
2. **lead-core:** normalization + generic parser + tests.
3. **Fixtures και parsers** ανά portal και ανά φόρμα του πρώτου πελάτη.
4. **n8n infra:** healthchecks.io και credentials. Οδηγός στο `docs/SETUP.md`.
5. **Workflows W1–W7.**
6. **Στήσιμο πελάτη:**
   - `clients`, `source_accounts`, `email_routes`
   - αλλαγή παραλήπτη σε portals και φόρμες
   - κρυφό πεδίο ακινήτου στη φόρμα
   - Gmail filter (never spam)
   - δοκιμαστικό lead από κάθε πηγή
7. **2 εβδομάδες παράλληλης λειτουργίας** με το υπάρχον email του πελάτη. Μετά ρύθμιση των heartbeat ορίων.

### Τι χρειάζεται από σένα για να ξεκινήσει η Φάση 1
- Ποιος είναι ο πρώτος πελάτης, ποια portals χρησιμοποιεί και ποιο plugin φόρμας έχει το site.
- **Πραγματικά emails** (τουλάχιστον 3 ανά portal και ανά φόρμα, ανωνυμοποιημένα αν θες). Χωρίς αυτά οι parsers δεν μπορούν να γραφτούν σωστά.
- Gmail: νέος αποκλειστικός λογαριασμός (προτείνεται) ή κάποιος υπάρχων.
- ~~Κανάλια~~: ο agent ειδοποιείται με email. Σε σένα πάνε μόνο σφάλματα, με email.
- ~~VPS~~: το υπάρχον n8n στη Hostinger.
- Η φόρμα του site έχει πεδίο τηλεφώνου.
