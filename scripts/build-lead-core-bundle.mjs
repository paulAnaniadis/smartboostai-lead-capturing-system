// Πακετάρει το lead-core σε ένα αρχείο (IIFE που ορίζει το global `LeadCore`),
// για να μπει αυτούσιο μέσα στα Code nodes του n8n χωρίς αλλαγές στον server.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const BUNDLE_PATH = join(root, 'n8n', 'build', 'lead-core.bundle.js');

export async function buildBundle() {
  await build({
    entryPoints: [join(root, 'lead-core', 'src', 'index.js')],
    bundle: true,
    format: 'iife',
    globalName: 'LeadCore',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    target: 'es2020',
    minify: true,
    legalComments: 'none',
    outfile: BUNDLE_PATH,
  });
  return BUNDLE_PATH;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(await buildBundle());
}
