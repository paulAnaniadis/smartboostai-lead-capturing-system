// Τρέχει όλα τα fixtures (fixtures/<parser>/*.json) μέσα από το processEmail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processEmail } from '../src/index.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const routes = JSON.parse(readFileSync(join(dir, 'routes.json'), 'utf8'));
const client = { slug: 'demo', default_region: 'GR' };

// Το expected είναι υποσύνολο: ελέγχονται μόνο τα κλειδιά που δηλώνει.
function assertSubset(actual, expected, path = '') {
  for (const [k, v] of Object.entries(expected)) {
    const p = path ? `${path}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      assert.ok(actual?.[k] && typeof actual[k] === 'object', `${p} missing`);
      assertSubset(actual[k], v, p);
    } else {
      assert.deepEqual(actual?.[k], v, p);
    }
  }
}

for (const sub of readdirSync(dir).filter((d) => statSync(join(dir, d)).isDirectory())) {
  for (const file of readdirSync(join(dir, sub)).filter((f) => f.endsWith('.json'))) {
    const fx = JSON.parse(readFileSync(join(dir, sub, file), 'utf8'));
    test(`${sub}/${file}: ${fx.description}`, () => {
      const result = processEmail(fx.payload, { client, routes });
      assert.equal(result.action, fx.expect.action, JSON.stringify(result, null, 2));
      if (fx.expect.kind) assert.equal(result.kind, fx.expect.kind);
      if (fx.expect.matchedBy) assert.equal(result.matchedBy, fx.expect.matchedBy);
      if (fx.expect.lead) assertSubset(result.lead, fx.expect.lead);
      if (result.action === 'ingest') {
        assert.match(result.lead.message_hash, /^[0-9a-f]{64}$/);
        assert.match(result.lead.parser_version, /^[a-z0-9_]+@\d+\.\d+\.\d+$/);
      }
    });
  }
}
