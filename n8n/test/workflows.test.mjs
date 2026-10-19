// Στατικοί έλεγχοι στα παραγόμενα workflows (n8n/workflows/*.json).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'workflows');
const files = readdirSync(dir).filter((f) => f.endsWith('.json'));

const expressions = (value, out = []) => {
  if (typeof value === 'string' && value.startsWith('=')) {
    for (const m of value.matchAll(/\{\{([\s\S]*?)\}\}/g)) out.push(m[1]);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) expressions(v, out);
  }
  return out;
};

for (const file of files) {
  const wf = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  const names = new Set(wf.nodes.map((n) => n.name));

  test(`${file}: συνδέσεις σε υπαρκτά nodes, χωρίς διπλά ονόματα/ids`, () => {
    assert.equal(names.size, wf.nodes.length);
    assert.equal(new Set(wf.nodes.map((n) => n.id)).size, wf.nodes.length);
    for (const [from, c] of Object.entries(wf.connections)) {
      assert.ok(names.has(from), `άγνωστο node ${from}`);
      for (const out of c.main) for (const link of out) assert.ok(names.has(link.node), `${from} → ${link.node}`);
    }
  });

  test(`${file}: ο κώδικας των Code nodes είναι συντακτικά σωστός`, () => {
    for (const n of wf.nodes.filter((x) => x.type === 'n8n-nodes-base.code')) {
      assert.doesNotThrow(() => new vm.Script(`(async function(){\n${n.parameters.jsCode}\n})`), n.name);
    }
  });

  test(`${file}: expressions συντακτικά σωστά, και $('Node') σε υπαρκτά nodes`, () => {
    for (const n of wf.nodes) {
      for (const expr of expressions(n.parameters)) {
        assert.doesNotThrow(() => new vm.Script(`(${expr})`), `${n.name}: ${expr}`);
      }
      const all = JSON.stringify(n.parameters);
      for (const m of all.matchAll(/\$\(\\?['"]([^'"\\]+)\\?['"]\)/g)) {
        assert.ok(names.has(m[1]), `${n.name} αναφέρεται σε άγνωστο node «${m[1]}»`);
      }
    }
  });

  test(`${file}: Postgres nodes: independent batching, ίδιος αριθμός $N και παραμέτρων`, () => {
    for (const n of wf.nodes.filter((x) => x.type === 'n8n-nodes-base.postgres')) {
      assert.equal(n.parameters.options.queryBatching, 'independently', n.name);
      const maxN = Math.max(0, ...[...n.parameters.query.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
      const repl = n.parameters.options.queryReplacement;
      const count = repl ? repl.split(' ?? null').length - 1 : 0;
      assert.equal(count, maxN, `${n.name}: ${maxN} placeholders, ${count} παράμετροι`);
    }
  });
}
