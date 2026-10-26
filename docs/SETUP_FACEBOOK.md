# Στήσιμο: Φάση 2 (Facebook Lead Ads)

Προϋπόθεση: έχει στηθεί η Φάση 1 ([`SETUP.md`](SETUP.md)).

Τι προστίθεται:
- **Receiver στη Supabase** (Edge Function `meta-webhook`): δέχεται τα leads από τη Meta τη στιγμή που
  δημιουργούνται και τα σώζει στη βάση. Δεν εξαρτάται από το VPS.
- **n8n «5 Facebook»:** φέρνει τα στοιχεία κάθε lead από το Graph API και τα καταχωρεί.
- **n8n «6 Facebook reconciliation»:** κάθε 2 ώρες ξαναρωτάει το Facebook για τα leads των τελευταίων 48 ωρών.
  Ό,τι χάθηκε ανακτάται, και ό,τι υπάρχει ήδη αγνοείται.

**Σύνδεση με τις άλλες πηγές:** ο ίδιος άνθρωπος (ίδιο τηλέφωνο ή email) από Facebook και από Σπιτόγατο ή site
είναι **η ίδια επαφή**. Για να γίνεται και **το ίδιο ενδιαφέρον** όταν πρόκειται για το ίδιο ακίνητο,
δηλώνεις την αντιστοίχιση των κωδικών (βήμα 7).

---

## 1. Supabase: βάση
SQL Editor → τρέξε `supabase/migrations/20261026000006_facebook_and_property_aliases.sql`.

## 2. Meta: app και επαλήθευση (μία φορά για όλους τους πελάτες)
1. https://business.facebook.com → το Business portfolio του SmartBoostAI → **Security Center → Business verification**.
   Μπορεί να πάρει μέρες, οπότε ξεκίνα πρώτα αυτό.
2. https://developers.facebook.com → **Create app** → τύπος **Business** → σύνδεσέ το με το Business portfolio.
3. Στο app: **App settings → Basic**. Κράτα το **App Secret**.
4. Permissions που θα χρειαστούν (App Review, για χρήση σε σελίδες πελατών):
   `leads_retrieval`, `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata`, `ads_read`, `business_management`.

## 3. System User (το «κλειδί» του n8n, που δεν λήγει)
1. Business Settings → **Users → System users → Add** → ρόλος **Admin**.
2. **Add assets** → τις Σελίδες των πελατών, με πλήρη δικαιώματα (μαζί και Leads).
   Για να εμφανιστεί η Σελίδα ενός πελάτη, ο πελάτης πρέπει πρώτα να τη μοιραστεί με το Business σου:
   στο δικό του Business Settings → **Partners → Add** → το Business ID σου → Σελίδα.
3. **Generate token** → διάλεξε το app σου → **Token expiration: Never** → τα permissions του βήματος 2.4 → αντέγραψε το token.
4. Στη Σελίδα του πελάτη: **Leads Access** (Leads Access Manager) → πρόσθεσε το app ή τον System User,
   ώστε να μπορεί να διαβάζει leads.

## 4. Supabase: ο receiver (Edge Function)
Από το Dashboard της Supabase, χωρίς εργαλεία γραμμής εντολών:
1. **Edge Functions → Deploy a new function → Via editor** → όνομα: **`meta-webhook`**.
2. Σβήσε τον κώδικα-παράδειγμα και επικόλλησε **όλο** το `supabase/functions/meta-webhook/dashboard.ts`.
3. **Deploy**.
4. Στις ρυθμίσεις της function: **Enforce JWT verification → OFF**. Η Meta δεν στέλνει JWT. Την προστασία
   την κάνει ο έλεγχος υπογραφής με το App Secret.
5. **Edge Functions → Secrets** → πρόσθεσε:
   - `META_APP_SECRET` = το App Secret του βήματος 2.3
   - `META_VERIFY_TOKEN` = μια τυχαία λέξη που επιλέγεις εσύ (π.χ. 30 γράμματα και αριθμοί)
6. Το URL της function είναι `https://<project-ref>.supabase.co/functions/v1/meta-webhook`.

(Εναλλακτικά με CLI: `supabase secrets set …` και `supabase functions deploy meta-webhook --no-verify-jwt`.)

## 5. Meta: σύνδεση του webhook
1. Στο app: **Webhooks** → επίλεξε **Page** → **Subscribe to this object**:
   - Callback URL: το URL του βήματος 4.6
   - Verify token: το `META_VERIFY_TOKEN`
   → **Verify and save**. Αν αποτύχει, έλεγξε ότι το JWT verification είναι OFF.
2. Στο ίδιο σημείο: πεδίο **`leadgen` → Subscribe**.
3. Για **κάθε Σελίδα πελάτη**, μία φορά: στο Graph API Explorer με page token της Σελίδας,
   `POST /{page_id}/subscribed_apps?subscribed_fields=leadgen`. Πρέπει να απαντήσει `{"success": true}`.

## 6. n8n
1. **Credentials → Add → Query Auth**:
   - Όνομα: `Meta System User`
   - Name: `access_token`
   - Value: το token του βήματος 3.3
2. Import τα `n8n/workflows/5-facebook.json` και `6-facebook-reconciliation.json` (όπως τα άλλα).
3. Credentials: `Leads Supabase` στα Postgres nodes και `Meta System User` στα «Get page token».
4. **Config** και στα δύο: `graph_version`, η τρέχουσα έκδοση του Graph API (δες
   https://developers.facebook.com/docs/graph-api/changelog). Οι παλιές εκδόσεις αποσύρονται περίπου μετά από 2 χρόνια.
5. Settings → Error workflow → «Leads · 0 Errors» → **Active**.

## 7. Ανά πελάτη (SQL Editor)
```sql
-- Η Σελίδα Facebook του πελάτη (page_id από τα στοιχεία της Σελίδας). Alert αν σιωπήσει 14 μέρες.
insert into leads.source_accounts (client_id, channel, identifier, heartbeat_max_silence)
select id, 'fb_leadgen', '<page_id>', interval '14 days' from leads.clients where slug = '<πελάτης>';

-- Αντιστοίχιση κωδικών: η διαφήμιση X αφορά το ίδιο ακίνητο με την αγγελία Y του Σπιτόγατου.
-- Το ad_id φαίνεται στο Ads Manager (στήλη «Ad ID»).
select leads.set_property_alias('<πελάτης>', 'fb_ad:<ad_id>',              'site:KAL-102');
select leads.set_property_alias('<πελάτης>', 'spitogatos:<κωδικός αγγελίας>', 'site:KAL-102');
```
Χωρίς αντιστοίχιση όλα δουλεύουν κανονικά. Απλώς το ίδιο ακίνητο από δύο πηγές καταγράφεται ως δύο ενδιαφέροντα
**της ίδιας επαφής**.

## 8. Δοκιμή
1. https://developers.facebook.com/tools/lead-ads-testing → διάλεξε Σελίδα και φόρμα → **Create lead**.
2. Σε 1–2 λεπτά:
   ```sql
   select c.full_name_raw, i.source, i.property_ref, i.context->>'campaign_name' as campaign, i.touch_count
   from leads.inquiries i join leads.contacts c on c.id = i.contact_id
   where i.source = 'facebook' order by i.id desc limit 5;
   ```
3. Δοκιμή σύνδεσης πηγών: στείλε δοκιμαστικό email (όπως στη Φάση 1) με **το ίδιο τηλέφωνο** με το test lead
   → πρέπει να μπει στην **ίδια επαφή**.
