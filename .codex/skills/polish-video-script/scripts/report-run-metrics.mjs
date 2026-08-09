#!/usr/bin/env node

// Diagnostic report for one run directory: step timing (from audit-log.jsonl step_timing
// records) and fact-pool utilization (which pool facts actually reached the final script).
//
// This exists because every timing and utilization number quoted in this skill's design
// discussion so far was an mtime INFERENCE, not a measurement — and one of those inferences
// was wrong in a way that inverted a real conclusion: a run's agent-reviews/*.md files
// predated its 05-draft-v1.md and quoted lines absent from that file, meaning v1 was already a
// revised draft, not a first draft. Nothing here replaces reading the files; it just stops the
// skill from re-guessing the same numbers next time.
//
// This is a report, not a gate — it never sets a non-zero exit code on its own account.
//
// Usage:
//   node report-run-metrics.mjs --dir scripts/polish-notes/<article-id> [--script <final.md>] [--json]

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function readJsonlFindings(filePath, finding) {
  if (!fs.existsSync(filePath)) return [];
  const records = [];
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.finding === finding) records.push(entry);
  }
  return records;
}

function reportTiming(runDir) {
  const records = readJsonlFindings(path.join(runDir, "audit-log.jsonl"), "step_timing");
  if (records.length === 0) {
    return {
      records: [],
      note: "no step_timing records found — every step should append one; see SKILL.md " +
        "\"Step Timing\" for the format. Without this, any duration claim about this run is " +
        "an mtime guess."
    };
  }
  const totalSeconds = records.reduce((sum, r) => sum + (Number(r.seconds) || 0), 0);
  return { records, totalSeconds };
}

// Pull fact ids out of the pool file. Per references/fact-curation.md the format is `##
// <Act>` sections each restarting their own `### F1 [Score: 3] [Source: ...]` numbering — F1
// appears once per act, not once per file. A real pool measured this session had 59 `###`
// facts under 10 `##` act headers using exactly this restarting scheme; treating "F1" as a
// single global id collapsed 10 distinct facts into 1. Scope every id by its enclosing act
// header so ids stay unique.
function extractFactIds(poolText) {
  const ids = new Set();
  let currentAct = "(no act header)";
  for (const line of poolText.split(/\r?\n/)) {
    const actHeader = /^##\s+(.+)$/.exec(line);
    if (actHeader) {
      currentAct = actHeader[1].trim();
      continue;
    }
    const factHeader = /^###\s+([A-Za-z0-9-]*F\d+)\b/.exec(line);
    if (factHeader) {
      // Already globally-scoped ids (e.g. "A4-F6") are kept as-is; bare "F1" is qualified by
      // its act so it does not collide with another act's "F1".
      const id = factHeader[1];
      ids.add(id.includes("-") ? id : currentAct + "::" + id);
    }
  }
  return ids;
}

function reportUtilization(runDir, scriptPath) {
  const poolPath = path.join(runDir, "02-fact-pool.md");
  if (!fs.existsSync(poolPath)) {
    return {
      persisted: false,
      note: "02-fact-pool.md does not exist in this run directory. Density (owner requirement " +
        "3) has zero machine visibility without it — persist the pool even when the run is " +
        "small enough to feel unnecessary."
    };
  }
  const poolText = fs.readFileSync(poolPath, "utf8");
  const factIds = [...extractFactIds(poolText)];

  if (!scriptPath) {
    return {
      persisted: true,
      factCount: factIds.length,
      note: "pass --script <final.md> to measure how many pool facts actually reached the script"
    };
  }
  if (!fs.existsSync(scriptPath)) {
    return { persisted: true, factCount: factIds.length, error: "script file not found: " + scriptPath };
  }
  const scriptText = fs.readFileSync(scriptPath, "utf8");

  // Utilization is measured by numeric/proper-noun fingerprints from each fact's source line
  // reaching the script, mirroring the ad hoc check that first surfaced the 26% figure this
  // session. It is a proxy, not a citation graph — a fact can be used in paraphrase and still
  // register as unused here. Treat the number as directional.
  // Same act-scoping as extractFactIds: split on act headers first, then facts within each act,
  // so "F1" in Act 2 is not merged with "F1" in Act 1.
  const fingerprintsByFact = new Map();
  const actSections = poolText.split(/^##\s+/m).slice(1);
  for (const section of actSections) {
    const actName = (section.split("\n")[0] || "").trim();
    const factBlocks = section.split(/^###\s+/m).slice(1);
    for (const block of factBlocks) {
      const idMatch = /^([A-Za-z0-9-]*F\d+)/.exec(block);
      if (!idMatch) continue;
      const rawId = idMatch[1];
      const scopedId = rawId.includes("-") ? rawId : actName + "::" + rawId;
      const fingerprints = [...new Set(
        (block.match(/\d{3,4}年|\d{1,3}(?:\.\d+)?[万亿]|\d{2,}|[「"][^」"]{2,20}[」"]/g) || [])
      )];
      fingerprintsByFact.set(scopedId, fingerprints);
    }
  }

  let usedCount = 0;
  const unused = [];
  for (const [factId, fingerprints] of fingerprintsByFact) {
    const anyHit = fingerprints.some((fp) => scriptText.includes(fp));
    if (anyHit || fingerprints.length === 0) {
      usedCount += 1;
    } else {
      unused.push({ factId, fingerprints });
    }
  }

  return {
    persisted: true,
    factCount: factIds.length,
    measuredFacts: fingerprintsByFact.size,
    likelyUsed: usedCount,
    likelyUnused: unused.length,
    utilizationRatio: fingerprintsByFact.size > 0 ? usedCount / fingerprintsByFact.size : null,
    unusedSample: unused.slice(0, 10).map((u) => u.factId)
  };
}

function main() {
  const dirIndex = process.argv.indexOf("--dir");
  const runDir = dirIndex === -1 ? undefined : process.argv[dirIndex + 1];
  const scriptIndex = process.argv.indexOf("--script");
  const scriptPath = scriptIndex === -1 ? undefined : process.argv[scriptIndex + 1];
  const asJson = process.argv.includes("--json");

  if (!runDir) {
    process.stderr.write("Usage: node report-run-metrics.mjs --dir <run-dir> [--script <final.md>] [--json]\n");
    process.exitCode = 2;
    return;
  }

  const resolvedDir = path.resolve(runDir);
  if (!fs.existsSync(resolvedDir)) {
    process.stderr.write("Run directory not found: " + resolvedDir + "\n");
    process.exitCode = 2;
    return;
  }

  const timing = reportTiming(resolvedDir);
  const utilization = reportUtilization(resolvedDir, scriptPath ? path.resolve(scriptPath) : undefined);

  if (asJson) {
    process.stdout.write(JSON.stringify({ timing, utilization }, null, 2) + "\n");
    return;
  }

  process.stdout.write("=== Step timing: " + resolvedDir + " ===\n");
  if (timing.records.length === 0) {
    process.stdout.write(timing.note + "\n");
  } else {
    for (const r of timing.records) {
      process.stdout.write("  " + String(r.step).padEnd(24) + (r.seconds / 60).toFixed(1) + " min\n");
    }
    process.stdout.write("  TOTAL".padEnd(26) + (timing.totalSeconds / 60).toFixed(1) + " min\n");
  }

  process.stdout.write("\n=== Fact-pool utilization ===\n");
  if (!utilization.persisted) {
    process.stdout.write(utilization.note + "\n");
  } else if (utilization.utilizationRatio === undefined || utilization.utilizationRatio === null) {
    process.stdout.write(
      "pool has " + utilization.factCount + " facts. " + (utilization.note || "") + "\n"
    );
  } else {
    process.stdout.write(
      "pool: " + utilization.factCount + " facts, " + utilization.measuredFacts +
        " measurable | likely used: " + utilization.likelyUsed +
        " | likely unused: " + utilization.likelyUnused +
        " | ratio: " + (utilization.utilizationRatio * 100).toFixed(0) + "%\n"
    );
    if (utilization.unusedSample.length > 0) {
      process.stdout.write("  unused sample: " + utilization.unusedSample.join(", ") + "\n");
    }
    process.stdout.write(
      "  (fingerprint proxy, not a citation graph — paraphrased use of a fact will read as unused)\n"
    );
  }
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

export { reportTiming, reportUtilization, extractFactIds };
