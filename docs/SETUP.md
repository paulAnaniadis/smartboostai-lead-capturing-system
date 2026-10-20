# Στήσιμο: Φάση 1 (email)

Οδηγός βήμα-βήμα για να τρέξει το σύστημα στο self-hosted n8n (Hostinger VPS) με Supabase.
Χρόνος: περίπου 1–1,5 ώρα την πρώτη φορά.

Τι θα έχεις στο τέλος:
- 5 workflows στο n8n (Errors, Capture, Process, Notify, Monitor)
- τη βάση στο Supabase
- ένα lead mailbox στο Gmail
- εξωτερικό έλεγχο ότι το n8n είναι ζωντανό (healthchecks.io)

Σε σένα έρχονται **μόνο σφάλματα**. Όταν όλα δουλεύουν, δεν λαμβάνεις τίποτα.

---

## 1. Supabase

1. Φτιάξε project στο Supabase.
   - **Για στήσιμο και δοκιμές: Free.** Δεν θα μπει σε pause όσο τα workflows είναι ενεργά, γιατί ρωτάνε τη βάση κάθε λεπτό. Αν μπει, το ξυπνάς με ένα κλικ από το dashboard.
   - **Πριν μπει ο πρώτος πραγματικός πελάτης: αναβάθμιση σε Pro** (backups). Η αναβάθμιση γίνεται στο ίδιο project, χωρίς μεταφορά δεδομένων και χωρίς αλλαγές στο n8n. Το κόστος καλύπτει όλους τους πελάτες μαζί.
2. **SQL Editor** → τρέξε με αυτή τη σειρά το περιεχόμενο των αρχείων:
   1. `supabase/migrations/20261019000001_schema.sql`
   2. `supabase/migrations/20261019000002_functions.sql`
   3. `supabase/setup/01_n8n_role.sql`: **πρώτα άλλαξε τον κωδικό** μέσα στο αρχείο.
3. **Connect → Session pooler**: κράτα host, port, database και project ref. Θα τα χρειαστείς στο βήμα 4.

> Χρησιμοποίησε τον **Session pooler** και όχι τη Direct connection. Η direct σύνδεση του
> Supabase είναι μόνο IPv6, και πολλά VPS δεν συνδέονται σε αυτήν.

## 2. Lead mailbox (Gmail)

1. Φτιάξε **νέο, αποκλειστικό** λογαριασμό Gmail (π.χ. `smartboost.leads@gmail.com`), με 2FA.
2. Στο Gmail φτιάξε ένα label με όνομα ακριβώς **`lead-captured`**.
   Το σύστημα βάζει αυτό το label σε κάθε email που έχει σωθεί στη βάση.
3. Κάθε πελάτης έχει δική του διεύθυνση: `smartboost.leads+<πελάτης>@gmail.com`.
   Όλες καταλήγουν στο ίδιο inbox, και το σύστημα ξεχωρίζει τον πελάτη από το «+…».

Τα emails που πέφτουν στα Spam διαβάζονται κι αυτά. Δεν σβήνεις τίποτα από το mailbox.

## 3. Google Cloud (για να διαβάζει το n8n το Gmail)

1. https://console.cloud.google.com → νέο project (π.χ. «Leads n8n»).
2. **APIs & Services → Library → Gmail API → Enable**.
3. **OAuth consent screen**: User type **External**. Συμπλήρωσε όνομα και email. Στα test users βάλε το lead mailbox.
4. **Πολύ σημαντικό:** στο **Publishing status** πάτα **Publish app** ώστε να γίνει **In production**.
   Σε «Testing» η σύνδεση λήγει κάθε 7 μέρες και το σύστημα σταματάει χωρίς να το καταλάβεις.
   Η Google θα δείξει την ένδειξη «unverified app» στη σύνδεση. Είναι φυσιολογικό για δική σου χρήση: πάτα «Advanced → Continue».
5. **Credentials → Create credentials → OAuth client ID** → τύπος **Web application**.
   Στο *Authorized redirect URIs* βάλε το URL που δείχνει το n8n στο βήμα 4 (OAuth Redirect URL).
6. Κράτα το Client ID και το Client Secret.

## 4. Credentials στο n8n

Στο n8n → **Credentials → Add credential**:

| Όνομα (ακριβώς) | Τύπος | Τιμές |
|---|---|---|
| `Leads Gmail` | Gmail OAuth2 API | Client ID και Secret από το βήμα 3 → **Sign in with Google** με το lead mailbox |
| `Leads Supabase` | Postgres | Host/Port/Database από το βήμα 1.3 · User: `n8n_app.<project-ref>` · Password: αυτός του βήματος 1.2.3 · **SSL: require** |

## 5. healthchecks.io (εξωτερικός έλεγχος ότι το n8n ζει)

Αν πέσει το VPS ή το n8n, κανένα workflow δεν μπορεί να σε ειδοποιήσει, γιατί έχουν πέσει κι αυτά.
Γι' αυτό ο έλεγχος γίνεται από έξω.

1. Φτιάξε λογαριασμό στο https://healthchecks.io (το free αρκεί).
2. Φτιάξε 2 checks: **Leads Capture** και **Leads Process**, και στα δύο: Period **1 minute**, Grace **15 minutes**.
3. Κράτα τα 2 ping URLs.
4. Ενεργοποίησε ειδοποίηση με email προς εσένα (και Telegram αν θες).

## 6. Workflows

1. Στο n8n: **Workflows → Add workflow → ⋯ → Import from file**, για κάθε αρχείο του `n8n/workflows/`:
   - `0-errors.json`
   - `1-capture-gmail.json`
   - `2-process.json`
   - `3-notify-agents.json`
   - `4-monitor.json`
2. Σε κάθε workflow, σε όσα nodes δείχνουν προειδοποίηση credential, διάλεξε `Leads Gmail` ή `Leads Supabase`.
3. Άνοιξε το node **Config** κάθε workflow και συμπλήρωσε:
   - `0 Errors` και `4 Monitor`: `alert_email`, το δικό σου email.
   - `1 Capture`: `healthcheck_url`, το URL του check Leads Capture.
   - `2 Process`: `healthcheck_url`, το URL του check Leads Process.
4. Στα workflows 1–4: **⋯ → Settings → Error workflow → «Leads · 0 Errors»** → Save.
5. Ενεργοποίησε (Active) τα workflows 1, 2, 3 και 4. Το 0 δεν χρειάζεται ενεργοποίηση.

Ρύθμιση του n8n στο VPS: βεβαιώσου ότι υπάρχει `GENERIC_TIMEZONE=Europe/Athens`, ώστε το
νυχτερινό καθάρισμα να τρέχει στις 03:15 ώρα Ελλάδας. Τα workflows αποθηκεύουν μόνο τις αποτυχημένες
εκτελέσεις, οπότε η βάση του n8n δεν φουσκώνει από τις εκτελέσεις κάθε λεπτού.

## 7. Πρώτος πελάτης

Στο `supabase/setup/02_client_template.sql` άλλαξε τις τιμές με `<…>` και τρέξ' το στο SQL Editor:
- `notify_emails`: πού πάνε τα leads (email του agent ή των agents)
- `identifier`: η plus-διεύθυνση, π.χ. `smartboost.leads+demo@gmail.com` (πεζά)
- `match_from` του site: από ποια διεύθυνση στέλνει η φόρμα του site (συνήθως `wordpress@<domain>`)

Μετά, στο σύστημα του πελάτη:
- **Σπιτόγατος:** στον λογαριασμό του portal, στο email ειδοποιήσεων μηνυμάτων, βάλε την plus-διεύθυνση.
  Αν δεν γίνεται, κανόνας auto-forward από το inbox του πελάτη (το σύστημα αναγνωρίζει τα forwards).
- **Φόρμα site:** παραλήπτης η plus-διεύθυνση. Πεδία: Όνομα, Επίθετο, Email, Τηλέφωνο, Ενδιαφέρον,
  και **κρυφό πεδίο** «Κωδικός ακινήτου» (ή «URL») με τον κωδικό της σελίδας.

## 8. Δοκιμή από άκρη σε άκρη

1. Πρόσθεσε προσωρινό route για το δικό σου email:
   ```sql
   insert into leads.email_routes (client_id, source, parser, match_from, priority)
   select id, 'website', 'website_form_v1', array['<το-email-σου>'], 1 from leads.clients where slug = 'demo';
   ```
2. Στείλε από το email σου στο `…+demo@gmail.com` ένα μήνυμα με σώμα:
   ```
   Όνομα: Δοκιμή
   Επίθετο: Τεστ
   Email: <ένα δεύτερο email σου>
   Τηλέφωνο: 69XXXXXXXX
   Ενδιαφέρον: Δοκιμαστικό μήνυμα
   Κωδικός ακινήτου: TEST-1
   ```
3. Μέσα σε 1–3 λεπτά ο agent (`notify_emails`) λαμβάνει «Νέο lead: Δοκιμή Τεστ». Ξαναστείλε το ίδιο:
   **δεν** πρέπει να έρθει δεύτερη ειδοποίηση, γιατί γίνεται touch στο υπάρχον inquiry.
4. Σβήσε το προσωρινό route:
   ```sql
   delete from leads.email_routes where match_from = array['<το-email-σου>'];
   ```

## 9. Καθημερινή χρήση (μόνο όταν έρθει alert)

```sql
-- Τι περιμένει απόφαση
select id, kind, blocking, note, raw_event_id, created_at
from leads.review_queue where status = 'open' order by blocking desc, created_at;

-- Τι ακριβώς ήρθε σε ένα γεγονός
select status, source, last_error, payload from leads.raw_events where id = <raw_event_id>;

-- Αποφάσεις: dismiss | ignore | reprocess | merge | ingest_manual
select leads.resolve_review(<review_id>, 'ignore');
select leads.resolve_review(<review_id>, 'reprocess');   -- μετά από διόρθωση parser
select leads.resolve_review(<review_id>, 'merge');       -- για possible_merge

-- Γεγονότα που απέτυχαν οριστικά: ξανά στην ουρά
select leads.reprocess_raw_event(id) from leads.raw_events where status = 'dead';
```

## 10. Αλλαγή parser (π.χ. άλλαξε το template του Σπιτόγατου)

1. Βάλε το νέο email (ανωνυμοποιημένο) στο `lead-core/fixtures/<parser>/` και διόρθωσε τον parser μέχρι να περνάει το `npm test`.
2. `node scripts/build-n8n.mjs` → ξαναφτιάχνει τα `n8n/workflows/*.json`.
3. Στο n8n, στο workflow `2 Process`: **⋯ → Import from file** με το νέο `2-process.json`. Ξαναδιάλεξε credentials αν ζητηθούν και κάνε Save.
4. Για τα emails που είχαν κολλήσει: `select leads.resolve_review(<id>, 'reprocess')`.
