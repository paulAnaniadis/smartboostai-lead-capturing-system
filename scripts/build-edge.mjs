// Φτιάχνει μια έκδοση της Edge Function σε ΕΝΑ αρχείο (dashboard.ts), για επικόλληση
// στον editor του Supabase Dashboard χωρίς Supabase CLI.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'functions', 'meta-webhook');
const handler = readFileSync(join(dir, 'handler.js'), 'utf8').replace(/^export /gm, '');
const index = readFileSync(join(dir, 'index.ts'), 'utf8').replace(/^import .*handler\.js';\n/m, '');
const out = `// ΠΑΡΑΓΕΤΑΙ από scripts/build-edge.mjs — για επικόλληση στο Supabase Dashboard (Edge Functions).
// Η πηγή είναι τα handler.js + index.ts στον ίδιο φάκελο.
${handler}
// ---------------------------------------------------------------------------
${index}`;
writeFileSync(join(dir, 'dashboard.ts'), out);
console.log(join(dir, 'dashboard.ts'));
