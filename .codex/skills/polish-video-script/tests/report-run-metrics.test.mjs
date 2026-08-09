import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { reportTiming, reportUtilization, extractFactIds } from "../scripts/report-run-metrics.mjs";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "run-metrics-test-"));
}

test("extractFactIds reads pool-format and act-prefixed ids", () => {
  const pool = [
    "# Fact Pool",
    "",
    "## Opening (Act 1) — Score 3 Facts",
    "",
    "### F1 [Score: 3] [Source: x]",
    "一些内容",
    "",
    "### A4-F6 [Score: 2] [Source: y]",
    "另一些内容"
  ].join("\n");
  const ids = extractFactIds(pool);
  assert.equal(ids.size, 2);
  assert.ok([...ids].some((id) => id.endsWith("::F1")));
  assert.ok(ids.has("A4-F6"));
});

test("extractFactIds does not collapse the same bare id repeated across acts", () => {
  // Real pool files restart numbering per act: F1 exists once per act, not once per file.
  // A measured pool had 59 ### facts under 10 ## act headers on exactly this scheme — treating
  // bare F1 as globally unique would collapse 10 distinct facts into 1.
  const pool = [
    "## Act 1",
    "### F1 [Score: 3] [Source: x]",
    "第一幕的事实",
    "## Act 2",
    "### F1 [Score: 2] [Source: y]",
    "第二幕的事实，跟第一幕无关"
  ].join("\n");
  const ids = extractFactIds(pool);
  assert.equal(ids.size, 2);
});

test("reportTiming says plainly when no timing exists, rather than guessing", () => {
  const dir = tmpDir();
  const result = reportTiming(dir);
  assert.deepEqual(result.records, []);
  assert.match(result.note, /no step_timing records/);
});

test("reportTiming sums step_timing records from audit-log.jsonl", () => {
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, "audit-log.jsonl"),
    [
      JSON.stringify({ finding: "step_timing", step: "autopsy", seconds: 300 }),
      JSON.stringify({ finding: "step_timing", step: "search", seconds: 420 }),
      JSON.stringify({ finding: "book_review", paragraph_index: 1, verdict: "pass" })
    ].join("\n")
  );
  const result = reportTiming(dir);
  assert.equal(result.records.length, 2);
  assert.equal(result.totalSeconds, 720);
});

test("reportUtilization says plainly when the pool was never persisted", () => {
  const dir = tmpDir();
  const result = reportUtilization(dir);
  assert.equal(result.persisted, false);
  assert.match(result.note, /zero machine visibility/);
});

test("reportUtilization measures which fact fingerprints reached the script", () => {
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, "02-fact-pool.md"),
    [
      "## Act 1",
      "### F1 [Score: 3] [Source: x]",
      "1924年，北京把最后一笔旗饷停了。",
      "",
      "### F2 [Score: 2] [Source: y]",
      "启功自创「启」姓，退回信件标注「查无此人」。",
      "",
      "### F3 [Score: 1] [Source: z]",
      "1953年普查满族登记242万人。"
    ].join("\n")
  );
  const scriptPath = path.join(dir, "final.md");
  // Script uses F1's year and F2's quoted phrase, but not F3's number.
  fs.writeFileSync(scriptPath, "1924年那笔饷银停了。他退回信件，标注「查无此人」。");

  const result = reportUtilization(dir, scriptPath);
  assert.equal(result.persisted, true);
  assert.equal(result.factCount, 3);
  assert.equal(result.likelyUsed, 2);
  assert.equal(result.likelyUnused, 1);
  assert.equal(result.unusedSample.length, 1);
  assert.ok(result.unusedSample[0].endsWith("::F3"));
});

test("a fact with no extractable fingerprint counts as used rather than falsely flagged", () => {
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, "02-fact-pool.md"),
    ["## Act 1", "### F1 [Score: 1] [Source: x]", "旗人生活困难，缺乏具体数字。"].join("\n")
  );
  const scriptPath = path.join(dir, "final.md");
  fs.writeFileSync(scriptPath, "无关内容。");
  const result = reportUtilization(dir, scriptPath);
  assert.equal(result.likelyUsed, 1);
  assert.equal(result.likelyUnused, 0);
});
