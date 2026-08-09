#!/usr/bin/env node

// Fact-anchor scan: every number, date, name-like token, and quoted string in the finished
// script should be traceable to the material (02-fact-pool.md and/or 01-raw-search/*.md).
// This is the cheapest fact-layer control that does not reintroduce a verification pass —
// fact-checking was deliberately removed from this workflow at the owner's request ("we are
// not writing a paper"), but requirement 7 still forbids fabricated facts absolutely. This
// scanner catches a number that drifted or was invented; it does not verify that a correctly
// anchored number is true.
//
// WARN-ONLY. It never blocks persistence — the human runs it themselves and judges each
// finding, because two classes of correct writing look identical to a naive substring check:
//
//   1. Arithmetic the writer did in the narration ("四亿零一百万人...两百年前几千万" implies a
//      "多了三亿多" the writer is allowed to compute and state, even though "三亿" never
//      appears verbatim in any source file).
//   2. Era-name -> year conversion ("建国十周年" -> 1959) — the material may give the event
//      only in one form and the script may render it in the other.
//
// A tool that flagged either of these would be false-positiving on correct work, which is the
// exact failure this session already found once (scan-sentence-health.mjs's swallowed-verb
// rule flagging 「他中了毒」). This scanner is deliberately conservative: it allow-lists both
// patterns rather than trying to be clever about detecting "is this actually derived."
//
// Usage:
//   node scan-fact-anchors.mjs --script <final.md> --materials <dir>[,<dir>...] [--json]
//
//   --materials accepts one or more directories (comma-separated) whose *.md files (recursive)
//   are pooled as the anchor corpus. Pass the run's notes directory to cover 02-fact-pool.md,
//   01-raw-search/, and anything else placed there.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { normalizeComparableText, normalizedContains } from "./text-normalize.mjs";

// Candidate fingerprint patterns. Deliberately narrow: broad number matching (e.g. bare
// "\d+") would flag page-formatting artifacts and paragraph indices as unanchored facts.
const PATTERNS = [
  { kind: "year", regex: /(?:公元)?(?:前)?\d{3,4}年/g },
  { kind: "date", regex: /\d{1,2}月\d{1,2}[日号]/g },
  { kind: "large-number", regex: /\d+(?:\.\d+)?[万亿]/g },
  { kind: "count", regex: /\d{2,}(?:名|人|个|条|两|石|斗|里|里量|株|艘|门|杆)/g },
  { kind: "quote", regex: /[「"][^」"]{3,40}[」"]/g },
  { kind: "person-title", regex: /[一-龥]{2,4}(?:氏|王|帝|后|公|侯|尚书|知府|总督|巡抚|将军|大臣)/g }
];

// The person-title pattern's "后" suffix (为empress/后代 as in 太后/皇后) collides with the
// ordinary temporal word 后 (as in 三天后/随后/此后). Rather than dropping 后 from the pattern
// (it is genuinely needed for 太后/皇后/王后), common temporal phrases are excluded by name.
const COMMON_TEMPORAL_PHRASES = new Set([
  "之后", "以后", "此后", "随后", "先后", "前后", "最后", "日后", "尔后", "而后",
  "天后", "年后", "月后", "周后", "小时后", "分钟后"
]);

function isCommonTemporalFalsePositive(candidate) {
  if (candidate.kind !== "person-title") return false;
  if (!candidate.text.endsWith("后")) return false;
  return [...COMMON_TEMPORAL_PHRASES].some((phrase) => candidate.text.endsWith(phrase));
}

function splitParagraphs(scriptText) {
  return scriptText.replace(/\r\n/g, "\n").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
}

// Strip scaffolding LINE BY LINE, not block by block. Real drafts put a beat comment
// (`<!-- A7 · F1 F2 F4 F5 -->`) on the first line of the same block as its prose — judging the
// whole block by its first line drops every annotated paragraph's real content. This is the
// same defect class scan-sentence-health.mjs had (and fixed) earlier this session; the fix is
// identical: filter lines, then rejoin, then test whether anything prose-like survived.
function proseOf(paragraph) {
  return paragraph
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return false;
      if (trimmed.startsWith("#")) return false;
      if (trimmed.startsWith("<!--") || trimmed.startsWith("-->")) return false;
      if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) return false;
      if (trimmed.startsWith("|")) return false;
      if (/^-{3,}$/.test(trimmed)) return false;
      return true;
    })
    .join("\n")
    .trim();
}

function extractCandidates(text) {
  const candidates = [];
  for (const { kind, regex } of PATTERNS) {
    for (const match of text.matchAll(regex)) {
      const candidate = { kind, text: match[0] };
      if (isCommonTemporalFalsePositive(candidate)) continue;
      candidates.push(candidate);
    }
  }
  return candidates;
}

// Allow-list 1: two-operand arithmetic where both operands appear earlier in the script. A
// result the writer computed on-camera (430-240=190 spoken as "少了两百多万" style deltas) is
// not a fact needing an external anchor — the operands are the facts; the arithmetic is the
// writer's, and it is checked by ordinary math, not source-tracing.
function isDerivedArithmetic(candidate, allNumericTexts) {
  const value = parseChineseNumber(candidate.text);
  if (value === null) return false;
  for (const a of allNumericTexts) {
    const av = parseChineseNumber(a);
    if (av === null || av === value) continue;
    for (const b of allNumericTexts) {
      const bv = parseChineseNumber(b);
      if (bv === null) continue;
      if (Math.abs(av - bv - value) < 1e-6 || Math.abs(av + bv - value) < 1e-6) return true;
    }
  }
  return false;
}

function parseChineseNumber(text) {
  const match = /^(\d+(?:\.\d+)?)([万亿]?)/.exec(text);
  if (!match) return null;
  const base = Number(match[1]);
  if (Number.isNaN(base)) return null;
  const multiplier = match[2] === "万" ? 10000 : match[2] === "亿" ? 100000000 : 1;
  return base * multiplier;
}

// Allow-list 2: era-name resolution. A reign-era or anniversary label the material states may
// legitimately be rendered as a Gregorian year in the script (建国十周年 -> 1959) or vice
// versa. Detecting the conversion itself is out of scope (it requires a calendar table this
// scanner does not carry); instead, any candidate whose paragraph ALSO contains an era-style
// token is treated as a probable conversion rather than an unanchored fact, and is reported
// separately so a human can judge it rather than being silently swallowed.
const ERA_TOKEN = /(?:建国|光绪|同治|咸丰|道光|嘉庆|乾隆|康熙|顺治|洪武|建元)[^\s，。]{0,6}(?:年|周年)/;

function scanFactAnchors(scriptText, materialText) {
  const paragraphs = splitParagraphs(scriptText)
    .map((block) => proseOf(block))
    .filter((p) => p.length > 0);
  const allCandidatesFlat = paragraphs.flatMap((p) => extractCandidates(p).map((c) => c.text));

  const findings = [];
  for (const [index, paragraph] of paragraphs.entries()) {
    const candidates = extractCandidates(paragraph);
    for (const candidate of candidates) {
      if (normalizedContains(materialText, candidate.text)) continue;

      if (candidate.kind !== "quote" && isDerivedArithmetic(candidate, allCandidatesFlat)) {
        findings.push({ paragraph: index + 1, kind: candidate.kind, text: candidate.text, status: "derived_arithmetic" });
        continue;
      }
      if (ERA_TOKEN.test(paragraph)) {
        findings.push({ paragraph: index + 1, kind: candidate.kind, text: candidate.text, status: "possible_era_conversion" });
        continue;
      }
      findings.push({ paragraph: index + 1, kind: candidate.kind, text: candidate.text, status: "unanchored" });
    }
  }
  return findings;
}

function collectMaterialText(dirs) {
  const texts = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const stack = [dir];
    while (stack.length > 0) {
      const current = stack.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          texts.push(fs.readFileSync(full, "utf8"));
        }
      }
    }
  }
  return texts.join("\n");
}

function main() {
  const scriptIndex = process.argv.indexOf("--script");
  const materialsIndex = process.argv.indexOf("--materials");
  const scriptPath = scriptIndex === -1 ? undefined : process.argv[scriptIndex + 1];
  const materialsArg = materialsIndex === -1 ? undefined : process.argv[materialsIndex + 1];
  const asJson = process.argv.includes("--json");

  if (!scriptPath || !materialsArg) {
    process.stderr.write(
      "Usage: node scan-fact-anchors.mjs --script <final.md> --materials <dir>[,<dir>...] [--json]\n"
    );
    process.exitCode = 2;
    return;
  }

  let scriptText;
  try {
    scriptText = fs.readFileSync(path.resolve(scriptPath), "utf8");
  } catch (error) {
    process.stderr.write("Unable to read script: " + error.message + "\n");
    process.exitCode = 2;
    return;
  }

  const dirs = materialsArg.split(",").map((d) => path.resolve(d.trim()));
  const materialText = collectMaterialText(dirs);
  if (materialText.length === 0) {
    process.stderr.write("Warning: no .md material found under " + dirs.join(", ") + " — every candidate will read as unanchored.\n");
  }

  const findings = scanFactAnchors(scriptText, materialText);
  const unanchored = findings.filter((f) => f.status === "unanchored");
  const flagged = findings.filter((f) => f.status !== "unanchored");

  if (asJson) {
    process.stdout.write(JSON.stringify({ findings, unanchoredCount: unanchored.length }, null, 2) + "\n");
    return;
  }

  if (findings.length === 0) {
    process.stdout.write("PASS fact anchors (warn-only — this does not verify truth, only that every number/date/name/quote traces to material)\n");
    return;
  }

  if (unanchored.length > 0) {
    process.stdout.write("UNANCHORED (not found in any material file — check for drift or fabrication): " + unanchored.length + "\n");
    for (const f of unanchored) {
      process.stdout.write("  段落 " + f.paragraph + " | " + f.kind + " | " + f.text + "\n");
    }
  }
  if (flagged.length > 0) {
    process.stdout.write(
      (unanchored.length > 0 ? "\n" : "") +
        "FLAGGED (likely correct — writer-computed arithmetic or era/year conversion, human judges): " +
        flagged.length + "\n"
    );
    for (const f of flagged) {
      process.stdout.write("  段落 " + f.paragraph + " | " + f.kind + " | " + f.text + " | " + f.status + "\n");
    }
  }
  process.stdout.write(
    "\nThis scan never blocks persistence. It does not verify that an anchored fact is TRUE — " +
      "only that it traces to a material file. Judge each finding; this is not a pass/fail gate.\n"
  );
}

const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(path.resolve(process.argv[1])) ===
      fs.realpathSync(new URL(import.meta.url).pathname);
  } catch {
    return false;
  }
})();
if (invokedDirectly) main();

export { scanFactAnchors, extractCandidates, isDerivedArithmetic, parseChineseNumber, collectMaterialText };
