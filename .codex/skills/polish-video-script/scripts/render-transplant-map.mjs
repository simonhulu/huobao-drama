#!/usr/bin/env node

// Transplant map renderer (移植映射表渲染器).
//
// The transplant map (04-transplant-map.md) is the step 3 outline artifact (no pre-draft user gate)
// in transplant mode. Its LEFT columns are machine-rendered from the autopsy JSON and
// the run's beats[].transplant mapping — never hand-written — so what the user confirms
// is exactly what the machine checks. The agent fills only the RIGHT columns
// (替换：本段意思 / 首次披露事实 / 新贡献 / 接力 / 约字数).
//
// Usage:
//   node render-transplant-map.mjs --autopsy <00-autopsy.json> --run <production-run.json> --out <04-transplant-map.md>
//   node render-transplant-map.mjs --autopsy <00-autopsy.json> --run <production-run.json> --check <04-transplant-map.md>
//
// Render mode writes the map file. Check mode re-renders the left columns and diffs
// them against the existing file (main-table cells 段 / 原稿幕 / 继承 / 修补 plus the
// row count); any hand edit exits non-zero with a diff report. validate-production-run.mjs
// imports diffTransplantMapLeftColumns and hard-fails on any drift.
//
// Exit codes: 0 = rendered / check passed, 1 = left-column drift, 2 = usage/IO error.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAIN_TABLE_HEADER =
  "| 段 | 原稿幕 | 继承：功能/情绪/钩子机制 | 替换：本段意思 | 首次披露事实 | 新贡献 | 接力（问进→问出） | 修补 | 约字数 |";
const MAIN_TABLE_SEPARATOR = "| --- | --- | --- | --- | --- | --- | --- | --- | --- |";

function present(value) {
  return typeof value === "string" ? value.trim().length > 0 : Boolean(value);
}

// Left-column rows: one per beat, anchored to the autopsy acts through
// beats[].transplant.original_act_id. Inherited function/temperature/hook mechanism
// always render from the AUTOPSY act (the dissection truth), not from the beat's
// declaration — the beat-to-autopsy consistency is the validator's F4/F5 job.
export function leftColumnRows(autopsy, run) {
  const acts = Array.isArray(autopsy?.acts) ? autopsy.acts : [];
  const beats = Array.isArray(run?.beats) ? run.beats : [];
  const count = beats.length > 0 ? beats.length : acts.length;
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const beat = beats[i];
    const actId = present(beat?.transplant?.original_act_id)
      ? beat.transplant.original_act_id
      : acts[i]?.act_id || "?";
    const act = acts.find((candidate) => candidate?.act_id === actId) || acts[i] || {};
    const inherited = [act.function, act.temperature, act.hook_mechanism]
      .map((value) => (present(value) ? String(value).trim() : "?"))
      .join(" / ");
    const repair = present(beat?.transplant?.repair) ? beat.transplant.repair.trim() : "—";
    rows.push({ index: i + 1, actId, inherited, repair });
  }
  return rows;
}

function renderMainTable(rows) {
  const lines = [MAIN_TABLE_HEADER, MAIN_TABLE_SEPARATOR];
  for (const row of rows) {
    lines.push("| " + row.index + " | " + row.actId + " | " + row.inherited + " |  |  |  |  | " + row.repair + " |  |");
  }
  return lines.join("\n");
}

function renderRepairLedger(autopsy, run) {
  const beats = Array.isArray(run?.beats) ? run.beats : [];
  const injuries = Array.isArray(autopsy?.injuries) ? autopsy.injuries : [];
  const lines = ["| 幕 | 伤类 | 修补 |", "| --- | --- | --- |"];
  let count = 0;
  for (const beat of beats) {
    if (!present(beat?.transplant?.repair)) continue;
    count += 1;
    const actId = beat.transplant.original_act_id || "?";
    const injury = injuries.find((entry) => entry?.act_id === actId);
    lines.push("| " + actId + " | " + (injury?.injury_class || "—") + " | " + beat.transplant.repair.trim() + " |");
  }
  if (count === 0) lines.push("| — | — | 无修补声明 |");
  return lines.join("\n");
}

export function renderTransplantMap(autopsy, run) {
  const acts = Array.isArray(autopsy?.acts) ? autopsy.acts : [];
  const meta = autopsy?.original_meta || {};
  const rows = leftColumnRows(autopsy, run);
  const repairs = rows.filter((row) => row.repair !== "—").length;
  const total = acts.length || rows.length;
  const percent = total === 0 ? 0 : Math.round((repairs / total) * 100);
  return [
    "# 移植映射表",
    "",
    "- 原稿：" + (present(meta.source_ref) ? meta.source_ref : "<未登记>") +
      "（source_ownership: " + (present(meta.source_ownership) ? meta.source_ownership : "?") +
      (present(meta.outbreak_time) ? "；爆发时间：" + meta.outbreak_time : "") + "）",
    "- 解剖：00-autopsy.md / 00-autopsy.json（幕数：" + total + "）",
    "- 事实来源白名单声明：本稿全部事实来自新主题素材；原稿只贡献结构。",
    "- 修补总账：声明修补 " + repairs + " 处 / 共 " + total + " 幕 = " + percent + "%（上限 30% 且 ≤3 幕）",
    "- 左栏由 render-transplant-map.mjs 机械渲染，agent 只填右栏；手改左栏 = validator 硬失败。",
    "",
    "## 主表",
    "",
    renderMainTable(rows),
    "",
    "## 附表 1：修补账",
    "",
    renderRepairLedger(autopsy, run),
    "",
    "## 附表 2：洗深预声明",
    "",
    "- 本表每行目标：零句子复用、零例子复用、零比喻复用、零金句节奏复用。",
    "- 字面防线：scan-wash-overlap.mjs —— 防复制粘贴检查（阈值为其文件头注释的初始值，前 3 次 transplant 实战后校准）。",
    "- 语义防线：创作者终审并排审的 transplant 同构检查。扫描器绿 ≠ 洗深达标。",
    "- 开头的 skeleton_borrow 已在 opening_fidelity 记录中预声明。",
    "",
    "## 用户确认记录",
    "",
    "（门 #2 确认后在此追加：日期 + 用户原话。确认覆盖四件事：映射表、开头候选选定、适配论证、归因结论。）",
    "",
  ].join("\n");
}

function parseMainTableRows(text) {
  const rows = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = trimmed.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length !== 9) continue;
    if (!/^\d+$/.test(cells[0])) continue;
    rows.push({
      index: Number(cells[0]),
      actId: cells[1],
      inherited: cells[2],
      repair: cells[7],
    });
  }
  return rows;
}

export function diffTransplantMapLeftColumns(autopsy, run, existingText) {
  const expected = leftColumnRows(autopsy, run);
  const actual = parseMainTableRows(existingText);
  const diffs = [];
  if (actual.length !== expected.length) {
    diffs.push("row count " + actual.length + " != expected " + expected.length);
  }
  const shared = Math.min(actual.length, expected.length);
  for (let i = 0; i < shared; i += 1) {
    const a = actual[i];
    const e = expected[i];
    const label = "row " + e.index;
    if (a.index !== e.index) diffs.push(label + " cell 段: expected " + e.index + ", found " + a.index);
    if (a.actId !== e.actId) diffs.push(label + " cell 原稿幕: expected " + e.actId + ", found " + a.actId);
    if (a.inherited !== e.inherited) {
      diffs.push(label + " cell 继承: expected [" + e.inherited + "], found [" + a.inherited + "]");
    }
    if (a.repair !== e.repair) diffs.push(label + " cell 修补: expected [" + e.repair + "], found [" + a.repair + "]");
  }
  return diffs;
}

function parseArgs(argv) {
  const result = {};
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--autopsy") result.autopsy = value;
    else if (key === "--run") result.run = value;
    else if (key === "--out") result.out = value;
    else if (key === "--check") result.check = value;
    else throw new Error("unknown argument: " + key);
    i += 1;
  }
  if (!result.autopsy || !result.run || (!result.out && !result.check) || (result.out && result.check)) {
    throw new Error("--autopsy, --run, and exactly one of --out/--check are required");
  }
  return result;
}

export function main(argv = process.argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error("Usage: node render-transplant-map.mjs --autopsy <00-autopsy.json> --run <production-run.json> (--out <04-transplant-map.md> | --check <04-transplant-map.md>)");
    console.error(error.message);
    return 2;
  }

  let autopsy;
  let run;
  try {
    autopsy = JSON.parse(fs.readFileSync(path.resolve(args.autopsy), "utf8"));
    run = JSON.parse(fs.readFileSync(path.resolve(args.run), "utf8"));
  } catch (error) {
    console.error("Unable to read autopsy or production run: " + error.message);
    return 2;
  }

  if (args.out) {
    fs.writeFileSync(path.resolve(args.out), renderTransplantMap(autopsy, run));
    console.log("RENDERED transplant map -> " + args.out + " (" + leftColumnRows(autopsy, run).length + " rows; fill the right columns only)");
    return 0;
  }

  let existing;
  try {
    existing = fs.readFileSync(path.resolve(args.check), "utf8");
  } catch (error) {
    console.error("Unable to read the transplant map to check: " + error.message);
    return 2;
  }
  const diffs = diffTransplantMapLeftColumns(autopsy, run, existing);
  if (diffs.length > 0) {
    console.log("HARD BLOCKER: transplant map left columns were hand-edited —");
    for (const diff of diffs) console.log("- " + diff);
    return 1;
  }
  console.log("PASS: transplant map left columns match the autopsy + beats render (" + expectedRowCount(autopsy, run) + " rows).");
  return 0;
}

function expectedRowCount(autopsy, run) {
  return leftColumnRows(autopsy, run).length;
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
