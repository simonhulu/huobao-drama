#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { normalizeComparableText, normalizedContains } from "./text-normalize.mjs";
import { computeWashMetrics } from "./scan-wash-overlap.mjs";
import { diffTransplantMapLeftColumns } from "./render-transplant-map.mjs";

const QUESTION_TYPES = new Set([
  "motive",
  "mechanism",
  "chronology",
  "investigation",
  "judgment"
]);

const ANSWER_STATUSES = new Set([
  "source_supported",
  "bounded_inference",
  "unresolved"
]);

const DETAIL_MODES = new Set([
  "slow_scene",
  "compressed_fact",
  "factual_bridge"
]);

const DISCLOSURE_KINDS = new Set(["first", "recall"]);
const REASONING_MODULES = new Set(["bohai", "banfo", "wenboling"]);
const HUMAN_SWITCHES = new Set([
  "确定性渴求",
  "优越感满足",
  "刺激寻求",
  "共鸣确认",
  "归属驱动",
  "情绪宣泄",
  "懒惰本能",
  "贪婪欲望",
  "好奇心",
  "真实渴望"
]);
const PERSONA_ID = "rural-middle-storyteller-v1";
const PERSONA_TEMPERATURES = new Set(["cold", "warm", "hot"]);
const STANCE_RELATIONS = new Set([
  "reveal",
  "prove",
  "restore_context",
  "name_cost",
  "rebut",
  "settle"
]);
const OPENING_MODES = new Set([
  "result_then_rewind",
  "scene_return",
  "direct_cause",
  "collision"
]);
const OPENING_ACTION_STATUSES = new Set([
  "result_shown",
  "action_interrupted",
  "no_action"
]);
const RELAY_RESOLUTIONS = new Set(["answer", "carry"]);
// Terminal sentinel for the reader-question chain: the last beat closes the loop instead of
// opening another question. See references/reader-relay.md.
const RESOLVED_QUESTION_ID = "RESOLVED";
const COMMENT_TYPES = new Set(["resonance", "confrontation", "expression", "relation"]);
const COMMENT_STRATEGIES = new Set(["resonance", "confrontation", "expression", "relation", "none"]);
const REWRITE_ACTIONS = new Set(["full-reproduce", "partial", "pass"]);

// Opening density gate: first sentence must NOT match these patterns.
// Matches any of these → hard error (the opening is预告腔/场景铺垫/伪互动).
const FORBIDDEN_OPENING_PATTERNS = [
  { regex: /^我们要/,              reason: "预告腔: '我们要破解/探讨/聊聊...'" },
  { regex: /^今天我们来/,          reason: "预告腔: '今天我们来讲...'" },
  { regex: /^先看/,                reason: "预告腔: '先看一组数字...'" },
  { regex: /^\d{4}年.{1,12}一个/, reason: "场景铺垫+模糊主体: '1912年，北京。一个旗人家庭...'" },
  { regex: /^有个.*问题/,          reason: "伪互动设问: '有个问题你肯定想过...'" },
  { regex: /^你.*想过/,            reason: "认知绑架设问: '你有没有想过...'" },
  { regex: /^很多人不知道/,        reason: "伪稀缺宣告: '很多人不知道...'" },
  { regex: /^你有没有/,            reason: "代入绑架设问: '你有没有一种感觉...'" },
  { regex: /^是不是有时候/,        reason: "伪互动设问变体" },
  { regex: /^这个故事/,            reason: "元叙事: '这个故事要从...'" },
];

// NOTE: The old opening "density markers" table (hardcoded concrete_number / proper_noun /
// action_verb / opposition regexes) was REMOVED. It judged "information density" by whether
// the first sentence contained ≥2 characters from a fixed word list — so a genuinely vivid
// opening like 「辛亥年腊月初五，奉天城的一栋满人老爷的大宅子被兵围个水泄不通」 was
// rejected because 「围」 was not in the verb list. "Does the opening have a picture, a
// conflict, a concrete anchor" is a human judgment, not a regex match. What remains enforced
// is: (1) the opening is not 预告腔/伪互动/空话 (FORBIDDEN_OPENING_PATTERNS, checked on the
// final script), and (2) `conflict_quote` appears in the opening's first sentence.

function present(value) {
  return typeof value === "string" ? value.trim().length > 0 : Boolean(value);
}

function requireString(errors, value, label) {
  if (!present(value)) errors.push(label + " is required");
}

function requireArray(errors, value, label, { min = 1 } = {}) {
  if (!Array.isArray(value) || value.length < min) {
    errors.push(label + " must contain at least " + min + " item" + (min === 1 ? "" : "s"));
    return false;
  }
  return true;
}

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

function requireKnownFactIds(errors, ids, factIds, label) {
  if (!Array.isArray(ids)) return;
  for (const id of ids) {
    if (!factIds.has(id)) errors.push(label + " references undeclared source claim " + String(id));
  }
}

function validateAudienceContract(errors, contract, genre) {
  if (!contract || typeof contract !== "object") {
    errors.push("audience_contract is required");
    return;
  }

  const primary = contract.primary_human_switches;
  if (!Array.isArray(primary) || primary.length < 1 || primary.length > 2) {
    errors.push("audience_contract.primary_human_switches must contain one or two switches");
  } else {
    for (const trigger of primary) {
      if (!HUMAN_SWITCHES.has(trigger)) {
        errors.push("audience_contract.primary_human_switches contains unknown switch " + String(trigger));
      }
    }
  }

  if (contract.secondary_human_switches !== undefined) {
    if (!Array.isArray(contract.secondary_human_switches)) {
      errors.push("audience_contract.secondary_human_switches must be an array");
    } else {
      for (const trigger of contract.secondary_human_switches) {
        if (!HUMAN_SWITCHES.has(trigger)) {
          errors.push("audience_contract.secondary_human_switches contains unknown switch " + String(trigger));
        }
      }
    }
  }

  requireString(errors, contract.story_paradox, "audience_contract.story_paradox");
  requireString(errors, contract.viewer_pursuit, "audience_contract.viewer_pursuit");
  requireString(errors, contract.payoff_experience, "audience_contract.payoff_experience");
  if (!["guard", "engine"].includes(contract.source_boundary_role)) {
    errors.push("audience_contract.source_boundary_role must be guard or engine");
  }
  if (contract.source_boundary_role === "engine" && genre?.primary !== "investigation") {
    errors.push("only an investigation genre may use a source boundary as its story engine");
  }

  const commentTrigger = contract.comment_trigger;
  if (commentTrigger !== undefined) {
    if (typeof commentTrigger.enabled !== "boolean") {
      errors.push("audience_contract.comment_trigger.enabled must be a boolean");
    } else if (commentTrigger.enabled) {
      if (!COMMENT_TYPES.has(commentTrigger.type)) {
        errors.push("audience_contract.comment_trigger.type must be resonance, confrontation, expression, or relation");
      }
      requireString(errors, commentTrigger.expected_comment, "audience_contract.comment_trigger.expected_comment");
      requireString(errors, commentTrigger.target_beat, "audience_contract.comment_trigger.target_beat");
    }
  }
}

function validateInformationGapContract(errors, contract, metrics) {
  if (!contract || typeof contract !== "object") {
    errors.push("information_gap_contract is required");
    return;
  }

  if (requireArray(errors, contract.creator_owned, "information_gap_contract.creator_owned")) {
    for (const [index, gap] of contract.creator_owned.entries()) {
      const label = "information_gap_contract.creator_owned[" + index + "]";
      requireString(errors, gap?.beat_opened, label + ".beat_opened");
      requireString(errors, gap?.withheld_answer, label + ".withheld_answer");
      requireString(errors, gap?.payoff_beat, label + ".payoff_beat");
    }
  }

  if (!Array.isArray(contract.viewer_owned)) {
    errors.push("information_gap_contract.viewer_owned must be an array");
  } else {
    if (contract.viewer_owned.length > 2) {
      errors.push("information_gap_contract.viewer_owned may contain at most two gaps");
    }
    for (const [index, gap] of contract.viewer_owned.entries()) {
      const label = "information_gap_contract.viewer_owned[" + index + "]";
      requireString(errors, gap?.beat_id, label + ".beat_id");
      requireString(errors, gap?.concrete_material_given, label + ".concrete_material_given");
      requireString(errors, gap?.answer_left_to_viewer, label + ".answer_left_to_viewer");
      requireString(errors, gap?.expected_response, label + ".expected_response");
    }
  }

  if (requireArray(errors, contract.intentional_omissions, "information_gap_contract.intentional_omissions")) {
    for (const [index, omission] of contract.intentional_omissions.entries()) {
      const label = "information_gap_contract.intentional_omissions[" + index + "]";
      requireString(errors, omission?.omitted, label + ".omitted");
      requireString(errors, omission?.reason, label + ".reason");
    }
  }

  const budget = contract.closure_budget;
  for (const key of ["paragraph_summaries", "explanatory_tails", "final_answers"]) {
    if (!Number.isInteger(budget?.[key]) || budget[key] < 0) {
      errors.push("information_gap_contract.closure_budget." + key + " must be a non-negative integer");
    }
  }
  if (Number.isInteger(budget?.final_answers) && budget.final_answers !== 1) {
    errors.push("information_gap_contract.closure_budget.final_answers must be 1");
  }

  if (metrics?.target_comment_rate !== undefined && metrics.target_comment_rate > 0) {
    if (!Array.isArray(contract.viewer_owned) || contract.viewer_owned.length === 0) {
      errors.push("comment optimization requires at least one viewer-owned information gap");
    }
  }
}

function validateNarratorPersona(errors, persona, factIds) {
  if (!persona || typeof persona !== "object") {
    errors.push("narrator_persona is required");
    return;
  }
  if (persona.id !== PERSONA_ID) {
    errors.push("narrator_persona.id must be " + PERSONA_ID);
  }
  requireString(errors, persona.stance, "narrator_persona.stance");
  if (present(persona.stance) && !persona.stance.trim().startsWith("我认定")) {
    errors.push("narrator_persona.stance must begin with 我认定");
  }
  requireArray(errors, persona.stance_fact_ids, "narrator_persona.stance_fact_ids");
  requireKnownFactIds(errors, persona.stance_fact_ids, factIds, "narrator_persona.stance_fact_ids");
  requireString(errors, persona.stance_reveal_beat, "narrator_persona.stance_reveal_beat");
  requireString(errors, persona.false_moral_frame, "narrator_persona.false_moral_frame");
  requireString(errors, persona.rebuttal, "narrator_persona.rebuttal");
  requireString(errors, persona.moral_geometry?.anger_target, "narrator_persona.moral_geometry.anger_target");
  requireString(errors, persona.moral_geometry?.compassion_target, "narrator_persona.moral_geometry.compassion_target");
  requireString(errors, persona.moral_geometry?.silent_party, "narrator_persona.moral_geometry.silent_party");
  requireString(errors, persona.situation_restore?.information_gap, "narrator_persona.situation_restore.information_gap");
  requireString(errors, persona.situation_restore?.time_pressure, "narrator_persona.situation_restore.time_pressure");
  requireString(errors, persona.situation_restore?.cost_of_refusal, "narrator_persona.situation_restore.cost_of_refusal");
  requireString(errors, persona.situation_restore?.environmental_pull, "narrator_persona.situation_restore.environmental_pull");

  if (!Array.isArray(persona.temperature_arc) || persona.temperature_arc.length < 3) {
    errors.push("narrator_persona.temperature_arc must contain cold, warm, and hot beats");
    return;
  }
  const temperatures = new Set();
  for (const [index, stage] of persona.temperature_arc.entries()) {
    const label = "narrator_persona.temperature_arc[" + index + "]";
    requireString(errors, stage?.beat, label + ".beat");
    if (!PERSONA_TEMPERATURES.has(stage?.temperature)) {
      errors.push(label + ".temperature must be cold, warm, or hot");
    } else {
      temperatures.add(stage.temperature);
    }
    requireString(errors, stage?.job, label + ".job");
  }
  for (const temperature of PERSONA_TEMPERATURES) {
    if (!temperatures.has(temperature)) {
      errors.push("narrator_persona.temperature_arc must include " + temperature);
    }
  }
}

function validatePersonaAgainstBeats(errors, persona, beats, beatIds) {
  if (!persona || !Array.isArray(beats) || beats.length === 0) return;
  const revealIndex = beats.findIndex((beat) => beat?.id === persona.stance_reveal_beat);
  if (!beatIds.has(persona.stance_reveal_beat)) {
    errors.push("narrator_persona.stance_reveal_beat must name a beat");
  } else {
    const lastAllowedIndex = Math.ceil(beats.length / 3) - 1;
    if (revealIndex > lastAllowedIndex) {
      errors.push("narrator_persona.stance_reveal_beat must be in the first third of beats");
    }
    if (beats[revealIndex]?.stance_relation !== "reveal") {
      errors.push("narrator_persona.stance_reveal_beat must have stance_relation reveal");
    }
  }

  const temperatureIndexes = new Map();
  for (const [index, beat] of beats.entries()) {
    if (!temperatureIndexes.has(beat?.persona_temperature)) {
      temperatureIndexes.set(beat?.persona_temperature, index);
    }
  }
  for (const temperature of PERSONA_TEMPERATURES) {
    if (!temperatureIndexes.has(temperature)) {
      errors.push("beats must include narrator persona temperature " + temperature);
    }
  }
  const warmIndex = temperatureIndexes.get("warm");
  if (revealIndex >= 0 && warmIndex !== undefined && warmIndex < revealIndex) {
    errors.push("warm persona beat must not precede the stance reveal");
  }

  for (const stage of persona.temperature_arc || []) {
    const beat = beats.find((candidate) => candidate?.id === stage?.beat);
    if (!beat) continue;
    if (beat.persona_temperature !== stage.temperature) {
      errors.push("narrator_persona.temperature_arc beat " + stage.beat + " must match its beat persona_temperature");
    }
  }
}

function validateSourceClaims(errors, claims) {
  if (!requireArray(errors, claims, "truth_promise.source_claims")) return new Set();

  const ids = [];
  for (const claim of claims) {
    requireString(errors, claim?.id, "source claim id");
    requireString(errors, claim?.fact, "source claim " + (claim?.id || "<missing>") + ".fact");
    requireString(errors, claim?.source, "source claim " + (claim?.id || "<missing>") + ".source");
    if (present(claim?.id)) ids.push(claim.id);
  }

  for (const id of duplicateValues(ids)) {
    errors.push("truth_promise.source_claims repeats id " + id);
  }
  return new Set(ids);
}

function validateDetailMap(errors, detailMap, factIds) {
  if (!detailMap || typeof detailMap !== "object") {
    errors.push("truth_promise.detail_map is required");
    return { slowSceneIds: new Set() };
  }

  const slowScenes = detailMap.slow_scenes;
  if (!Array.isArray(slowScenes) || slowScenes.length < 2 || slowScenes.length > 4) {
    errors.push("truth_promise.detail_map.slow_scenes must contain 2 to 4 decisive scenes");
  }

  const slowSceneIds = [];
  for (const scene of slowScenes || []) {
    requireString(errors, scene?.id, "slow scene id");
    requireString(errors, scene?.decision_or_revelation, "slow scene " + (scene?.id || "<missing>") + ".decision_or_revelation");
    if (!Number.isInteger(scene?.target_chars) || scene.target_chars < 100 || scene.target_chars > 320) {
      errors.push("slow scene " + (scene?.id || "<missing>") + ".target_chars must be an integer from 100 to 320");
    }
    if (!Array.isArray(scene?.scene_carriers) || scene.scene_carriers.length < 2) {
      errors.push("slow scene " + (scene?.id || "<missing>") + ".scene_carriers must name at least two lived scene carriers");
    }
    if (present(scene?.id)) slowSceneIds.push(scene.id);
  }
  for (const id of duplicateValues(slowSceneIds)) {
    errors.push("truth_promise.detail_map.slow_scenes repeats id " + id);
  }

  // Compression is a selection tool, not a quota. A tight causal story may correctly discard
  // every non-core fact rather than carry a decorative biography bridge.
  if (!Array.isArray(detailMap.compressed_fact_ids)) {
    errors.push("truth_promise.detail_map.compressed_fact_ids must be an array");
  } else {
    requireKnownFactIds(errors, detailMap.compressed_fact_ids, factIds, "truth_promise.detail_map.compressed_fact_ids");
  }
  requireArray(errors, detailMap.discard_list, "truth_promise.detail_map.discard_list");

  return { slowSceneIds: new Set(slowSceneIds) };
}

function validateOpeningReaderContract(errors, retention) {
  const opening = retention?.opening;
  if (!opening || typeof opening !== "object") return;

  requireString(errors, retention?.open_loop_id, "retention.open_loop_id");
  requireString(errors, opening.opening_mode, "retention.opening.opening_mode");
  if (present(opening.opening_mode) && !OPENING_MODES.has(opening.opening_mode)) {
    errors.push("retention.opening.opening_mode is invalid");
  }
  requireString(errors, opening.action_status, "retention.opening.action_status");
  if (present(opening.action_status) && !OPENING_ACTION_STATUSES.has(opening.action_status)) {
    errors.push("retention.opening.action_status is invalid");
  }
  requireArray(errors, opening.reader_must_know, "retention.opening.reader_must_know", { min: 3 });
  requireString(errors, opening.bridge_to_next_beat, "retention.opening.bridge_to_next_beat");

  if (opening.action_status === "action_interrupted") {
    const orientation = opening.reader_must_know || [];
    if (orientation.length < 3) {
      errors.push("interrupted opening must orient the listener before it withholds the action result");
    }
  }

  const conflictCheck = opening.opening_conflict_check;
  if (conflictCheck !== undefined) {
    if (typeof conflictCheck.conflict_present !== "boolean") {
      errors.push("retention.opening.opening_conflict_check.conflict_present must be a boolean");
    }
    if (conflictCheck.conflict_present) {
      requireString(errors, conflictCheck.conflict_quote, "retention.opening.opening_conflict_check.conflict_quote");
      // Mechanism check: conflict_quote must appear in the opening's first sentence.
      // There is NO hard character-count ceiling — the requirement is that the opening
      // immediately establish a conflict/picture/suspense, not that it fit a fixed window.
      // (The old "within the first 15 spoken characters" rule produced compressed,
      // summary-like openings and was removed. Forbidden-pattern and density gates below
      // still enforce the conflict mechanism on the final script.)
      if (present(conflictCheck.conflict_quote) && present(opening.first_image_or_action)) {
        const sentence = opening.first_image_or_action;
        const idx = sentence.indexOf(conflictCheck.conflict_quote);
        if (idx === -1) {
          errors.push(
            "retention.opening.opening_conflict_check.conflict_quote must be a substring of first_image_or_action"
          );
        }
      }
    }
  }
}

// The relay's substance is the question chain: what the listener is asking coming in, whether
// this beat answers it or carries it, and what they are asking going out. The *ids* are pure
// bookkeeping — `carry` reuses the incoming id, `answer` opens the next one — so they are
// derived here rather than hand-aligned across every beat. Hand-written ids meant N manual
// "this beat's question_in_id must equal the previous beat's question_out_id" edits per run
// (57 on a long script), and every typo cost a full validate/repair cycle while proving
// nothing about the script. Ids may still be supplied; when they are, they must agree with
// the derived chain.
function validateReaderRelay(errors, relay, label, factIds, previousQuestionOutId, openLoopId, questionCounter) {
  if (!relay || typeof relay !== "object") {
    errors.push(label + ".reader_relay is required");
    return { questionOutId: previousQuestionOutId, counter: questionCounter };
  }

  requireString(errors, relay.question_in, label + ".reader_relay.question_in");
  requireString(errors, relay.question_out, label + ".reader_relay.question_out");
  if (!RELAY_RESOLUTIONS.has(relay.resolution)) {
    errors.push(label + ".reader_relay.resolution must be answer or carry");
  }
  if (relay.fact_ids_disclosed_here !== undefined) {
    if (!Array.isArray(relay.fact_ids_disclosed_here)) {
      errors.push(label + ".reader_relay.fact_ids_disclosed_here must be an array");
    } else {
      requireKnownFactIds(errors, relay.fact_ids_disclosed_here, factIds, label + ".reader_relay.fact_ids_disclosed_here");
    }
  }

  // Derive the chain. The first beat inherits the open loop's id; afterwards a carry keeps the
  // incoming id and an answer mints the next one.
  const derivedIn = previousQuestionOutId || openLoopId || "Q1";
  let counter = questionCounter;
  let derivedOut = derivedIn;
  if (relay.resolution === "answer") {
    counter += 1;
    derivedOut = "Q" + counter;
  }

  // `RESOLVED` is the terminal sentinel: the final beat closes the chain rather than opening
  // another question. It is a declaration the derivation cannot infer, so it is honoured.
  if (relay.question_out_id === RESOLVED_QUESTION_ID) {
    derivedOut = RESOLVED_QUESTION_ID;
  }

  // A supplied id is treated as an assertion about the chain and checked, not trusted.
  if (present(relay.question_in_id) && relay.question_in_id !== derivedIn) {
    errors.push(
      label + ".reader_relay.question_in_id " + JSON.stringify(relay.question_in_id) +
        " does not continue the previous reader question (" + JSON.stringify(derivedIn) +
        ") — omit the ids and let the chain derive them"
    );
  }
  if (
    present(relay.question_out_id) &&
    relay.question_out_id !== derivedOut &&
    relay.question_out_id !== RESOLVED_QUESTION_ID
  ) {
    errors.push(
      label + ".reader_relay.question_out_id " + JSON.stringify(relay.question_out_id) +
        " disagrees with the derived chain (" + JSON.stringify(derivedOut) +
        ") — a carry keeps the incoming id, an answer opens the next"
    );
  }

  // The substantive check survives: an "answer" that leaves the listener asking the very same
  // question did not actually answer anything.
  if (relay.resolution === "answer" && present(relay.question_in) && relay.question_in === relay.question_out) {
    errors.push(label + ".reader_relay answer must open a new question or mark the chain RESOLVED");
  }

  return { questionOutId: derivedOut, counter };
}

function splitScriptParagraphs(scriptText) {
  return scriptText
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

function firstDisclosureIndexes(beats) {
  const indexes = new Map();
  for (const [index, beat] of beats.entries()) {
    if (beat?.disclosure?.kind !== "first") continue;
    for (const factId of beat.disclosure.fact_ids || []) {
      if (!indexes.has(factId)) indexes.set(factId, index);
    }
  }
  return indexes;
}

export function validateFinalScript(run, scriptText, paragraphLocks) {
  const errors = [];
  const beats = Array.isArray(run?.beats) ? run.beats : [];
  const paragraphs = splitScriptParagraphs(scriptText || "");
  if (paragraphs.length !== beats.length) {
    errors.push("final script paragraph count must equal the beat count");
  }

  const openingParagraph = paragraphs[0] || "";

  // Forbidden opening patterns: first sentence must not match预告腔/场景铺垫/伪互动.
  for (const { regex, reason } of FORBIDDEN_OPENING_PATTERNS) {
    if (regex.test(openingParagraph)) {
      errors.push("final opening matches forbidden pattern: " + reason);
    }
  }

  const requiredPatterns = run?.retention?.opening?.script_required_patterns;
  if (!Array.isArray(requiredPatterns) || requiredPatterns.length === 0) {
    errors.push("retention.opening.script_required_patterns is required for final-script validation");
  } else {
    for (const pattern of requiredPatterns) {
      try {
        if (!(new RegExp(pattern, "u").test(openingParagraph))) {
          errors.push("final opening must match required pattern " + pattern);
        }
      } catch {
        errors.push("retention.opening.script_required_patterns contains invalid regex " + pattern);
      }
    }
  }

  if (!Array.isArray(paragraphLocks)) {
    errors.push("paragraph locks must be a JSONL array");
    return errors;
  }
  if (paragraphLocks.length !== paragraphs.length) {
    errors.push("paragraph lock count must equal final script paragraph count");
  }

  const disclosureIndexes = firstDisclosureIndexes(beats);
  for (const [index, lock] of paragraphLocks.entries()) {
    const paragraph = paragraphs[index] || "";
    const beat = beats[index];
    const label = "paragraph lock " + (index + 1);
    if (!Number.isInteger(lock?.paragraph_index) || lock.paragraph_index !== index + 1) {
      errors.push(label + ".paragraph_index must match its paragraph");
    }
    if (lock?.beat_id !== beat?.id) errors.push(label + ".beat_id must match the corresponding beat");
    if (lock?.question_in_id !== beat?.reader_relay?.question_in_id) {
      errors.push(label + ".question_in_id must match the beat reader relay");
    }
    if (lock?.question_out_id !== beat?.reader_relay?.question_out_id) {
      errors.push(label + ".question_out_id must match the beat reader relay");
    }
    requireString(errors, lock?.listener_knows, label + ".listener_knows");
    requireString(errors, lock?.listener_asks, label + ".listener_asks");
    requireString(errors, lock?.new_contribution, label + ".new_contribution");
    requireString(errors, lock?.first_sentence, label + ".first_sentence");
    if (present(lock?.first_sentence) && !paragraph.startsWith(lock.first_sentence)) {
      errors.push(label + ".first_sentence must begin the final paragraph");
    }
    if (!Array.isArray(lock?.fact_ids_used)) {
      errors.push(label + ".fact_ids_used must be an array");
    } else {
      const knownFactIds = new Set(
        [...disclosureIndexes.entries()]
          .filter(([, firstIndex]) => firstIndex <= index)
          .map(([factId]) => factId)
      );
      requireKnownFactIds(errors, lock.fact_ids_used, new Set(disclosureIndexes.keys()), label + ".fact_ids_used");
      for (const factId of lock.fact_ids_used) {
        if (!knownFactIds.has(factId)) {
          errors.push(label + ".fact_ids_used cites " + factId + " before its first disclosure");
        }
      }
      for (const factId of beat?.fact_ids || []) {
        if (!lock.fact_ids_used.includes(factId)) {
          errors.push(label + ".fact_ids_used must include beat fact " + factId);
        }
      }
    }
    if (index < paragraphs.length - 1) {
      requireString(errors, lock?.bridge_quote, label + ".bridge_quote");
      if (present(lock?.bridge_quote) && !paragraph.includes(lock.bridge_quote)) {
        errors.push(label + ".bridge_quote must appear in the final paragraph");
      }
    }
  }

  for (const claim of run?.truth_promise?.source_claims || []) {
    const firstIndex = disclosureIndexes.get(claim?.id);
    for (const alias of claim?.entity_aliases || []) {
      if (!present(alias) || firstIndex === undefined) continue;
      for (let paragraphIndex = 0; paragraphIndex < Math.min(paragraphs.length, firstIndex); paragraphIndex += 1) {
        // A bridge may name the next beat's person once without treating that person as already
        // introduced. The paragraph body may not otherwise rely on the future entity.
        const bridgeQuote = paragraphLocks[paragraphIndex]?.bridge_quote || "";
        const bodyWithoutBridge = paragraphs[paragraphIndex].replace(bridgeQuote, "");
        if (bodyWithoutBridge.includes(alias)) {
          errors.push(
            "final paragraph " + (paragraphIndex + 1) + " names " + alias +
              " before source claim " + claim.id + " is disclosed"
          );
        }
      }
    }
  }

  return errors;
}

function bookReviewGapIsEmpty(value) {
  const gap = typeof value === "string" ? value.trim() : "";
  return gap.length === 0 || gap === "无";
}

const BENCHMARK_VERDICTS = new Set(["ours_better", "original_better", "both_mediocre"]);

export function validateBookReviewLog(errors, auditLogText, paragraphCount, mode, transplantOptions) {
  const records = [];
  for (const line of String(auditLogText || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.finding === "book_review") records.push(entry);
  }

  for (let index = 1; index <= paragraphCount; index += 1) {
    const label = "audit log book_review paragraph " + index;
    const matches = records.filter((record) => record?.paragraph_index === index);
    if (matches.length === 0) {
      errors.push(label + " is missing — every final paragraph needs a book-reference review record");
      continue;
    }
    const record = matches[matches.length - 1];

    // Slim pass record: {"finding":"book_review","paragraph_index":N,"beat_id":"B<N>","verdict":"pass"}
    const isPass = record.verdict === "pass" && record.rewrite_action === undefined;
    if (isPass) {
      requireString(errors, record.beat_id, label + ".beat_id is required for pass records");
      continue; // pass records need nothing else
    }

    // Full review record: rewritten or old-format (rewrite_action-based)
    const rewriteAction = record.rewrite_action;
    requireString(errors, record.meaning, label + ".meaning");
    if (!Array.isArray(record.retrieved)) {
      errors.push(label + ".retrieved must be an array");
    } else if (record.retrieved.length === 0) {
      requireString(errors, record.no_footing, label + ".no_footing (required when retrieved is empty)");
    } else {
      for (const [itemIndex, item] of record.retrieved.entries()) {
        requireString(errors, item?.ref, label + ".retrieved[" + itemIndex + "].ref");
      }
    }
    if (!REWRITE_ACTIONS.has(rewriteAction)) {
      errors.push(label + ".rewrite_action must be full-reproduce, partial, or pass");
    }
    if (rewriteAction === "pass" && !bookReviewGapIsEmpty(record.gap)) {
      errors.push(label + " diagnosed a gap but passed the paragraph — degraded review");
    }
    if ((rewriteAction === "full-reproduce" || rewriteAction === "partial") && bookReviewGapIsEmpty(record.gap)) {
      errors.push(label + ".gap is required when the paragraph is rewritten");
    }
    if (mode === "polish") {
      if (!Array.isArray(record.kept_sentences)) {
        errors.push(label + ".kept_sentences must be an array in polish mode");
      } else {
        for (const [itemIndex, item] of record.kept_sentences.entries()) {
          requireString(errors, item?.sentence, label + ".kept_sentences[" + itemIndex + "].sentence");
          requireString(errors, item?.reason, label + ".kept_sentences[" + itemIndex + "].reason");
        }
      }
    }
    if (mode === "transplant") {
      if (!Array.isArray(record.kept_sentences)) {
        errors.push(label + ".kept_sentences must be an array in transplant mode");
      } else {
        for (const [itemIndex, item] of record.kept_sentences.entries()) {
          requireString(errors, item?.sentence, label + ".kept_sentences[" + itemIndex + "].sentence");
          requireString(errors, item?.reason, label + ".kept_sentences[" + itemIndex + "].reason");
          if (present(item?.sentence) && present(transplantOptions?.rawText) && normalizedContains(transplantOptions.rawText, item.sentence)) {
            errors.push(
              label + ".kept_sentences[" + itemIndex + "] matches the raw original source — kept original sentences are wash failures in transplant mode"
            );
          }
        }
      }
      // Benchmark against the original (the "fifth book"): a self-reported soft mechanism.
      // The machine checks the record's shape; the hard backstop is the user side-by-side review.
      const benchmark = record.benchmark;
      if (!benchmark || typeof benchmark !== "object") {
        errors.push(label + ".benchmark is required in transplant mode");
      } else {
        requireString(errors, benchmark.original_locus, label + ".benchmark.original_locus");
        if (!BENCHMARK_VERDICTS.has(benchmark.verdict)) {
          errors.push(label + ".benchmark.verdict must be ours_better, original_better, or both_mediocre");
        }
        if (benchmark.verdict === "both_mediocre") {
          requireString(errors, benchmark.technique, label + ".benchmark.technique (required when the verdict is both_mediocre)");
        }
      }
    }
  }
}

// --- Transplant-mode checks ---------------------------------------------------
// Everything below runs ONLY for mode === "transplant" (the mode-laundering check
// excepted: it fires on non-transplant modes). Wording contract: F0 / F2 / F6 are hard
// gates anchored to external evidence; F4 / F5 / F7 / F8 are CONSISTENCY checks between
// executor-declared values — they catch sloppiness, they do not prove skeleton fidelity.
// Machine checks guard against laziness, not against forged evidence files.

function parseJsonlFindings(auditLogText, finding) {
  const records = [];
  for (const line of String(auditLogText || "").split(/\r?\n/)) {
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

export function validateModeLaundering(errors, run, { runDir, rawFlagPassed }) {
  if (run?.mode === "transplant") return;
  const rawInDir = Boolean(runDir) && fs.existsSync(path.join(runDir, "00-original-source.raw.txt"));
  const transcriptInDir = Boolean(runDir) && fs.existsSync(path.join(runDir, "00-original-transcript.md"));
  if (rawFlagPassed || rawInDir || transcriptInDir) {
    errors.push(
      "run directory contains 00-original-source.raw.txt / 00-original-transcript.md (or --raw was passed) but mode is " +
        JSON.stringify(run?.mode) + " — an original source makes the run transplant (anti polish-laundering file-existence check)"
    );
  }
}

export function validateTransplantContract(errors, run, autopsy, { rawText, commentsText, commentsFlagPassed }) {
  const acts = Array.isArray(autopsy?.acts) ? autopsy.acts : [];
  const beats = Array.isArray(run?.beats) ? run.beats : [];

  // F0: every act evidence_quote must be a substring of the RAW original source
  // (strong normalization shared with the wash scanner). Anchors the declaration chain's
  // root: a hallucinated autopsy cannot quote the raw source.
  if (!requireArray(errors, acts, "autopsy.acts")) {
    return;
  }
  for (const [index, act] of acts.entries()) {
    const label = "autopsy.acts[" + index + "](" + (act?.act_id || "<missing>") + ")";
    requireString(errors, act?.act_id, label + ".act_id");
    requireString(errors, act?.evidence_quote, label + ".evidence_quote");
    if (present(act?.evidence_quote) && !normalizedContains(rawText || "", act.evidence_quote)) {
      errors.push(label + ".evidence_quote must be a substring of the raw original source (F0)");
    }
  }

  // F0c: comment evidence is anchored to the user-supplied comments file; when comments
  // are waived, no hypothesis may claim comment_verified, and the waiver needs a reason.
  const commentStatus = autopsy?.comment_data?.status;
  if (!["provided", "waived"].includes(commentStatus)) {
    errors.push("autopsy.comment_data.status must be provided or waived");
  } else if (commentStatus === "waived") {
    requireString(errors, autopsy?.comment_data?.waiver_reason, "autopsy.comment_data.waiver_reason (required when comments are waived)");
  } else if (!commentsFlagPassed) {
    errors.push("transplant mode requires --comments <file> when autopsy.comment_data.status is provided (F0c)");
  }
  const hypotheses = Array.isArray(autopsy?.why_it_works?.hypotheses) ? autopsy.why_it_works.hypotheses : [];
  for (const [index, hypothesis] of hypotheses.entries()) {
    const label = "autopsy.why_it_works.hypotheses[" + index + "]";
    if (commentStatus === "waived" && hypothesis?.status === "comment_verified") {
      errors.push(label + ".status must not be comment_verified — comments are waived (F0c)");
    }
    if (commentStatus === "provided" && commentsText !== undefined) {
      for (const [itemIndex, evidence] of (hypothesis?.comment_evidence || []).entries()) {
        if (!normalizedContains(commentsText, String(evidence ?? ""))) {
          errors.push(label + ".comment_evidence[" + itemIndex + "] must be a substring of the --comments file (F0c)");
        }
      }
    }
  }

  // F2: beat count must equal the autopsy act count.
  if (beats.length !== acts.length) {
    errors.push("beat count must equal the autopsy act count (F2)");
  }

  // F4 / F5: consistency between the beat's declared inheritance and the autopsy act.
  // Escape hatch: a non-empty beats[].transplant.repair (a declared repair).
  // F6: repairs are capped at 30% of acts AND at most 3 acts (anti act-inflation).
  let repairCount = 0;
  for (const [index, beat] of beats.entries()) {
    const label = "beat " + (beat?.id || "<missing>");
    const transplant = beat?.transplant;
    if (!transplant || typeof transplant !== "object") {
      errors.push(label + ".transplant is required in transplant mode");
      continue;
    }
    requireString(errors, transplant.original_act_id, label + ".transplant.original_act_id");
    const act = acts.find((candidate) => candidate?.act_id === transplant.original_act_id);
    if (present(transplant.original_act_id) && !act) {
      errors.push(label + ".transplant.original_act_id must name an autopsy act (consistency check)");
    }
    const repaired = present(transplant.repair);
    if (repaired) repairCount += 1;
    if (act) {
      if (!present(transplant.inherited?.function)) {
        if (!repaired) {
          errors.push(label + ".transplant.inherited.function is required (F4 consistency check)");
        }
      } else if (transplant.inherited.function !== act.function && !repaired) {
        errors.push(
          label + ".transplant.inherited.function must match autopsy act " + act.act_id +
            " function, or declare a repair (F4 consistency check)"
        );
      }
      if (!present(transplant.inherited?.temperature)) {
        if (!repaired) {
          errors.push(label + ".transplant.inherited.temperature is required (F5 consistency check)");
        }
      } else if (transplant.inherited.temperature !== act.temperature && !repaired) {
        errors.push(
          label + ".transplant.inherited.temperature must match autopsy act " + act.act_id +
            " temperature, or declare a repair (F5 consistency check)"
        );
      }
    }
  }
  if (acts.length > 0 && repairCount / acts.length > 0.3) {
    errors.push("repaired beats exceed 30% of the autopsy acts — abandon this original (F6)");
  }
  if (repairCount > 3) {
    errors.push("repaired beats exceed 3 acts — the repair cap is 30% AND at most 3 acts (F6)");
  }

  // F7 / F8: consistency between the retention contract and the autopsied skeleton.
  requireString(errors, autopsy?.shell_identified, "autopsy.shell_identified (required for the F7 consistency check)");
  if (
    present(autopsy?.shell_identified) &&
    present(run?.retention?.structure_shell) &&
    run.retention.structure_shell !== autopsy.shell_identified &&
    !present(run?.transplant?.shell_repair_reason)
  ) {
    errors.push("retention.structure_shell must match the autopsied shell unless transplant.shell_repair_reason is recorded (F7 consistency check)");
  }
  requireString(errors, autopsy?.opening_mechanism?.opening_mode, "autopsy.opening_mechanism.opening_mode (required for the F8 consistency check)");
  if (
    present(autopsy?.opening_mechanism?.opening_mode) &&
    present(run?.retention?.opening?.opening_mode) &&
    run.retention.opening.opening_mode !== autopsy.opening_mechanism.opening_mode &&
    !present(run?.transplant?.opening_repair_reason)
  ) {
    errors.push("retention.opening.opening_mode must match the autopsied opening mode unless transplant.opening_repair_reason is recorded (F8 consistency check)");
  }

  // Self-owned evidence: claiming the original is the account's own old script requires
  // a verifiable artifact under scripts/ or data/publish-manifests/, or a waiver reason.
  const resolution = run?.mode_resolution;
  if (resolution?.source_ownership === "self") {
    const evidence = resolution.self_owned_evidence;
    const evidencePath = evidence?.path;
    const waiver = evidence?.waiver_reason;
    if (!present(evidencePath) && !present(waiver)) {
      errors.push("mode_resolution.self_owned_evidence.path or .waiver_reason is required when source_ownership is self");
    } else if (present(evidencePath)) {
      const resolved = path.resolve(evidencePath);
      const segments = resolved.split(path.sep);
      const underScripts = segments.includes("scripts");
      const underManifests = segments.includes("data") && segments.includes("publish-manifests");
      if (!fs.existsSync(resolved)) {
        errors.push("mode_resolution.self_owned_evidence.path does not exist: " + evidencePath);
      } else if (!underScripts && !underManifests) {
        errors.push("mode_resolution.self_owned_evidence.path must live under scripts/ or data/publish-manifests/: " + evidencePath);
      }
    }
  }
}

// Requirement 3 (information density) has had zero machine visibility: 02-fact-pool.md was
// listed as a required artifact in SKILL.md but nothing enforced its presence, and a survey
// this session found it persisted in only 1 of 51 run directories. This check makes the
// listing real. It only runs at the persistence gate (--script supplied) — earlier in the
// workflow the pool legitimately does not exist yet.
export function validateFactPoolPersisted(errors, { poolPath, poolText }) {
  if (poolText === undefined) {
    errors.push(
      "02-fact-pool.md is missing at " + poolPath + " — persist it before the persistence gate " +
        "(SKILL.md step 2 output; report-run-metrics.mjs needs it to measure density utilization)"
    );
    return;
  }
  const factCount = (poolText.match(/^###\s+[A-Za-z0-9-]*F\d+\b/gm) || []).length;
  if (factCount < 40) {
    errors.push(
      "02-fact-pool.md has " + factCount + " facts — SKILL.md targets 40-60 " +
        "(fact-curation.md Phase 5: an act with fewer than 3 facts should have triggered " +
        "targeted search, not a thin pool reaching persistence)"
    );
  }
}

export function validateTransplantMap(errors, autopsy, run, { mapPath, mapText, mapRequired }) {
  if (mapText === undefined) {
    if (mapRequired) {
      errors.push(
        "transplant mode requires the transplant map at " + mapPath +
          " — render it with render-transplant-map.mjs before the persistence gate"
      );
    }
    return;
  }
  const diffs = diffTransplantMapLeftColumns(autopsy, run, mapText);
  for (const diff of diffs) {
    errors.push("transplant map left-column drift: " + diff + " (left columns are machine-rendered; hand edits are a hard failure)");
  }
}

export function validateTransplantFinalization(errors, run, autopsy, { rawText, scriptText, auditLogText }) {
  // Wash recompute: the audit-log wash_overlap record must exist, must say pass, and its
  // values must match what the scanner's own metrics function recomputes right now on the
  // final script vs the raw source. A hand-written record fails the comparison.
  if (scriptText !== undefined && auditLogText !== undefined) {
    const washRecords = parseJsonlFindings(auditLogText, "wash_overlap");
    if (washRecords.length === 0) {
      errors.push("audit log is missing a wash_overlap record — run scan-wash-overlap.mjs before validation");
    } else {
      const record = washRecords[washRecords.length - 1];
      const metrics = computeWashMetrics(scriptText, rawText || "");
      if (record.verdict !== "pass") {
        errors.push("audit log wash_overlap.verdict must be pass");
      }
      if (record.overlap_ratio !== metrics.overlapRatio || record.longest_run !== metrics.longestRun) {
        errors.push(
          "audit log wash_overlap values do not match the recomputed scan (record ratio " +
            JSON.stringify(record.overlap_ratio) + " / longest run " + JSON.stringify(record.longest_run) +
            ", recomputed ratio " + metrics.overlapRatio + " / longest run " + metrics.longestRun + ")"
        );
      }
    }
  }

  // opening_fidelity: the record must exist; inherited parameter names must be a subset of
  // the autopsy's opening_mechanism fields; on the external lane the selected sentence
  // must pass the scanner against the raw source.
  if (auditLogText !== undefined) {
    const records = parseJsonlFindings(auditLogText, "opening_fidelity");
    if (records.length === 0) {
      errors.push("audit log is missing an opening_fidelity record (transplant mode)");
    } else {
      const record = records[records.length - 1];
      requireString(errors, record.lane, "audit log opening_fidelity.lane");
      requireString(errors, record.selected_text, "audit log opening_fidelity.selected_text");
      const mechanism = autopsy?.opening_mechanism && typeof autopsy.opening_mechanism === "object" ? autopsy.opening_mechanism : {};
      const mechanismFields = new Set(Object.keys(mechanism));
      const candidates = Array.isArray(record.candidates) ? record.candidates : [];
      if (candidates.length === 0) {
        errors.push("audit log opening_fidelity.candidates must contain at least 1 item");
      }
      for (const [index, candidate] of candidates.entries()) {
        const fidelity = candidate?.fidelity && typeof candidate.fidelity === "object" ? candidate.fidelity : {};
        for (const [param, disposition] of Object.entries(fidelity)) {
          if (disposition === "inherit" && !mechanismFields.has(param)) {
            errors.push(
              "audit log opening_fidelity.candidates[" + index + "] inherits unknown opening_mechanism parameter " + param
            );
          }
        }
      }
      const declaredOwnership = run?.mode_resolution?.source_ownership ?? autopsy?.original_meta?.source_ownership;
      if (present(declaredOwnership) && present(record.lane) && record.lane !== declaredOwnership) {
        errors.push(
          "audit log opening_fidelity.lane must match the declared source_ownership " + declaredOwnership
        );
      }
      const effectiveLane = declaredOwnership ?? record.lane;
      if (effectiveLane === "external" && present(record.selected_text) && present(rawText)) {
        const opening = computeWashMetrics(record.selected_text, rawText);
        if (opening.longestRun > 0) {
          errors.push(
            "audit log opening_fidelity.selected_text shares a " + opening.longestRun +
              "-char run with the raw original source — lane 2 (external) replaces every fact and phrase"
          );
        }
      }
    }
  }
}

export function validateProductionRun(run) {
  const errors = [];
  const audience = run?.audience_contract;
  const narratorPersona = run?.narrator_persona;
  const truth = run?.truth_promise;
  const retention = run?.retention;
  const authorRoute = run?.author_route;
  const beats = run?.beats;

  if (!["generate", "polish", "transplant"].includes(run?.mode)) {
    errors.push("mode must be generate, polish, or transplant");
  }

  const metrics = run?.metrics_contract;
  if (metrics) {
    if (!Number.isInteger(metrics.target_duration_seconds) || metrics.target_duration_seconds < 15) {
      errors.push("metrics_contract.target_duration_seconds must be an integer >= 15");
    }
    const metricKeys = [
      "target_3s_retention",
      "target_5s_completion",
      "target_overall_completion"
    ];
    for (const key of metricKeys) {
      const value = metrics[key];
      if (typeof value !== "number" || value < 0 || value > 1) {
        errors.push("metrics_contract." + key + " must be a number between 0 and 1");
      }
    }
    if (!["3s_retention", "5s_completion", "overall_completion"].includes(metrics.primary_metric)) {
      errors.push("metrics_contract.primary_metric must be 3s_retention, 5s_completion, or overall_completion");
    }
    if (metrics.target_comment_rate !== undefined) {
      if (typeof metrics.target_comment_rate !== "number" || metrics.target_comment_rate < 0 || metrics.target_comment_rate > 1) {
        errors.push("metrics_contract.target_comment_rate must be a number between 0 and 1");
      }
      if (!COMMENT_STRATEGIES.has(metrics.comment_strategy)) {
        errors.push("metrics_contract.comment_strategy must be resonance, confrontation, expression, relation, or none when target_comment_rate is set");
      }
    }
  }
  validateInformationGapContract(errors, run?.information_gap_contract, metrics);

  if (!run?.genre || typeof run.genre !== "object") {
    errors.push("genre is required");
  } else {
    requireString(errors, run.genre.primary, "genre.primary");
  }
  validateAudienceContract(errors, audience, run?.genre);

  let factIds = new Set();
  let slowSceneIds = new Set();
  if (!truth || typeof truth !== "object") {
    errors.push("truth_promise is required");
  } else {
    if (!QUESTION_TYPES.has(truth.question_type)) {
      errors.push("truth_promise.question_type is invalid");
    }
    requireString(errors, truth.one_sentence_promise, "truth_promise.one_sentence_promise");
    requireString(errors, truth.question_engine?.text, "truth_promise.question_engine.text");
    requireArray(errors, truth.question_engine?.answerable_by, "truth_promise.question_engine.answerable_by");
    requireString(errors, truth.answer?.text, "truth_promise.answer.text");

    if (!ANSWER_STATUSES.has(truth.answer?.status)) {
      errors.push("truth_promise.answer.status is invalid");
    }
    requireArray(errors, truth.answer?.claim_ids, "truth_promise.answer.claim_ids");
    if (truth.answer?.status === "unresolved" && truth.question_type !== "investigation") {
      errors.push("an unresolved promise must be reframed or routed to investigation");
    }
    requireString(errors, truth.viewer_stake?.person_at_risk, "truth_promise.viewer_stake.person_at_risk");
    requireString(errors, truth.viewer_stake?.concrete_loss, "truth_promise.viewer_stake.concrete_loss");
    requireString(
      errors,
      truth.viewer_stake?.why_it_cannot_be_shrugged_off,
      "truth_promise.viewer_stake.why_it_cannot_be_shrugged_off"
    );

    factIds = validateSourceClaims(errors, truth.source_claims);
    requireKnownFactIds(errors, truth.question_engine?.answerable_by, factIds, "truth_promise.question_engine.answerable_by");
    requireKnownFactIds(errors, truth.answer?.claim_ids, factIds, "truth_promise.answer.claim_ids");
    ({ slowSceneIds } = validateDetailMap(errors, truth.detail_map, factIds));
  }

  const durationSeconds = run?.metrics_contract?.target_duration_seconds;
  if (Number.isInteger(durationSeconds) && durationSeconds >= 15) {
    const requiredClaims = Math.ceil((durationSeconds * 4.5) / 250);
    if (factIds.size < requiredClaims) {
      errors.push(
        "truth_promise.source_claims must contain at least " + requiredClaims +
          " facts to sustain " + durationSeconds +
          "s (fact budget: 250 spoken chars per fact at 4.5 chars/s; shorten the duration or add material)"
      );
    }
  }
  validateNarratorPersona(errors, narratorPersona, factIds);

  if (!retention || typeof retention !== "object") {
    errors.push("retention is required");
  } else {
    requireString(errors, retention.structure_shell, "retention.structure_shell");
    requireString(errors, retention.open_loop, "retention.open_loop");
    requireString(errors, retention.opening?.first_image_or_action, "retention.opening.first_image_or_action");
    requireString(errors, retention.opening?.known_after_opening, "retention.opening.known_after_opening");
    requireString(errors, retention.opening?.withheld_until, "retention.opening.withheld_until");
    requireString(errors, retention.opening?.forbidden_information_order, "retention.opening.forbidden_information_order");
    validateOpeningReaderContract(errors, retention);
    requireString(errors, retention.stake?.who, "retention.stake.who");
    requireString(errors, retention.stake?.loss, "retention.stake.loss");
    requireString(errors, retention.stake?.why_now, "retention.stake.why_now");
    requireString(errors, retention.payoff_fact_id, "retention.payoff_fact_id");
    if (!requireArray(errors, retention.middle_turns, "retention.middle_turns")) {
      // Individual checks would only duplicate the missing-array error.
    } else {
      for (const [index, turn] of retention.middle_turns.entries()) {
        const label = "retention.middle_turns[" + index + "]";
        requireString(errors, turn?.fact_id, label + ".fact_id");
        requireString(errors, turn?.reader_belief_before, label + ".reader_belief_before");
        requireString(errors, turn?.reader_belief_after, label + ".reader_belief_after");
        requireString(errors, turn?.next_question, label + ".next_question");
      }
    }
    requireString(errors, retention.ending?.answer_sentence_fact_id, "retention.ending.answer_sentence_fact_id");
    requireString(errors, retention.ending?.charged_image, "retention.ending.charged_image");
    requireString(errors, retention.ending?.hard_stop_word, "retention.ending.hard_stop_word");
    requireString(
      errors,
      retention.rhetorical_budget?.standalone_hammer_beat_id,
      "retention.rhetorical_budget.standalone_hammer_beat_id"
    );
    if (retention.rhetorical_budget?.max_meta_preview_labels !== 0) {
      errors.push("retention.rhetorical_budget.max_meta_preview_labels must be 0");
    }
    if (retention.rhetorical_budget?.max_cheap_surprise_adverbs !== 1) {
      errors.push("retention.rhetorical_budget.max_cheap_surprise_adverbs must be 1");
    }

    requireKnownFactIds(errors, [retention.payoff_fact_id], factIds, "retention.payoff_fact_id");
    requireKnownFactIds(errors, [retention.ending?.answer_sentence_fact_id], factIds, "retention.ending.answer_sentence_fact_id");
    for (const turn of retention.middle_turns || []) {
      requireKnownFactIds(errors, [turn?.fact_id], factIds, "retention.middle_turn fact_id");
    }
  }

  if (!authorRoute || typeof authorRoute !== "object") {
    errors.push("author_route is required");
  } else {
    if (!REASONING_MODULES.has(authorRoute.reasoning_module)) {
      errors.push("author_route.reasoning_module is invalid");
    }
    if (!authorRoute.voice_palette || typeof authorRoute.voice_palette !== "object") {
      errors.push("author_route.voice_palette is required");
    }
  }

  const beatIds = new Set();
  const firstDisclosures = new Set();
  const firstDisclosureIndexes = new Map();
  const slowSceneRefs = new Map();
  if (!Array.isArray(beats) || beats.length < 2) {
    errors.push("beats must contain at least two entries");
  } else {
    let previousQuestionOutId = undefined;
    // Numeric tail of the derived question ids (Q1, Q2, …). Seeded from the open loop's id
    // when it carries one so a declared `open_loop_id: "Q1"` keeps numbering from there.
    let questionCounter = (() => {
      const match = /^Q(\d+)$/.exec(String(retention?.open_loop_id ?? ""));
      return match ? Number(match[1]) : 1;
    })();
    for (const [index, beat] of beats.entries()) {
      const label = "beat " + (beat?.id || "<missing>");
      requireString(errors, beat?.id, "beat.id");
      if (beat?.id && beatIds.has(beat.id)) errors.push("beats repeats id " + beat.id);
      if (beat?.id) beatIds.add(beat.id);
      requireString(errors, beat?.retention_job, label + ".retention_job");
      if (requireArray(errors, beat?.fact_ids, label + ".fact_ids")) {
        requireKnownFactIds(errors, beat.fact_ids, factIds, label + ".fact_ids");
      }
      // Minimal beat contract. `reader_belief_change` / `state_change` /
      // `next_beat_forced_by` / `detail_mode` / `detail_ref` used to be required on every
      // beat. They were planning prose the author does not read — the review happens on the
      // finished script — and on a 57-paragraph run they were the single largest block of
      // hand-written JSON in the repo. They are now optional: still validated when present
      // (so a run that wants the fuller plan keeps its guarantees), never demanded.
      if (present(beat?.reader_belief_change) === false && beat?.reader_belief_change !== undefined) {
        errors.push(label + ".reader_belief_change must not be blank when present");
      }
      if (beat?.state_change !== undefined) {
        requireString(errors, beat.state_change?.actor, label + ".state_change.actor");
        requireString(
          errors,
          beat.state_change?.information_or_resource_changed,
          label + ".state_change.information_or_resource_changed"
        );
        requireString(
          errors,
          beat.state_change?.option_or_risk_changed,
          label + ".state_change.option_or_risk_changed"
        );
      }
      if (beat?.detail_mode !== undefined && !DETAIL_MODES.has(beat.detail_mode)) {
        errors.push(label + ".detail_mode is invalid");
      }
      if (beat?.detail_mode === "slow_scene") {
        requireString(errors, beat?.detail_ref, label + ".detail_ref (required for a slow scene)");
      }
      if (!PERSONA_TEMPERATURES.has(beat?.persona_temperature)) {
        errors.push(label + ".persona_temperature must be cold, warm, or hot");
      }
      requireString(errors, beat?.persona_job, label + ".persona_job");
      if (!STANCE_RELATIONS.has(beat?.stance_relation)) {
        errors.push(label + ".stance_relation is invalid");
      }

      const commentMoment = beat?.comment_moment;
      if (commentMoment !== undefined) {
        if (typeof commentMoment.enabled !== "boolean") {
          errors.push(label + ".comment_moment.enabled must be a boolean");
        } else if (commentMoment.enabled) {
          if (!COMMENT_TYPES.has(commentMoment.type)) {
            errors.push(label + ".comment_moment.type must be resonance, confrontation, expression, or relation");
          }
          requireString(errors, commentMoment.trigger_line, label + ".comment_moment.trigger_line");
        }
      }

      if (!DISCLOSURE_KINDS.has(beat?.disclosure?.kind)) {
        errors.push(label + ".disclosure.kind is invalid");
      }
      if (requireArray(errors, beat?.disclosure?.fact_ids, label + ".disclosure.fact_ids")) {
        requireKnownFactIds(errors, beat.disclosure.fact_ids, factIds, label + ".disclosure.fact_ids");
      }
      if (beat?.disclosure?.kind === "recall") {
        requireString(errors, beat.disclosure.new_meaning, label + ".disclosure.new_meaning");
      }
      if (beat?.disclosure?.kind === "first") {
        for (const factId of beat.disclosure.fact_ids || []) {
          if (firstDisclosures.has(factId)) {
            errors.push("source claim " + factId + " has more than one first disclosure");
          }
          firstDisclosures.add(factId);
          firstDisclosureIndexes.set(factId, index);
          if (!beat?.reader_relay?.fact_ids_disclosed_here?.includes(factId)) {
            errors.push(label + ".reader_relay.fact_ids_disclosed_here must include first disclosure " + factId);
          }
        }
      }

      ({ questionOutId: previousQuestionOutId, counter: questionCounter } = validateReaderRelay(
        errors,
        beat?.reader_relay,
        label,
        factIds,
        previousQuestionOutId,
        retention?.open_loop_id,
        questionCounter
      ));

      if (beat?.detail_mode === "slow_scene") {
        if (!slowSceneIds.has(beat.detail_ref)) {
          errors.push(label + ".detail_ref must name a committed slow scene");
        } else {
          slowSceneRefs.set(beat.detail_ref, (slowSceneRefs.get(beat.detail_ref) || 0) + 1);
        }
      }
      if (beat?.phase_kind === "biography") {
        errors.push(label + " is biography material disguised as a causal phase");
      }
    }

    for (const slowSceneId of slowSceneIds) {
      const count = slowSceneRefs.get(slowSceneId) || 0;
      if (count !== 1) errors.push("committed slow scene " + slowSceneId + " must map to exactly one beat");
    }
    if (retention?.rhetorical_budget?.standalone_hammer_beat_id && !beatIds.has(retention.rhetorical_budget.standalone_hammer_beat_id)) {
      errors.push("retention.rhetorical_budget.standalone_hammer_beat_id must name a beat");
    }
    if (retention?.payoff_fact_id) {
      const payoffBeatContainsFact = beats.some(
        (beat) => beat?.retention_job === "payoff" && beat?.fact_ids?.includes(retention.payoff_fact_id)
      );
      if (!payoffBeatContainsFact) {
        errors.push("retention.payoff_fact_id must appear in a payoff beat");
      }
    }
    validatePersonaAgainstBeats(errors, narratorPersona, beats, beatIds);

    const stanceRevealIndex = beats.findIndex((beat) => beat?.id === narratorPersona?.stance_reveal_beat);
    if (stanceRevealIndex >= 0) {
      for (const factId of narratorPersona?.stance_fact_ids || []) {
        const firstDisclosureIndex = firstDisclosureIndexes.get(factId);
        if (firstDisclosureIndex === undefined || firstDisclosureIndex > stanceRevealIndex) {
          errors.push(
            "narrator_persona.stance_fact_ids must be disclosed no later than stance reveal beat " +
              narratorPersona.stance_reveal_beat + ": " + factId
          );
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

function printUsage() {
  process.stderr.write(
    "Usage: node validate-production-run.mjs --file <production-run.json> [--script <final.md> --paragraph-locks <paragraph-locks.jsonl> --audit-log <audit-log.jsonl>] [--raw <00-original-source.raw.txt> --autopsy <00-autopsy.json> --comments <comments-file>]\\n"
  );
}

function main() {
  const index = process.argv.indexOf("--file");
  const file = index >= 0 ? process.argv[index + 1] : undefined;
  const scriptIndex = process.argv.indexOf("--script");
  const scriptFile = scriptIndex >= 0 ? process.argv[scriptIndex + 1] : undefined;
  const locksIndex = process.argv.indexOf("--paragraph-locks");
  const locksFile = locksIndex >= 0 ? process.argv[locksIndex + 1] : undefined;
  const auditIndex = process.argv.indexOf("--audit-log");
  const auditFile = auditIndex >= 0 ? process.argv[auditIndex + 1] : undefined;
  const rawIndex = process.argv.indexOf("--raw");
  const rawFile = rawIndex >= 0 ? process.argv[rawIndex + 1] : undefined;
  const autopsyIndex = process.argv.indexOf("--autopsy");
  const autopsyFile = autopsyIndex >= 0 ? process.argv[autopsyIndex + 1] : undefined;
  const commentsIndex = process.argv.indexOf("--comments");
  const commentsFile = commentsIndex >= 0 ? process.argv[commentsIndex + 1] : undefined;
  if (!file) {
    printUsage();
    process.exitCode = 2;
    return;
  }

  let run;
  try {
    run = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  } catch (error) {
    process.stderr.write("Unable to read production run: " + error.message + "\\n");
    process.exitCode = 2;
    return;
  }

  const result = validateProductionRun(run);
  const runDir = path.dirname(path.resolve(file));

  // Anti polish-laundering (file-existence check, zero semantics): an original source in
  // the run directory makes the run transplant regardless of the declared mode.
  validateModeLaundering(result.errors, run, { runDir, rawFlagPassed: Boolean(rawFile) });

  // Transplant branch: every check below is a hard failure and only applies when
  // mode === "transplant".
  let autopsy;
  let rawText;
  let commentsText;
  if (run?.mode === "transplant") {
    if (!autopsyFile) {
      result.errors.push("transplant mode requires --autopsy <00-autopsy.json>");
    }
    if (!rawFile) {
      result.errors.push("transplant mode requires --raw <00-original-source.raw.txt>");
    }
    try {
      if (autopsyFile) autopsy = JSON.parse(fs.readFileSync(path.resolve(autopsyFile), "utf8"));
      if (rawFile) rawText = fs.readFileSync(path.resolve(rawFile), "utf8");
      if (commentsFile) commentsText = fs.readFileSync(path.resolve(commentsFile), "utf8");
    } catch (error) {
      result.errors.push("Unable to read raw source, autopsy, or comments file: " + error.message);
    }
    if (autopsy !== undefined && rawText !== undefined) {
      validateTransplantContract(result.errors, run, autopsy, {
        rawText,
        commentsText,
        commentsFlagPassed: Boolean(commentsFile)
      });
      // The transplant map step was removed from the workflow (step 3 fills the skeleton
      // straight from the fact pool). The map is no longer required; when a legacy run
      // still has one on disk, its machine-rendered left columns are still checked for
      // hand edits.
      const mapPath = path.join(runDir, "04-transplant-map.md");
      const mapText = fs.existsSync(mapPath) ? fs.readFileSync(mapPath, "utf8") : undefined;
      validateTransplantMap(result.errors, autopsy, run, {
        mapPath,
        mapText,
        mapRequired: false
      });
    }
  }

  if (Boolean(scriptFile) !== Boolean(locksFile)) {
    result.errors.push("--script and --paragraph-locks must be supplied together");
  } else if (scriptFile && locksFile) {
    if (!auditFile) {
      result.errors.push("--audit-log is required with --script and --paragraph-locks");
    }
    const poolPath = path.join(runDir, "02-fact-pool.md");
    const poolText = fs.existsSync(poolPath) ? fs.readFileSync(poolPath, "utf8") : undefined;
    validateFactPoolPersisted(result.errors, { poolPath, poolText });
    let scriptText;
    let paragraphLocks;
    let auditLogText;
    try {
      scriptText = fs.readFileSync(path.resolve(scriptFile), "utf8");
      paragraphLocks = fs
        .readFileSync(path.resolve(locksFile), "utf8")
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line));
      auditLogText = auditFile ? fs.readFileSync(path.resolve(auditFile), "utf8") : undefined;
    } catch (error) {
      result.errors.push("Unable to read final script, paragraph locks, or audit log: " + error.message);
    }
    if (scriptText !== undefined && paragraphLocks !== undefined) {
      result.errors.push(...validateFinalScript(run, scriptText, paragraphLocks));
      if (auditLogText !== undefined) {
        validateBookReviewLog(result.errors, auditLogText, paragraphLocks.length, run?.mode, { rawText });
      }
      if (run?.mode === "transplant" && autopsy !== undefined && rawText !== undefined) {
        validateTransplantFinalization(result.errors, run, autopsy, { rawText, scriptText, auditLogText });
      }
    }
  }
  result.valid = result.errors.length === 0;
  if (result.valid) {
    process.stdout.write("PASS production run\\n");
    return;
  }

  process.stderr.write("REJECT production run\\n");
  for (const error of result.errors) process.stderr.write("- " + error + "\\n");
  process.exitCode = 1;
}

const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (invokedDirectly) main();
