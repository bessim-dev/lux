#!/usr/bin/env node
// Thin launcher so `lux` works from a checkout after `npm run agent:build`.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

if (Number(process.versions.node.split('.')[0]) < 22) {
  process.stderr.write(`lux requires Node.js 22 or newer; this is ${process.versions.node}.\n`);
  process.exit(1);
}

const bundle = new URL('../dist/lux.mjs', import.meta.url);
if (!existsSync(fileURLToPath(bundle))) {
  process.stderr.write('lux: not built. Run `npm ci && npm run agent:build` in the Lux repository.\n');
  process.exit(1);
}
await import(bundle.href);
