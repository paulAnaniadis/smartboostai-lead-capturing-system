# smartboostai-lead-capturing-system

Σύστημα συλλογής leads για μεσιτικά γραφεία: email (site, portals) → Facebook Lead Ads → WhatsApp.
Δεν χάνει leads, δεν τα διπλασιάζει, και αναγνωρίζει τον ίδιο άνθρωπο όταν επανέρχεται.

Ο σχεδιασμός περιγράφεται στο [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Τι υπάρχει

| φάκελος | τι είναι |
|---|---|
| `supabase/migrations/` | Schema και functions (`ingest_lead`, capture, retries, review, outbox, reports) |
| `supabase/tests/` | Integration tests της βάσης |
| `lead-core/` | Parsing emails και κανονικοποίηση (τηλέφωνα, email, ονόματα, κωδικοί ακινήτων) |
| `lead-core/fixtures/` | Δοκιμαστικά emails (**εικονικά** προς το παρόν) |

## Tests

```bash
npm install
npm test            # lead-core + βάση
npm run test:core   # μόνο parsers/normalization
npm run test:db     # μόνο βάση (στήνει προσωρινή Postgres 15+)
```

## Κατάσταση

Φάση 1 (email): έτοιμα η βάση και ο lead-core. Επόμενο: n8n workflows και server.
Οι parsers είναι γραμμένοι πάνω σε εικονικά emails. Πριν πάνε σε πελάτη χρειάζονται πραγματικά.
