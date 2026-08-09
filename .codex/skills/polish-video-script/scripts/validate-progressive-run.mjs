#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildAttentionTimeline } from "./build-attention-timeline.mjs";

const DRIVER_SET = new Set(["山", "海", "墓", "色"]);
const RELATION_SET = new Set(["open", "shrink", "deepen", "reverse", "raise_stakes", "pay"]);
const ACTIVE_STAGE_STATES = new Set(["active", "awaiting_creator"]);
const FINAL_RUN_STATES = new Set(["ASSEMBLED", "AUDIT_RUNNING", "REOPEN_PROPOSED", "AUDITED_CANDIDATE", "AWAIT_FINAL_ACK", "PUBLISH_READY"]);
const AUDITED_RUN_STATES = new Set(["AUDITED_CANDIDATE", "AWAIT_FINAL_ACK", "PUBLISH_READY"]);
const REQUIRED_AUDITS = ["fact", "structure_payment", "sentence", "retention", "comment_share"];
const REQUIRED_RETENTION_WINDOWS = ["0_2s", "2_5s", "5_15s", "body", "ending"];
const DIAGNOSTIC_STATUS_SET = new Set(["pass", "risk", "block"]);
const COMMENT_STRATEGY_SET = new Set(["resonance", "confrontation", "expression", "relation"]);
const GENERIC_ENGAGEMENT_CTA = /^(?:你(?:们)?怎么看|你觉得呢|大家怎么看)(?:[？?，,。.!！\s]*(?:欢迎)?(?:在)?评论区(?:告诉我|留言|讨论))?[？?，,。.!！\s]*$/u;
const THEORY_PATTERN = /信息缺口|挖洞|蔡格尼克|山|海|墓|色|判断型利他|宽钩子|承诺|支付|情绪/u;
const GENERIC_ONLY = /^(?:增强留存|制造悬念|引发共鸣|提升节奏|更有冲击力|吸引观众|让人想看下去)[。.!！]*$/u;

export function sha256(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
}

function present(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function requireString(errors, value, label) {
  if (!present(value)) errors.push(`${label} is required`);
}

function requireArray(errors, value, label) {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`);
    return false;
  }
  return true;
}

function validatePayment(errors, promise, payoff) {
  for (const [label, value] of [["contract.promise", promise], ["contract.planned_payoff", payoff]]) {
    if (!value || typeof value !== "object") {
      errors.push(`${label} is required`);
      continue;
    }
    requireString(errors, value.text, `${label}.text`);
    requireString(errors, value.currency, `${label}.currency`);
    requireString(errors, value.subject, `${label}.subject`);
    requireString(errors, value.scope, `${label}.scope`);
  }
  if (!promise || !payoff) return;
  if (promise.currency !== payoff.currency) errors.push("E_PROMISE_CURRENCY_MISMATCH");
  if (promise.subject !== payoff.subject) errors.push("E_PROMISE_SUBJECT_MISMATCH");
  if (promise.scope !== payoff.scope) errors.push("E_PROMISE_SCOPE_MISMATCH");
}

function validateDriverContract(errors, contract) {
  const driver = contract?.driver_contract;
  if (!driver || typeof driver !== "object") {
    errors.push("contract.driver_contract is required");
    return;
  }
  if (driver.primary !== contract.primary_driver) errors.push("contract.driver_contract.primary must match contract.primary_driver");
  if (!Array.isArray(driver.evidence_ids) || driver.evidence_ids.length === 0) errors.push("contract.driver_contract.evidence_ids must not be empty");
  requireString(errors, driver.mechanism, "contract.driver_contract.mechanism");
  requireString(errors, driver.selection_effect, "contract.driver_contract.selection_effect");
  if (driver.primary === "山") {
    requireString(errors, driver.opposition, "contract.driver_contract.opposition");
    requireString(errors, driver.cost, "contract.driver_contract.cost");
    requireString(errors, driver.escalation, "contract.driver_contract.escalation");
  } else if (driver.primary === "海") {
    requireString(errors, driver.exploration_endpoint, "contract.driver_contract.exploration_endpoint");
  } else if (driver.primary === "墓") {
    requireString(errors, driver.boundary, "contract.driver_contract.boundary");
    requireString(errors, driver.access_rule, "contract.driver_contract.access_rule");
  } else if (driver.primary === "色") {
    requireString(errors, driver.consumed_emotion, "contract.driver_contract.consumed_emotion");
  }
}

function validateRationale(errors, stage, label) {
  const rationale = stage?.why_this_draft;
  if (!rationale || typeof rationale !== "object") {
    errors.push(`E_GENERIC_RATIONALE: ${label}.why_this_draft is required`);
    return;
  }
  const fields = ["material_reason", "theory_reason", "structural_reason", "intentionally_unpaid"];
  for (const field of fields) {
    const value = rationale[field];
    if (!present(value) || GENERIC_ONLY.test(value.trim())) {
      errors.push(`E_GENERIC_RATIONALE: ${label}.why_this_draft.${field} must be material-specific`);
    }
  }
  if (present(rationale.theory_reason) && !THEORY_PATTERN.test(rationale.theory_reason)) {
    errors.push(`E_GENERIC_RATIONALE: ${label}.why_this_draft.theory_reason must name a Li Mola principle`);
  }
  if (present(stage.audience_belief_before) && present(stage.audience_belief_after) && stage.audience_belief_before === stage.audience_belief_after) {
    errors.push(`E_STAGE_NO_BELIEF_CHANGE: ${label} must change the audience answer-state`);
  }
}

function diagnosticDetails(errors, audit, type) {
  const details = audit?.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    errors.push(`${type} audit.details is required`);
    return undefined;
  }
  if (details.prediction_policy !== "qualitative_only") {
    errors.push(`E_FABRICATED_METRIC_RATE: ${type} audit must use qualitative_only`);
  }
  return details;
}

function findStage(stages, stageId) {
  return stages.find((stage) => stage.id === stageId);
}

function validateLockedQuote(errors, run, stages, item, label, errorCode) {
  requireString(errors, item?.stage_id, `${label}.stage_id`);
  requireString(errors, item?.exact_quote, `${label}.exact_quote`);
  const stage = findStage(stages, item?.stage_id);
  if (!stage || !present(item?.exact_quote) || !String(stage?.locked_text ?? "").includes(item.exact_quote) || !String(run?.assembly?.text ?? "").includes(item.exact_quote)) {
    errors.push(`${errorCode}: ${label}.exact_quote must exist in its locked stage and assembly`);
  }
}

function validateRetentionAudit(errors, audit, run, stages) {
  const details = diagnosticDetails(errors, audit, "retention");
  if (!details) return;

  const timing = details.timing_basis;
  if (!timing || typeof timing !== "object") {
    errors.push("retention audit.details.timing_basis is required");
  } else {
    if (!["character_ratio_estimate", "narration_timestamps"].includes(timing.kind)) {
      errors.push("retention audit timing_basis.kind is invalid");
    }
    if (timing.target_duration_seconds !== run?.contract?.target_duration_seconds) {
      errors.push("retention audit timing target must match contract.target_duration_seconds");
    }
  }

  const windows = Array.isArray(details.windows) ? details.windows : [];
  if (!Array.isArray(details.windows)) errors.push("retention audit.details.windows must be an array");
  const windowIds = new Set();
  let hasRetentionRisk = false;
  for (const [index, window] of windows.entries()) {
    const label = `retention audit.details.windows[${index}]`;
    requireString(errors, window?.id, `${label}.id`);
    if (windowIds.has(window?.id)) errors.push(`retention audit repeats window ${window.id}`);
    windowIds.add(window?.id);
    if (!DIAGNOSTIC_STATUS_SET.has(window?.status)) errors.push(`${label}.status is invalid`);
    hasRetentionRisk ||= window?.status === "risk" || window?.status === "block";
    validateLockedQuote(errors, run, stages, window, label, "E_RETENTION_QUOTE_NOT_FOUND");
    requireString(errors, window?.viewer_pull, `${label}.viewer_pull`);
    requireString(errors, window?.evidence, `${label}.evidence`);
    if ((window?.status === "risk" || window?.status === "block") && !present(window?.repair)) {
      errors.push(`${label}.repair is required for risk or block`);
    }
  }
  for (const id of REQUIRED_RETENTION_WINDOWS) {
    if (!windowIds.has(id)) errors.push(`E_RETENTION_WINDOW_MISSING: ${id}`);
  }

  if (timing?.kind === "character_ratio_estimate") {
    try {
      const timeline = buildAttentionTimeline(run);
      const checkpointByWindow = new Map([
        ["0_2s", "2s"],
        ["2_5s", "5s"],
        ["5_15s", "15s"],
        ["ending", "ending"]
      ]);
      for (const [windowId, checkpointId] of checkpointByWindow) {
        const window = windows.find((item) => item?.id === windowId);
        const checkpoint = timeline.checkpoints.find((item) => item.id === checkpointId);
        if (window && checkpoint && window.stage_id !== checkpoint.stage_id) {
          errors.push(`E_RETENTION_TIMELINE_STAGE_MISMATCH: ${windowId} must inspect ${checkpoint.stage_id}`);
        }
      }
    } catch {
      // Assembly validation reports the underlying stale or incomplete input.
    }
  }

  const chain = Array.isArray(details.stage_chain) ? details.stage_chain : [];
  if (!Array.isArray(details.stage_chain)) errors.push("retention audit.details.stage_chain must be an array");
  if (chain.length !== stages.length) errors.push("E_RETENTION_CHAIN_INCOMPLETE: stage_chain must cover every stage exactly once");
  for (const [index, stage] of stages.entries()) {
    const entry = chain[index];
    const label = `retention audit.details.stage_chain[${index}]`;
    if (entry?.stage_id !== stage.id) errors.push(`${label}.stage_id must be ${stage.id}`);
    if (!DIAGNOSTIC_STATUS_SET.has(entry?.status)) errors.push(`${label}.status is invalid`);
    hasRetentionRisk ||= entry?.status === "risk" || entry?.status === "block";
    for (const field of ["incoming_pull", "new_information", "outgoing_pull"]) {
      requireString(errors, entry?.[field], `${label}.${field}`);
    }
    if (entry?.main_hole_relation !== stage.main_hole_relation) {
      errors.push(`${label}.main_hole_relation must match the locked stage map`);
    }
    if ((entry?.status === "risk" || entry?.status === "block") && !present(entry?.repair)) {
      errors.push(`${label}.repair is required for risk or block`);
    }
  }
  requireString(errors, details.overall_reason, "retention audit.details.overall_reason");
  if (audit?.verdict === "pass" && hasRetentionRisk) errors.push("E_RETENTION_VERDICT_CONTRADICTION");
  if (audit?.verdict === "fail" && !hasRetentionRisk) errors.push("E_RETENTION_VERDICT_CONTRADICTION");
}

function validateCommentShareAudit(errors, audit, run, stages) {
  const details = diagnosticDetails(errors, audit, "comment_share");
  if (!details) return;
  if (!COMMENT_STRATEGY_SET.has(details.comment_strategy)) {
    errors.push("comment_share audit.details.comment_strategy is invalid");
  }

  const comment = details.comment_trigger;
  if (!comment || typeof comment !== "object") {
    errors.push("comment_share audit.details.comment_trigger is required");
  } else {
    validateLockedQuote(errors, run, stages, comment, "comment_share audit.details.comment_trigger", "E_ENGAGEMENT_TRIGGER_NOT_FOUND");
    requireString(errors, comment.mechanism, "comment_share audit.details.comment_trigger.mechanism");
    requireString(errors, comment.expected_comment, "comment_share audit.details.comment_trigger.expected_comment");
    if (present(comment.exact_quote) && GENERIC_ENGAGEMENT_CTA.test(comment.exact_quote.trim())) {
      errors.push("E_GENERIC_ENGAGEMENT_CTA");
    }
  }

  const viewerGap = details.viewer_owned_gap;
  if (!viewerGap || typeof viewerGap !== "object") {
    errors.push("comment_share audit.details.viewer_owned_gap is required");
  } else {
    requireString(errors, viewerGap.stage_id, "comment_share audit.details.viewer_owned_gap.stage_id");
    requireString(errors, viewerGap.question, "comment_share audit.details.viewer_owned_gap.question");
    if (viewerGap.intentionally_open !== true || viewerGap.answerable_by_viewer !== true) {
      errors.push("comment_share viewer_owned_gap must remain open and answerable by the viewer");
    }
    const creatorDebts = new Set([
      run?.contract?.main_hole,
      ...stages.flatMap((stage) => [...(stage.subholes_opened ?? []), ...(stage.subholes_paid ?? [])])
    ].filter(present).map((value) => value.trim()));
    if (present(viewerGap.question) && creatorDebts.has(viewerGap.question.trim())) {
      errors.push("E_COMMENT_GAP_IS_CREATOR_DEBT");
    }
  }

  const share = details.share_trigger;
  if (!share || typeof share !== "object") {
    errors.push("comment_share audit.details.share_trigger is required");
  } else {
    validateLockedQuote(errors, run, stages, share, "comment_share audit.details.share_trigger", "E_ENGAGEMENT_TRIGGER_NOT_FOUND");
    requireString(errors, share.target_person, "comment_share audit.details.share_trigger.target_person");
    requireString(errors, share.send_reason, "comment_share audit.details.share_trigger.send_reason");
  }

  requireString(errors, details.retell_line, "comment_share audit.details.retell_line");
  if (present(details.retell_line) && (details.retell_line.includes("\n") || Array.from(details.retell_line).length > 80)) {
    errors.push("comment_share audit.details.retell_line must be one concise sentence of at most 80 characters");
  }
  requireString(errors, details.overall_reason, "comment_share audit.details.overall_reason");
}

export function validateProgressiveRun(run) {
  const errors = [];

  if (run?.schema_version !== 2) errors.push("schema_version must be 2");
  if (!["transplant", "generate"].includes(run?.mode)) errors.push("mode must be transplant or generate");
  requireString(errors, run?.run_id, "run_id");
  requireString(errors, run?.status, "status");

  const events = Array.isArray(run?.events) ? run.events : [];
  if (!Array.isArray(run?.events)) errors.push("events must be an array");
  const eventById = new Map();
  const eventIndexById = new Map();
  for (const [index, event] of events.entries()) {
    const label = `events[${index}]`;
    requireString(errors, event?.id, `${label}.id`);
    requireString(errors, event?.kind, `${label}.kind`);
    if (event?.actor !== "creator") errors.push(`${label}.actor must be creator`);
    requireString(errors, event?.target_id, `${label}.target_id`);
    if (event?.id) {
      if (eventById.has(event.id)) errors.push(`events repeats id ${event.id}`);
      eventById.set(event.id, event);
      eventIndexById.set(event.id, index);
    }
  }

  function requireEvent(id, kind, targetId, label) {
    if (!present(id)) {
      errors.push(`${label} is required`);
      return undefined;
    }
    const event = eventById.get(id);
    if (!event) {
      errors.push(`${label} references unknown event ${id}`);
      return undefined;
    }
    if (event.kind !== kind) errors.push(`${label} must reference a ${kind} event`);
    if (targetId !== undefined && event.target_id !== targetId) errors.push(`${label} must target ${targetId}`);
    return event;
  }

  const contract = run?.contract;
  if (!contract || typeof contract !== "object") {
    errors.push("contract is required");
  } else {
    for (const field of ["topic", "audience", "target_platform", "thesis", "main_hole"]) {
      requireString(errors, contract[field], `contract.${field}`);
    }
    if (!Number.isFinite(contract.target_duration_seconds) || contract.target_duration_seconds < 15) {
      errors.push("contract.target_duration_seconds must be a number >= 15");
    }
    if (!DRIVER_SET.has(contract.primary_driver)) errors.push("contract.primary_driver must be 山, 海, 墓, or 色");
    if (contract.secondary_driver !== undefined && !DRIVER_SET.has(contract.secondary_driver)) {
      errors.push("contract.secondary_driver must be 山, 海, 墓, or 色");
    }
    if (contract.secondary_driver === contract.primary_driver) errors.push("contract.secondary_driver must differ from primary_driver");
    requireString(errors, contract.audience_bridge, "contract.audience_bridge");
    validateDriverContract(errors, contract);
    validatePayment(errors, contract.promise, contract.planned_payoff);
    const topicConfirmEvent = requireEvent(
      contract.topic_confirm_event_id,
      "topic_confirm",
      "topic",
      "contract.topic_confirm_event_id"
    );
    if (topicConfirmEvent && present(contract.topic) && topicConfirmEvent.content_hash !== sha256(contract.topic)) {
      errors.push("E_TOPIC_NOT_CONFIRMED: topic confirmation hash does not match contract.topic");
    }
    if (contract.status === "locked") {
      const contractLockEvent = requireEvent(contract.lock_event_id, "contract_lock", "contract", "contract.lock_event_id");
      if (
        topicConfirmEvent &&
        contractLockEvent &&
        eventIndexById.get(topicConfirmEvent.id) >= eventIndexById.get(contractLockEvent.id)
      ) {
        errors.push("E_TOPIC_CONFIRM_ORDER: topic confirmation must precede contract lock");
      }
    }
  }

  const stageMap = run?.stage_map;
  const stages = Array.isArray(stageMap?.stages) ? [...stageMap.stages].sort((a, b) => a.order - b.order) : [];
  if (!stageMap || typeof stageMap !== "object") errors.push("stage_map is required");
  if (!Array.isArray(stageMap?.stages)) errors.push("stage_map.stages must be an array");
  if (stages.length < 3 || stages.length > 8) errors.push("stage_map.stages must contain 3 to 8 stages");
  if (stageMap?.status === "locked") requireEvent(stageMap.lock_event_id, "map_lock", "stage_map", "stage_map.lock_event_id");

  const stageIds = new Set();
  let activeCount = 0;
  let anyDraft = false;
  const openedSubholes = new Set();
  const paidSubholes = new Set();

  for (const [index, stage] of stages.entries()) {
    const label = `stage_map.stages[${index}]`;
    requireString(errors, stage?.id, `${label}.id`);
    if (stage?.id) {
      if (stageIds.has(stage.id)) errors.push(`stage_map.stages repeats id ${stage.id}`);
      stageIds.add(stage.id);
    }
    if (stage?.order !== index + 1) errors.push(`${label}.order must be ${index + 1}`);
    requireString(errors, stage?.name, `${label}.name`);
    requireString(errors, stage?.stage_job, `${label}.stage_job`);
    requireString(errors, stage?.audience_belief_before, `${label}.audience_belief_before`);
    requireString(errors, stage?.audience_belief_after, `${label}.audience_belief_after`);
    if (!RELATION_SET.has(stage?.main_hole_relation)) errors.push(`${label}.main_hole_relation is invalid`);
    if (!DRIVER_SET.has(stage?.primary_driver)) errors.push(`${label}.primary_driver must be 山, 海, 墓, or 色`);
    for (const field of ["evidence_ids", "subholes_opened", "subholes_paid", "draft_versions", "upstream_locked_hashes", "downstream_constraints"]) {
      requireArray(errors, stage?.[field], `${label}.${field}`);
    }
    for (const subhole of Array.isArray(stage?.subholes_opened) ? stage.subholes_opened : []) {
      if (openedSubholes.has(subhole)) errors.push(`subhole ${subhole} is opened more than once`);
      openedSubholes.add(subhole);
    }
    for (const subhole of Array.isArray(stage?.subholes_paid) ? stage.subholes_paid : []) {
      if (!openedSubholes.has(subhole)) errors.push(`E_SUBHOLE_SEMANTIC_ORPHAN: ${subhole} is paid before it is opened`);
      if (paidSubholes.has(subhole)) errors.push(`subhole ${subhole} is paid more than once`);
      paidSubholes.add(subhole);
    }
    const allowedStageDrivers = new Set([contract?.primary_driver, contract?.secondary_driver].filter(Boolean));
    if (allowedStageDrivers.size > 0 && !allowedStageDrivers.has(stage?.primary_driver)) {
      errors.push(`${label}.primary_driver must use the script primary or secondary driver`);
    }

    const draftVersions = Array.isArray(stage?.draft_versions) ? stage.draft_versions : [];
    const hasDraft = draftVersions.length > 0;
    anyDraft ||= hasDraft;
    if (ACTIVE_STAGE_STATES.has(stage?.status)) activeCount += 1;

    if (stage?.status === "planned" && (hasDraft || present(stage.locked_text) || present(stage.locked_hash))) {
      errors.push(`E_PREMATURE_FUTURE_DRAFT: ${label} is planned but contains prose`);
    }

    if (hasDraft) {
      const activationEvent = requireEvent(stage.activation_event_id, "stage_activate", stage.id, `${label}.activation_event_id`);
      if (activationEvent && stage.lock_event_id === stage.activation_event_id) errors.push(`E_LOCK_ADVANCE_CONFLATED: ${label}`);
      validateRationale(errors, stage, label);
      if (!Array.isArray(stage.evidence_ids) || stage.evidence_ids.length === 0) errors.push(`${label}.evidence_ids must not be empty once drafting starts`);
      for (const [versionIndex, version] of draftVersions.entries()) {
        const versionLabel = `${label}.draft_versions[${versionIndex}]`;
        if (!present(version?.text)) errors.push(`${versionLabel}.text is required`);
        if (version?.actor !== "ai" && version?.actor !== "creator") errors.push(`${versionLabel}.actor must be ai or creator`);
        requireString(errors, version?.reason, `${versionLabel}.reason`);
        if (present(version?.text) && version?.content_hash !== sha256(version.text)) errors.push(`${versionLabel}.content_hash does not match text`);
        if (versionIndex > 0 && version?.parent_hash !== draftVersions[versionIndex - 1]?.content_hash) {
          errors.push(`${versionLabel}.parent_hash must match the previous draft version`);
        }
      }
    }

    const retainsLockedText = stage?.status === "locked" || stage?.status === "needs_revalidation";
    if (retainsLockedText) {
      requireString(errors, stage.locked_text, `${label}.locked_text`);
      requireString(errors, stage.locked_hash, `${label}.locked_hash`);
      const lockEvent = requireEvent(stage.lock_event_id, "stage_lock", stage.id, `${label}.lock_event_id`);
      if (present(stage.locked_text) && stage.locked_hash !== sha256(stage.locked_text)) errors.push(`E_LOCKED_SPAN_MUTATED: ${label}`);
      if (lockEvent && lockEvent.content_hash !== stage.locked_hash) errors.push(`E_LOCKED_SPAN_MUTATED: ${label} lock event hash differs`);
      if (stage.lock_event_id === stage.activation_event_id) errors.push(`E_LOCK_ADVANCE_CONFLATED: ${label}`);
    }

    const lifecycleStarted = hasDraft || retainsLockedText || ACTIVE_STAGE_STATES.has(stage?.status);
    if (lifecycleStarted) {
      const upstream = new Map((Array.isArray(stage.upstream_locked_hashes) ? stage.upstream_locked_hashes : []).map((item) => [item.stage_id, item.hash]));
      for (let priorIndex = 0; priorIndex < index; priorIndex += 1) {
        const prior = stages[priorIndex];
        if (!present(prior.locked_hash)) {
          errors.push(`E_ADVANCE_NOT_APPROVED: ${label} started before ${prior.id} was locked`);
        } else if (upstream.get(prior.id) !== prior.locked_hash) {
          errors.push(`E_CREATOR_DECISION_NOT_PROPAGATED: ${label} has stale upstream hash for ${prior.id}`);
        }
      }
    }
  }

  if (activeCount > 1) errors.push("only one stage may be active or awaiting_creator");
  if (anyDraft && contract?.status !== "locked") errors.push("E_ADVANCE_NOT_APPROVED: drafting requires a locked contract");
  if (anyDraft && stageMap?.status !== "locked") errors.push("E_ADVANCE_NOT_APPROVED: drafting requires a locked stage map");
  if (stages.length > 0 && !["open", "raise_stakes"].includes(stages[0]?.main_hole_relation)) {
    errors.push("the first stage must open or raise the main hole");
  }

  const assemblyRequired = FINAL_RUN_STATES.has(run?.status) || run?.assembly !== undefined;
  if (assemblyRequired) {
    const allLocked = stages.length > 0 && stages.every((stage) => stage.status === "locked");
    if (!allLocked) errors.push("E_DOWNSTREAM_STALE: assembly requires every stage to be locked");
    if (stages.at(-1)?.main_hole_relation !== "pay") errors.push("the final stage must pay the main hole");
    for (const subhole of openedSubholes) {
      if (!paidSubholes.has(subhole)) errors.push(`E_SUBHOLE_SEMANTIC_ORPHAN: ${subhole} is never paid`);
    }
    const expectedText = stages.map((stage) => stage.locked_text ?? "").join("\n\n");
    if (run?.assembly?.text !== expectedText) errors.push("E_ASSEMBLY_HASH_MISMATCH: assembly must contain exact locked text only");
    if (run?.assembly?.content_hash !== sha256(expectedText)) errors.push("E_ASSEMBLY_HASH_MISMATCH: assembly hash is stale");
  }

  const audits = Array.isArray(run?.audits) ? run.audits : [];
  const retentionAudit = audits.find((item) => item?.type === "retention");
  const commentShareAudit = audits.find((item) => item?.type === "comment_share");
  if (retentionAudit) validateRetentionAudit(errors, retentionAudit, run, stages);
  if (commentShareAudit) validateCommentShareAudit(errors, commentShareAudit, run, stages);

  if (AUDITED_RUN_STATES.has(run?.status)) {
    if (!Array.isArray(run?.audits)) errors.push("audits must be an array for an audited candidate");
    for (const requiredType of REQUIRED_AUDITS) {
      const audit = audits.find((item) => item?.type === requiredType);
      if (!audit) {
        errors.push(`missing required ${requiredType} audit`);
      } else {
        if (audit.verdict !== "pass") errors.push(`${requiredType} audit did not pass`);
        if (audit.input_content_hash !== run?.assembly?.content_hash) errors.push(`E_STALE_AUDIT: ${requiredType}`);
      }
    }
  }

  if (run?.status === "PUBLISH_READY") {
    const ack = run?.final_ack;
    const event = requireEvent(ack?.event_id, "final_ack", "final", "final_ack.event_id");
    if (!ack || ack.content_hash !== run?.assembly?.content_hash) errors.push("final_ack.content_hash must match assembly");
    if (event && event.content_hash !== run?.assembly?.content_hash) errors.push("final ack event hash must match assembly");
  }

  return { valid: errors.length === 0, errors };
}

function parseFileArg(argv) {
  const index = argv.indexOf("--file");
  return index >= 0 ? argv[index + 1] : undefined;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const file = parseFileArg(process.argv.slice(2));
  if (!file) {
    console.error("Usage: validate-progressive-run.mjs --file <03-progressive-run.v2.json>");
    process.exitCode = 2;
  } else {
    try {
      const run = JSON.parse(fs.readFileSync(file, "utf8"));
      const result = validateProgressiveRun(run);
      if (result.valid) {
        console.log("Progressive run is valid");
      } else {
        for (const error of result.errors) console.error(error);
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(`Unable to validate progressive run: ${error.message}`);
      process.exitCode = 2;
    }
  }
}
