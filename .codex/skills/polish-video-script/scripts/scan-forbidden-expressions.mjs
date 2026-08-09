#!/usr/bin/env node

// Literal/regex scan of a clean script against the hard-banned expression list.
// Exit code 1 on any hit, 0 when clean. Structural classes (parallelism,
// pseudo-interactive questions, cheap-uplift templates) cannot be caught here
// and still require manual review.

import fs from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..", "..", "..", "..");
const defaultListPath = resolve(repoRoot, "data", "style-distill", "writing-books", "hard-banned-expressions.json");

export function normalizeComparableText(text) {
  // Fullwidth ASCII-range punctuation -> halfwidth; ideographic space -> space; strip whitespace.
  return text
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, " ")
    .replace(/\s+/g, "");
}

export function scanForBannedExpressions(scriptText, expressions) {
  const normalizedScript = normalizeComparableText(scriptText);
  const hits = [];
  for (const expression of expressions) {
    const normalizedPattern = normalizeComparableText(expression.pattern);
    let count = 0;
    if (expression.kind === "literal") {
      let index = normalizedScript.indexOf(normalizedPattern);
      while (index !== -1) {
        count += 1;
        index = normalizedScript.indexOf(normalizedPattern, index + normalizedPattern.length);
      }
    } else if (expression.kind === "regex") {
      const regex = new RegExp(normalizedPattern, "gu");
      const matches = normalizedScript.match(regex);
      count = matches ? matches.length : 0;
    } else {
      throw new Error("unknown expression kind " + String(expression.kind) + " for " + String(expression.id));
    }
    if (count > 0) {
      hits.push({ id: expression.id, kind: expression.kind, pattern: expression.pattern, repair: expression.repair, count });
    }
  }
  return hits;
}

export function main(argv = process.argv) {
  const scriptIndex = argv.indexOf("--script");
  const listIndex = argv.indexOf("--list");
  const scriptPath = scriptIndex === -1 ? undefined : argv[scriptIndex + 1];
  const listPath = listIndex === -1 ? defaultListPath : resolve(argv[listIndex + 1]);
  if (!scriptPath) {
    console.error("Usage: node scan-forbidden-expressions.mjs --script <final.md> [--list <hard-banned-expressions.json>]");
    return 2;
  }

  let scriptText;
  let list;
  try {
    scriptText = fs.readFileSync(resolve(scriptPath), "utf8");
    list = JSON.parse(fs.readFileSync(listPath, "utf8"));
  } catch (error) {
    console.error("Unable to read script or banned-expression list: " + error.message);
    return 2;
  }

  const hits = scanForBannedExpressions(scriptText, list.expressions || []);
  if (hits.length > 0) {
    console.log("HARD BLOCKER: banned expressions found (" + hits.length + " kinds):");
    for (const hit of hits) {
      console.log("- [" + hit.count + "x] " + hit.id + " (" + hit.kind + ": " + hit.pattern + ")");
      console.log("  repair: " + hit.repair);
    }
    return 1;
  }
  console.log("PASS: zero banned expressions (" + (list.expressions || []).length + " checked, whitespace/fullwidth normalized).");
  console.log("Reminder: structural classes — parallelism, pseudo-interactive questions, cheap-uplift templates — need manual review.");
  return 0;
}

const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  process.exit(main());
}
