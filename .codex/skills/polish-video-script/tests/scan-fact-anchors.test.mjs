import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  scanFactAnchors,
  extractCandidates,
  isDerivedArithmetic,
  parseChineseNumber
} from "../scripts/scan-fact-anchors.mjs";

test("extracts years, dates, large numbers, quotes, and person-titles", () => {
  const text = "1924年，北京停发旗饷，共约50万两，怀塔布上疏说：「万万不可」。";
  const kinds = extractCandidates(text).map((c) => c.kind);
  assert.ok(kinds.includes("year"));
  assert.ok(kinds.includes("large-number"));
  assert.ok(kinds.includes("quote"));
});

test("a fact present verbatim in material is not flagged", () => {
  const script = "1924年，北京把最后一笔旗饷停了。";
  const material = "根据档案，1924年北京停发最后一笔旗饷。";
  assert.deepEqual(scanFactAnchors(script, material), []);
});

test("a fabricated quote absent from every material file is flagged unanchored", () => {
  const script = "他说：「这句话材料里根本没有」。";
  const material = "1924年停发旗饷。";
  const findings = scanFactAnchors(script, material);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].status, "unanchored");
});

test("a beat comment on the first line of a block does not hide the rest of that block", () => {
  // Regression: the scanner's original isScaffoldParagraph dropped the WHOLE block when it
  // started with a beat comment (real drafts write `<!-- A7 · F1 F2 -->\n<prose>` as one
  // block), silently exempting every annotated paragraph from the scan. A drifted year
  // (7362年, impossible in any real material) was not flagged until this was fixed to filter
  // scaffolding line-by-line, matching the fix already applied to scan-sentence-health.mjs.
  const script = "<!-- A7 · F1 F2 F4 F5 -->\n三天后，他在7362年做了这件事。";
  const material = "材料完全不含 7362。";
  const findings = scanFactAnchors(script, material);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].text, "7362年");
  assert.equal(findings[0].status, "unanchored");
});

test("derived arithmetic (both operands present) is flagged separately, not as unanchored", () => {
  // The writer is allowed to compute and state a delta the material never states verbatim, as
  // long as both operands it derived from ARE in the script (and presumably anchored to
  // material themselves — this test isolates just the arithmetic detection).
  const script = "官方登记四亿零一百万人，两百年前只有一万人。这一算，多了三亿九千九百九十九万。";
  assert.equal(parseChineseNumber("四亿零一百万人"), null); // Chinese-character numerals are out of scope
  // Use digit forms, which the extractor and parser both handle.
  const digitScript = "官方登记40100万人，两百年前只有100万人。这一算，多了40000万。";
  const material = "档案记载 40100万人 与 100万人 两个数字。";
  const findings = scanFactAnchors(digitScript, material);
  const delta = findings.find((f) => f.text === "40000万");
  assert.ok(delta, "the derived delta should appear in findings");
  assert.equal(delta.status, "derived_arithmetic");
});

test("an era-name token in the same paragraph downgrades an unanchored year to a flagged conversion", () => {
  const script = "建国十周年那年，他做了这件事，是1959年的事。";
  const material = "档案只提到建国十周年，没有提到具体西元年份。";
  const findings = scanFactAnchors(script, material);
  const year = findings.find((f) => f.text === "1959年");
  assert.ok(year);
  assert.equal(year.status, "possible_era_conversion");
});

test("markdown scaffolding outside prose is not scanned", () => {
  const script = "# 标题\n\n<!-- A1 -->\n\n真正的正文在1924年发生。";
  const material = "1924年真的发生了。";
  assert.deepEqual(scanFactAnchors(script, material), []);
});

test("collectMaterialText pools every .md file recursively", async () => {
  const { collectMaterialText } = await import("../scripts/scan-fact-anchors.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fact-anchors-test-"));
  fs.mkdirSync(path.join(dir, "01-raw-search"));
  fs.writeFileSync(path.join(dir, "02-fact-pool.md"), "pool内容 12345");
  fs.writeFileSync(path.join(dir, "01-raw-search", "agent-1.md"), "search内容 67890");
  fs.writeFileSync(path.join(dir, "not-markdown.txt"), "ignored 99999");
  const text = collectMaterialText([dir]);
  assert.match(text, /12345/);
  assert.match(text, /67890/);
  assert.doesNotMatch(text, /99999/);
});
