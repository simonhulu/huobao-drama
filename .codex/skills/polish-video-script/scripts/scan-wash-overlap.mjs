#!/usr/bin/env node

// Wash-overlap scanner (重合扫描器) — transplant-mode COPY-PASTE GUARD.
//
// What this is: a deterministic literal-overlap check between the final clean script
// and the original RAW source (00-original-source.raw.txt). It catches copy-paste and
// shallow paraphrase that keeps long literal runs. What it is NOT: a semantic
// wash-depth verdict. Sentence-by-sentence synonym rewrites with zero literal overlap
// pass this scan; semantic/isomorphic reuse is handled by the creator's side-by-side
// source-separation review (终审并排审). Do not call this a 洗深验收.
//
// Threshold calibration: DEFAULT_MIN_GRAM / DEFAULT_MAX_RATIO / DEFAULT_MAX_RUN are
// INITIAL values (宁紧勿松). Recalibrate with real samples after the first 3 actual
// transplant runs: collect the (raw, final) pairs plus one hand-made shallow-wash
// pair, pick the loosest parameter set that passes every real pair, blocks the
// shallow pair, and keeps a >=2-char margin between the real pairs' longest run and
// the run threshold; then record the dataset and date here. Calibration is a
// reminder, not a stop condition (SKILL.md persistence section carries the pointer).
//
// Usage:
//   node scan-wash-overlap.mjs --script <final.md> --original <00-original-source.raw.txt> \
//        [--allow <new-material-file>]... [--autopsy <00-autopsy.json>] \
//        [--min 8] [--max-ratio 0.02] [--max-run 14] [--json] [--report <path>]
//
// --original is the RAW source (byte-exact user input), never the cleaned transcript.
// --allow files are new-topic material: a shared run whose text also appears inside an
// allow file (e.g. a source-record quote both scripts legitimately cite) is exempted
// from the max_run check ONLY. It still counts toward the overlap ratio (D7 narrow
// exemption).
// --autopsy enables the original-author fingerprint blocklist scan (review-side use
// of the blocklist; it never reaches the writer packet).
//
// Exit codes: 0 = pass, 1 = wash violation, 2 = usage/IO error.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeComparableText } from "./text-normalize.mjs";

export { normalizeComparableText };

const DEFAULT_MIN_GRAM = 8;      // initial value — recalibrate after 3 real transplant runs
const DEFAULT_MAX_RATIO = 0.02;  // initial value: matched chars / normalized candidate chars
const DEFAULT_MAX_RUN = 14;      // initial value: any single shared run longer than this is a blocker

export { DEFAULT_MIN_GRAM, DEFAULT_MAX_RATIO, DEFAULT_MAX_RUN };

function splitParagraphs(text) {
  return text.replace(/\r\n/g, "\n").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
}

export function findOverlapRuns(scriptText, originalText, minLength = DEFAULT_MIN_GRAM) {
  if (!Number.isInteger(minLength) || minLength < 6) {
    throw new Error("minLength must be an integer of at least 6");
  }
  const candidate = normalizeComparableText(scriptText);
  const source = normalizeComparableText(originalText);
  // gram -> positions in the original (exact extension, adapted from
  // tools/writing-corpus/check-overlap.mjs)
  const sourceGrams = new Map();
  for (let i = 0; i <= source.length - minLength; i += 1) {
    const gram = source.slice(i, i + minLength);
    const positions = sourceGrams.get(gram) || [];
    positions.push(i);
    sourceGrams.set(gram, positions);
  }
  const runs = [];
  let i = 0;
  while (i <= candidate.length - minLength) {
    const gram = candidate.slice(i, i + minLength);
    const sourcePositions = sourceGrams.get(gram);
    if (!sourcePositions) {
      i += 1;
      continue;
    }
    let best = minLength;
    for (const sp of sourcePositions) {
      let length = minLength;
      while (
        i + length < candidate.length &&
        sp + length < source.length &&
        candidate[i + length] === source[sp + length]
      ) {
        length += 1;
      }
      if (length > best) best = length;
    }
    runs.push({ index: i, length: best, text: candidate.slice(i, i + best) });
    i += best;
  }
  return { candidateLength: candidate.length, runs };
}

export function attributeToParagraphs(scriptText, runs) {
  // normalize(whole script) === concat(normalize(paragraphs)) because normalization strips
  // all separators; offsets are therefore contiguous and paragraph attribution is exact.
  const paragraphs = splitParagraphs(scriptText);
  const ranges = [];
  let offset = 0;
  for (const paragraph of paragraphs) {
    const normalized = normalizeComparableText(paragraph);
    ranges.push({ start: offset, end: offset + normalized.length });
    offset += normalized.length;
  }
  return runs.map((run) => {
    const hit = ranges.findIndex((range) => run.index >= range.start && run.index < range.end);
    return { ...run, paragraph: hit === -1 ? null : hit + 1 };
  });
}

// Raw metrics with NO exemption applied. The audit-log `wash_overlap` record stores
// these exact values, and validate-production-run.mjs recomputes them with this same
// function and hard-fails on any mismatch.
export function computeWashMetrics(scriptText, originalText, minLength = DEFAULT_MIN_GRAM) {
  const { candidateLength, runs } = findOverlapRuns(scriptText, originalText, minLength);
  const matchedChars = runs.reduce((sum, run) => sum + run.length, 0);
  const ratio = candidateLength === 0 ? 0 : matchedChars / candidateLength;
  const longestRun = runs.reduce((max, run) => Math.max(max, run.length), 0);
  return {
    overlapRatio: Number(ratio.toFixed(4)),
    matchedChars,
    candidateChars: candidateLength,
    longestRun,
    runs,
  };
}

export function allowExemptedRuns(runs, allowTexts) {
  // A run is exempt from the max_run check when its (normalized) text also appears in
  // an allow file. Exemption never touches the ratio.
  const allowNormalized = (allowTexts || []).map((text) => normalizeComparableText(text));
  const isExempt = (run) => allowNormalized.some((allow) => allow.length > 0 && allow.includes(run.text));
  const nonExempt = runs.filter((run) => !isExempt(run));
  const exempt = runs.filter(isExempt);
  return {
    nonExempt,
    exempt,
    longestRunAfterAllow: nonExempt.reduce((max, run) => Math.max(max, run.length), 0),
  };
}

function parseArgs(argv) {
  const result = { min: DEFAULT_MIN_GRAM, maxRatio: DEFAULT_MAX_RATIO, maxRun: DEFAULT_MAX_RUN, allow: [], json: false };
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--script") { result.script = value; i += 1; }
    else if (key === "--original") { result.original = value; i += 1; }
    else if (key === "--autopsy") { result.autopsy = value; i += 1; }
    else if (key === "--allow") { result.allow.push(value); i += 1; }
    else if (key === "--min") { result.min = Number(value); i += 1; }
    else if (key === "--max-ratio") { result.maxRatio = Number(value); i += 1; }
    else if (key === "--max-run") { result.maxRun = Number(value); i += 1; }
    else if (key === "--json") { result.json = true; }
    else if (key === "--report") { result.report = value; i += 1; }
    else throw new Error("unknown argument: " + key);
  }
  if (!result.script || !result.original) {
    throw new Error("--script and --original are required");
  }
  return result;
}

export function main(argv = process.argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error("Usage: node scan-wash-overlap.mjs --script <final.md> --original <00-original-source.raw.txt> [--allow <new-material-file>]... [--autopsy <00-autopsy.json>] [--min 8] [--max-ratio 0.02] [--max-run 14] [--json] [--report <path>]");
    console.error(error.message);
    return 2;
  }

  let scriptText;
  let originalText;
  let autopsy;
  let allowTexts;
  try {
    scriptText = fs.readFileSync(path.resolve(args.script), "utf8");
    originalText = fs.readFileSync(path.resolve(args.original), "utf8");
    if (args.autopsy) autopsy = JSON.parse(fs.readFileSync(path.resolve(args.autopsy), "utf8"));
    allowTexts = args.allow.map((file) => fs.readFileSync(path.resolve(file), "utf8"));
  } catch (error) {
    console.error("Unable to read script, original raw source, autopsy, or allow file: " + error.message);
    return 2;
  }

  const metrics = computeWashMetrics(scriptText, originalText, args.min);
  const { exempt, longestRunAfterAllow } = allowExemptedRuns(metrics.runs, allowTexts);
  const attributed = attributeToParagraphs(scriptText, metrics.runs);

  // 原作者风格指纹隔离: literal blocklist from the autopsy (口头禅 / 标志性句式).
  const normalizedScript = normalizeComparableText(scriptText);
  const blocklistHits = [];
  for (const item of autopsy?.fingerprint_blocklist || []) {
    const phrase = normalizeComparableText(String(item?.phrase || ""));
    if (phrase.length === 0) continue;
    const count = normalizedScript.split(phrase).length - 1;
    if (count > 0) blocklistHits.push({ phrase: item.phrase, note: item.note || "", count });
  }

  const violations = [];
  if (metrics.overlapRatio > args.maxRatio) {
    violations.push("overlap ratio " + metrics.overlapRatio.toFixed(4) + " exceeds " + args.maxRatio);
  }
  if (longestRunAfterAllow > args.maxRun) {
    violations.push("longest shared run " + longestRunAfterAllow + " chars exceeds " + args.maxRun);
  }
  if (blocklistHits.length > 0) {
    violations.push("original-author fingerprint blocklist hit (" + blocklistHits.length + " phrases)");
  }

  const report = {
    overlap_ratio: metrics.overlapRatio,
    matched_chars: metrics.matchedChars,
    candidate_chars: metrics.candidateChars,
    longest_run: metrics.longestRun,
    longest_run_after_allow: longestRunAfterAllow,
    exempt_runs: exempt.map((run) => ({ index: run.index, length: run.length, text: run.text })),
    thresholds: { min_gram: args.min, max_ratio: args.maxRatio, max_run: args.maxRun },
    runs: attributed,
    blocklist_hits: blocklistHits,
  };
  if (args.report) fs.writeFileSync(path.resolve(args.report), JSON.stringify(report, null, 2) + "\n");
  if (args.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");

  if (violations.length > 0) {
    console.log("HARD BLOCKER: copy-paste overlap with the original —");
    for (const violation of violations) console.log("- " + violation);
    for (const run of attributed.slice(0, 10)) {
      console.log("  paragraph " + run.paragraph + ": [" + run.length + " chars] " + run.text);
    }
    for (const hit of blocklistHits) {
      console.log("  fingerprint: " + hit.phrase + " (" + hit.count + "x) " + hit.note);
    }
    return 1;
  }
  console.log(
    "PASS: overlap ratio " + metrics.overlapRatio.toFixed(4) + " <= " + args.maxRatio +
    ", longest run " + metrics.longestRun + " (after allow exemption " + longestRunAfterAllow + ") <= " + args.maxRun +
    ", zero fingerprint hits (" + (autopsy?.fingerprint_blocklist || []).length + " checked)."
  );
  console.log("Reminder: this is a copy-paste guard only. Isomorphic reuse of examples/metaphors/gold-sentence cadence (同构复用) cannot be caught here and still requires the anti-AI auditor's transplant pass plus the user side-by-side review.");
  return 0;
}

const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  process.exit(main());
}
