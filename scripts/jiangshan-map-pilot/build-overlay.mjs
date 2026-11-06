#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const req = createRequire(path.join(root, 'remotion/package.json'));
const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--output', '--variant'].includes(args[i]) || !args[i + 1]) throw Error('Usage: build-overlay.mjs [--output file.js] [--variant pilot|refined]');
  options[args[i]] = args[i + 1];
}
const variant = options['--variant'] || 'pilot';
if (!['pilot', 'refined'].includes(variant)) throw Error(`Unknown variant: ${variant}`);
const outfile = path.resolve(options['--output'] || path.join(root, 'outputs/jiangshan-map-study-20261101/native-overlay.js'));
fs.mkdirSync(path.dirname(outfile), {recursive: true});
await req('esbuild').build({entryPoints: [path.join(root, `remotion/src/${variant === 'refined' ? 'JiangshanMapRefined' : 'JiangshanMapPilot'}.tsx`)], outfile,
  bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', target: 'chrome110',
  define: {'process.env.NODE_ENV': '"production"'}, logLevel: 'warning'});
console.log(outfile);
