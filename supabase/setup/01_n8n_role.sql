-- Τρέξ' το ΜΙΑ φορά στο Supabase SQL Editor, ΜΕΤΑ τα migrations.
-- Δίνει login στον role που χρησιμοποιεί το n8n. Άλλαξε τον κωδικό πριν το τρέξεις
-- και κράτα τον σε password manager· θα τον βάλεις στο Postgres credential του n8n.
alter role n8n_app with login password 'ΑΛΛΑΞΕ-ΜΕ-ΜΑΚΡΥ-ΤΥΧΑΙΟ-ΚΩΔΙΚΟ';

-- Σύνδεση από το n8n (Supabase → Connect → Session pooler):
--   Host:     aws-0-<region>.pooler.supabase.com
--   Port:     5432
--   Database: postgres
--   User:     n8n_app.<project-ref>
--   SSL:      require
