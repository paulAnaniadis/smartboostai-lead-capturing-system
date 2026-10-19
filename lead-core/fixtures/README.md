# Fixtures

**Όλα τα emails εδώ είναι ΕΙΚΟΝΙΚΑ.** Φτιάχτηκαν για να ελεγχθεί η λογική, και δεν
αντιγράφουν πραγματικό template κάποιου portal ή form plugin. Τα πρόσωπα, τα τηλέφωνα
και τα emails είναι επινοημένα (domains `example.com` / `.example`).

Πριν ένας parser πάει σε πελάτη:
1. Προσθέτεις ≥3 **πραγματικά** emails της πηγής (ανωνυμοποιημένα) σε αυτόν τον φάκελο.
2. Προσαρμόζεις τον parser μέχρι να περνάνε.
3. Τα εικονικά μένουν ως regression tests.

Μορφή αρχείου:
```json
{
  "description": "τι ελέγχει",
  "synthetic": true,
  "payload": { "headers": { ... }, "text": "...", "html": "..." },
  "expect": { "action": "ingest|review|ignore", "kind": "...", "matchedBy": "...", "lead": { ...υποσύνολο πεδίων... } }
}
```
Τα routes του δοκιμαστικού πελάτη είναι στο `routes.json`.
