// ESM entry; run through backend/run-tsx.mjs for the existing provider config.
import '../../backend/src/load-env.js';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readJson, assertApproved} from './core.mjs';
import {generateNarrations} from './narration.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const jobIndex = args.indexOf('--job');
if (jobIndex < 0 || !args[jobIndex + 1]) throw Error('--job is required');
const jobDir = path.resolve(args[jobIndex + 1]);
const jobFile = path.join(jobDir, 'job.json');
const job = readJson(jobFile);
// Gate before importing the provider (and before any paid request).
await assertApproved(job);
const {generateTTSWithMetadata} = await import('../../backend/src/services/tts-generation.js');
const result = await generateNarrations({
  jobDir,
  generate: generateTTSWithMetadata,
  storageRoot: process.env.STORAGE_PATH || path.join(root, 'data/static'),
});
console.log(`Narration: ${result.generated.length} generated, ${result.reused.length} reused, ${result.skipped.length} original-audio segments.`);
