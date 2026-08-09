import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { normalizeComparableText, normalizedContains } from "../scripts/text-normalize.mjs";
import * as scanner from "../scripts/scan-wash-overlap.mjs";

const scannerPath = fileURLToPath(new URL("../scripts/scan-wash-overlap.mjs", import.meta.url));

const RAW = "韩信点兵，多多益善。刘邦问他能带多少兵，他说臣多多益善耳。帐下诸将无不叹服。";

function withTempDir(fn) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wash-scan-"));
  try {
    return fn(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function runScanner(args) {
  return spawnSync(process.execPath, [scannerPath, ...args], { encoding: "utf8" });
}

test("scanner and validator share ONE strong normalization (locked)", () => {
  // The scanner re-exports the shared module's function — the same reference, not a copy.
  assert.equal(scanner.normalizeComparableText, normalizeComparableText);
  // Locked behavior: NFKC + strip everything but Han/letters/digits + lowercase.
  assert.equal(normalizeComparableText("韩信点兵，多多益善！"), "韩信点兵多多益善");
  assert.equal(normalizeComparableText("Ｆｕｌｌ　Ｗｉｄｔｈ ABC 123"), "fullwidthabc123");
  assert.equal(normalizeComparableText("  空 格\t与\n换行  "), "空格与换行");
  assert.ok(normalizedContains("韩信点兵，多多益善。刘邦", "点兵，多多益善"));
  assert.ok(!normalizedContains("韩信点兵", "多多益善"));
  assert.ok(!normalizedContains("任何文本", "   "), "an empty needle never matches");
});

test("a clean script passes and a shallow wash fails", () => {
  withTempDir((dir) => {
    const raw = path.join(dir, "raw.txt");
    const clean = path.join(dir, "clean.md");
    const shallow = path.join(dir, "shallow.md");
    fs.writeFileSync(raw, RAW);
    fs.writeFileSync(clean, "卫青没有上奏。这件事改变了后来能发生什么。");
    fs.writeFileSync(shallow, "韩信点兵，多多益善。这句话后来被反复引用，成为衡量统帅的标准。");

    const pass = runScanner(["--script", clean, "--original", raw]);
    assert.equal(pass.status, 0, pass.stdout);
    assert.match(pass.stdout, /PASS/);

    const fail = runScanner(["--script", shallow, "--original", raw]);
    assert.equal(fail.status, 1);
    assert.match(fail.stdout, /HARD BLOCKER/);
  });
});

test("allow files exempt max_run but never the ratio (D7 narrow exemption)", () => {
  withTempDir((dir) => {
    // A 17-char shared run inside a long, otherwise-clean script: ratio stays under
    // 0.02, so only the max_run threshold decides — and the allow file must flip it.
    const quote = "韩信点兵多多益善刘邦大笑说多多益善";
    const raw = path.join(dir, "raw.txt");
    const script = path.join(dir, "script.md");
    const allow = path.join(dir, "allow.txt");
    fs.writeFileSync(raw, "原稿里有一段史记引语：韩信点兵，多多益善，刘邦大笑说多多益善。这是原稿的用法。");
    fs.writeFileSync(script, "全新开场。" + "史记原文写着：韩信点兵，多多益善，刘邦大笑说多多益善。" + "全新的主题展开与材料铺陈。".repeat(70));
    fs.writeFileSync(allow, "新主题素材：《史记·淮阴侯列传》——韩信点兵，多多益善，刘邦大笑说多多益善。");

    const metrics = scanner.computeWashMetrics(fs.readFileSync(script, "utf8"), fs.readFileSync(raw, "utf8"));
    assert.ok(metrics.longestRun > 14, "fixture must exceed the max_run threshold, got " + metrics.longestRun);
    assert.ok(metrics.overlapRatio <= 0.02, "fixture must stay under the ratio threshold, got " + metrics.overlapRatio);

    const withoutAllow = runScanner(["--script", script, "--original", raw]);
    assert.equal(withoutAllow.status, 1, "without --allow the long run blocks");

    const withAllow = runScanner(["--script", script, "--original", raw, "--allow", allow]);
    assert.equal(withAllow.status, 0, withAllow.stdout);

    // The exemption never touches the ratio: a short script whose ratio blows up fails
    // even with the allow file.
    const shortScript = path.join(dir, "short.md");
    fs.writeFileSync(shortScript, "韩信点兵，多多益善，刘邦大笑说多多益善。");
    const ratioFail = runScanner(["--script", shortScript, "--original", raw, "--allow", allow]);
    assert.equal(ratioFail.status, 1);
    assert.match(ratioFail.stdout, /overlap ratio/);
  });
});

test("a fingerprint blocklist hit blocks the scan", () => {
  withTempDir((dir) => {
    const raw = path.join(dir, "raw.txt");
    const script = path.join(dir, "script.md");
    const autopsy = path.join(dir, "autopsy.json");
    fs.writeFileSync(raw, RAW);
    fs.writeFileSync(script, "完全新写的内容，但不小心带了原作者的口头禅：兵仙两个字。");
    fs.writeFileSync(autopsy, JSON.stringify({ fingerprint_blocklist: [{ phrase: "兵仙两个字", note: "原作者标志落点" }] }));

    const result = runScanner(["--script", script, "--original", raw, "--autopsy", autopsy]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /fingerprint blocklist hit/);
  });
});

test("--report writes the machine-readable scan report", () => {
  withTempDir((dir) => {
    const raw = path.join(dir, "raw.txt");
    const script = path.join(dir, "script.md");
    const report = path.join(dir, "report.json");
    fs.writeFileSync(raw, RAW);
    fs.writeFileSync(script, "卫青没有上奏。这件事改变了后来能发生什么。");

    const result = runScanner(["--script", script, "--original", raw, "--json", "--report", report]);
    assert.equal(result.status, 0, result.stdout);
    const parsed = JSON.parse(fs.readFileSync(report, "utf8"));
    assert.equal(typeof parsed.overlap_ratio, "number");
    assert.equal(typeof parsed.longest_run, "number");
    assert.equal(typeof parsed.longest_run_after_allow, "number");
    assert.deepEqual(Object.keys(parsed.thresholds), ["min_gram", "max_ratio", "max_run"]);
    assert.ok(Array.isArray(parsed.runs));
    assert.ok(Array.isArray(parsed.blocklist_hits));
  });
});
