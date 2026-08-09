#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function sha256(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
}

function visibleLength(text) {
  return Array.from(String(text)).filter((char) => !/\s/u.test(char)).length;
}

function excerptAt(text, ratio, width = 26) {
  const chars = Array.from(String(text));
  if (chars.length === 0) return "";
  const center = Math.min(chars.length - 1, Math.max(0, Math.floor(ratio * chars.length)));
  const start = Math.max(0, center - Math.floor(width / 2));
  return chars.slice(start, Math.min(chars.length, start + width)).join("").trim();
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function requireRun(run) {
  const duration = run?.contract?.target_duration_seconds;
  if (!Number.isFinite(duration) || duration < 15) {
    throw new Error("contract.target_duration_seconds must be a number >= 15");
  }
  const stages = Array.isArray(run?.stage_map?.stages)
    ? [...run.stage_map.stages].sort((a, b) => a.order - b.order)
    : [];
  if (stages.length === 0 || stages.some((stage) => typeof stage.locked_text !== "string")) {
    throw new Error("every stage must contain locked_text before building the attention timeline");
  }
  const expectedText = stages.map((stage) => stage.locked_text).join("\n\n");
  if (run?.assembly?.text !== expectedText || run?.assembly?.content_hash !== sha256(expectedText)) {
    throw new Error("assembly must match the exact locked stage text before timing");
  }
  return { duration, stages, expectedText };
}

export function buildAttentionTimeline(run) {
  const { duration, stages, expectedText } = requireRun(run);
  const weights = stages.map((stage) => Math.max(1, visibleLength(stage.locked_text)));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  let elapsedWeight = 0;
  const stageSpans = stages.map((stage, index) => {
    const startSeconds = duration * elapsedWeight / totalWeight;
    elapsedWeight += weights[index];
    const endSeconds = duration * elapsedWeight / totalWeight;
    return {
      stage_id: stage.id,
      stage_name: stage.name,
      locked_hash: stage.locked_hash,
      start_seconds: round(startSeconds),
      end_seconds: round(endSeconds),
      timing_basis: "character_ratio_estimate"
    };
  });

  const checkpointSpecs = [
    { id: "2s", second: Math.min(2, duration) },
    { id: "5s", second: Math.min(5, duration) },
    { id: "15s", second: Math.min(15, duration) },
    { id: "30pct", second: duration * 0.3 },
    { id: "60pct", second: duration * 0.6 },
    { id: "ending", second: duration }
  ];

  const checkpoints = checkpointSpecs.map(({ id, second }) => {
    const spanIndex = second >= duration
      ? stageSpans.length - 1
      : Math.max(0, stageSpans.findIndex((span) => second <= span.end_seconds));
    const span = stageSpans[spanIndex];
    const stage = stages[spanIndex];
    const spanDuration = Math.max(0.001, span.end_seconds - span.start_seconds);
    const localRatio = Math.min(1, Math.max(0, (second - span.start_seconds) / spanDuration));
    return {
      id,
      second: round(second),
      stage_id: span.stage_id,
      exact_quote: excerptAt(stage.locked_text, localRatio)
    };
  });

  return {
    input_content_hash: sha256(expectedText),
    timing_basis: {
      kind: "character_ratio_estimate",
      target_duration_seconds: duration,
      limitation: "This estimates spoken position from character share; it is not observed audience retention."
    },
    stages: stageSpans,
    checkpoints
  };
}

function valueAfter(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const file = valueAfter(argv, "--file");
  const output = valueAfter(argv, "--output");
  if (!file) {
    console.error("Usage: build-attention-timeline.mjs --file <03-progressive-run.v2.json> [--output <timeline.json>]");
    process.exitCode = 2;
  } else {
    try {
      const run = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
      const timeline = `${JSON.stringify(buildAttentionTimeline(run), null, 2)}\n`;
      if (output) fs.writeFileSync(path.resolve(output), timeline, "utf8");
      else process.stdout.write(timeline);
    } catch (error) {
      console.error(`Unable to build attention timeline: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
