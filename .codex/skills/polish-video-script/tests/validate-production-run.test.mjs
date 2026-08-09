import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { validateBookReviewLog, validateFactPoolPersisted, validateFinalScript, validateProductionRun, validateTransplantContract } from "../scripts/validate-production-run.mjs";
import { renderTransplantMap } from "../scripts/render-transplant-map.mjs";
import { computeWashMetrics } from "../scripts/scan-wash-overlap.mjs";

const validatorPath = fileURLToPath(
  new URL("../scripts/validate-production-run.mjs", import.meta.url)
);

function validRun() {
  return {
    mode: "generate",
    metrics_contract: {
      target_platform: "bilibili",
      target_duration_seconds: 480,
      target_3s_retention: 0.75,
      target_5s_completion: 0.55,
      target_overall_completion: 0.45,
      primary_metric: "3s_retention"
    },
    audience_contract: {
      primary_human_switches: ["好奇心", "刺激寻求"],
      secondary_human_switches: ["优越感满足"],
      story_paradox: "李敢伤了大将军却没有立刻被带走，后来仍进了猎场。",
      viewer_pursuit: "看清这场冲突怎样一步步把李敢留在最后的箭前。",
      payoff_experience: "观众能复述三个人对同一场冲突的不同处理。",
      source_boundary_role: "guard"
    },
    information_gap_contract: {
      creator_owned: [
        {
          beat_opened: "B1",
          withheld_answer: "程序未启动会留下什么后果",
          payoff_beat: "B3"
        }
      ],
      viewer_owned: [],
      intentional_omissions: [
        {
          omitted: "与中心机制无关的完整战功履历",
          reason: "not needed for the viewer's pursuit"
        }
      ],
      closure_budget: {
        paragraph_summaries: 0,
        explanatory_tails: 0,
        final_answers: 1
      }
    },
    narrator_persona: {
      id: "rural-middle-storyteller-v1",
      stance: "我认定把军中冲突藏进关系网，是把代价留给更弱的人承担。",
      stance_fact_ids: ["F1"],
      stance_reveal_beat: "B1",
      false_moral_frame: "不追究只是一种宽厚。",
      rebuttal: "不进程序的代价，会由仍留在局里的人承担。",
      moral_geometry: {
        anger_target: "把应公开裁断的冲突留在关系网里的处理",
        compassion_target: "被旧案与随驾关系夹住的当事人",
        silent_party: "最终承担生命风险的李敢"
      },
      situation_restore: {
        information_gap: "当事人不知道后来会在猎场遇到什么。",
        time_pressure: "军中冲突当下需要立刻处置。",
        cost_of_refusal: "公开程序会牵动旧案和关系。",
        environmental_pull: "所有人都被天子与军中等级约束。"
      },
      temperature_arc: [
        { beat: "B1", temperature: "cold", job: "拆开宽厚的表面说法" },
        { beat: "B2", temperature: "warm", job: "还原人物被关系夹住的处境" },
        { beat: "B3", temperature: "hot", job: "点出代价最终落在谁身上" }
      ]
    },
    genre: { primary: "historical_mechanism" },
    truth_promise: {
      question_type: "mechanism",
      one_sentence_promise: "一份未上奏的处置，怎样改变了后来能发生什么。",
      question_engine: {
        text: "为什么这场冲突没有进入天子的正式裁断？",
        answerable_by: ["F1", "F2"]
      },
      answer: {
        text: "正式程序没有启动，李敢没有立刻被逐出随驾的关系网。",
        status: "source_supported",
        claim_ids: ["F1", "F2"]
      },
      viewer_stake: {
        person_at_risk: "李敢",
        concrete_loss: "官职与性命",
        why_it_cannot_be_shrugged_off: "一次军中冲突没有被带进天子面前。"
      },
      source_claims: [
        { id: "F1", fact: "关键处置没有进入正式程序。", source: "史料" },
        { id: "F2", fact: "李敢仍能随驾。", source: "史料" },
        { id: "F3", fact: "此前的军功与官职改变了相关人物的位置。", source: "史料" },
        { id: "F4", fact: "卫青没有将冲突上报天子。", source: "史料" },
        { id: "F5", fact: "李敢之父旧事影响了军中关系。", source: "史料" },
        { id: "F6", fact: "甘泉宫会猎是当年预定行程。", source: "史料" },
        { id: "F7", fact: "霍去病与卫青有甥舅关系。", source: "史料" },
        { id: "F8", fact: "军中议郎曾主张按律处置。", source: "史料" },
        { id: "F9", fact: "处置结果未见于正式诏令。", source: "史料" }
      ],
      detail_map: {
        slow_scenes: [
          {
            id: "camp_command",
            decision_or_revelation: "是否当场拿下李敢",
            target_chars: 160,
            scene_carriers: ["帐中将校的反应", "卫青制止动作"]
          },
          {
            id: "hunting_ground",
            decision_or_revelation: "甘泉宫会猎的最终处置",
            target_chars: 180,
            scene_carriers: ["鹿群与骑手", "霍去病张弓"]
          }
        ],
        compressed_fact_ids: ["F3"],
        discard_list: ["与问题无关的完整战功履历"]
      }
    },
    retention: {
      structure_shell: "suspense_cause",
      open_loop: "为什么程序没有启动？",
      open_loop_id: "Q1",
      opening: {
        first_image_or_action: "军帐中有人要拿李敢",
        known_after_opening: "卫青没有公开追究李敢",
        withheld_until: "这件事怎样改变李敢仍能随驾的处境",
        forbidden_information_order: "官方说法再由史家否定的对撞开头",
        opening_mode: "result_then_rewind",
        action_status: "result_shown",
        reader_must_know: [
          "李敢正面临公开裁断",
          "卫青没有公开追究他",
          "接下来要倒回这次选择的来处"
        ],
        bridge_to_next_beat: "先说这场冲突为什么会落到卫青帐中。"
      },
      stake: { who: "李敢", loss: "官职与性命", why_now: "他仍在天子身边活动" },
      payoff_fact_id: "F2",
      middle_turns: [
        {
          fact_id: "F1",
          reader_belief_before: "冲突会立刻进入正式裁断",
          reader_belief_after: "正式裁断没有发生",
          next_question: "这会怎样改变李敢的处境？"
        },
        {
          fact_id: "F3",
          reader_belief_before: "此前经历只是履历",
          reader_belief_after: "它解释了当时人物身处的关系和位置",
          next_question: "谁仍能决定最后的处置？"
        }
      ],
      ending: { answer_sentence_fact_id: "F2", charged_image: "猎场", hard_stop_word: "猎场" },
      rhetorical_budget: {
        standalone_hammer_beat_id: "B3",
        max_meta_preview_labels: 0,
        max_cheap_surprise_adverbs: 1
      }
    },
    author_route: {
      reasoning_module: "bohai",
      voice_palette: { narrator_attention: ["文书", "猎场"] }
    },
    beats: [
      {
        id: "B1",
        retention_job: "open",
        fact_ids: ["F1"],
        reader_belief_change: "读者知道这场冲突没有立刻进入正式裁断。",
        state_change: {
          actor: "卫青",
          information_or_resource_changed: "没有送出公开追究的文书",
          option_or_risk_changed: "李敢没有立即进入天子裁断"
        },
        detail_mode: "slow_scene",
        detail_ref: "camp_command",
        disclosure: { kind: "first", fact_ids: ["F1"], new_meaning: "" },
        reader_relay: {
          question_in_id: "Q1",
          question_in: "为什么程序没有启动？",
          facts_known_before: ["李敢面临公开裁断"],
          fact_ids_disclosed_here: ["F1"],
          resolution: "answer",
          question_out_id: "Q2",
          question_out: "没有公开裁断，李敢会失去什么或保住什么？",
          bridge_to_next: "要看此前关系和位置给他留下了什么。"
        },
        next_beat_forced_by: "必须解释这个选择留下了什么后果",
        persona_temperature: "cold",
        persona_job: "拆开不追究等于宽厚的表面说法",
        stance_relation: "reveal"
      },
      {
        id: "B2",
        retention_job: "turn",
        fact_ids: ["F3"],
        reader_belief_change: "读者知道履历只作为当时位置的条件，不替代因果。",
        state_change: {
          actor: "相关人物",
          information_or_resource_changed: "此前军功塑造了可用关系",
          option_or_risk_changed: "冲突仍在关系网内而非案牍内处理"
        },
        detail_mode: "compressed_fact",
        detail_ref: "F3",
        disclosure: { kind: "first", fact_ids: ["F3"], new_meaning: "" },
        reader_relay: {
          question_in_id: "Q2",
          question_in: "没有公开裁断，李敢会失去什么或保住什么？",
          facts_known_before: ["F1"],
          fact_ids_disclosed_here: ["F3"],
          resolution: "answer",
          question_out_id: "Q3",
          question_out: "谁仍能决定最后的处置？",
          bridge_to_next: "再回到李敢仍能随驾的结果。"
        },
        next_beat_forced_by: "需要回到李敢还能随驾这一结果",
        persona_temperature: "warm",
        persona_job: "还原军中人物被关系和程序夹住的处境",
        stance_relation: "restore_context"
      },
      {
        id: "B3",
        retention_job: "payoff",
        fact_ids: ["F2"],
        reader_belief_change: "读者知道程序未启动如何保留了李敢的行动位置。",
        state_change: {
          actor: "李敢",
          information_or_resource_changed: "仍能随天子出入",
          option_or_risk_changed: "仍会出现在甘泉宫猎场"
        },
        detail_mode: "slow_scene",
        detail_ref: "hunting_ground",
        disclosure: { kind: "first", fact_ids: ["F2"], new_meaning: "" },
        reader_relay: {
          question_in_id: "Q3",
          question_in: "谁仍能决定最后的处置？",
          facts_known_before: ["F1", "F3"],
          fact_ids_disclosed_here: ["F2"],
          resolution: "answer",
          question_out_id: "RESOLVED",
          question_out: "开头的程序问题已经由李敢仍能随驾这一结果回答。",
          bridge_to_next: "结尾兑现。"
        },
        next_beat_forced_by: "结尾兑现",
        persona_temperature: "hot",
        persona_job: "指出公开程序失效后代价落在李敢身上",
        stance_relation: "name_cost"
      }
    ]
  };
}

test("accepts a complete production run", () => {
  assert.deepEqual(validateProductionRun(validRun()), { valid: true, errors: [] });
});

test("rejects a missing information-gap contract", () => {
  const run = validRun();
  delete run.information_gap_contract;
  const result = validateProductionRun(run);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /information_gap_contract is required/);
});

test("requires a viewer-owned gap when optimizing comments", () => {
  const run = validRun();
  run.metrics_contract.target_comment_rate = 0.01;
  run.metrics_contract.comment_strategy = "resonance";
  const result = validateProductionRun(run);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /comment optimization requires at least one viewer-owned information gap/);
});

test("rejects invalid metrics contract values", () => {
  const run = validRun();
  run.metrics_contract.target_3s_retention = 1.5;
  run.metrics_contract.primary_metric = "watch_time";
  const result = validateProductionRun(run);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /target_3s_retention must be a number between 0 and 1/);
  assert.match(result.errors.join("\n"), /primary_metric must be/);
});

function validParagraphLocks() {
  return [
    {
      paragraph_index: 1,
      beat_id: "B1",
      listener_knows: "李敢正在面临军中处置。",
      listener_asks: "为什么程序没有启动？",
      new_contribution: "霍去病射杀李敢这一结果与程序未启动的事实",
      question_in_id: "Q1",
      question_out_id: "Q2",
      fact_ids_used: ["F1"],
      first_sentence: "公元前117年，霍去病在甘泉宫射杀了李敢。",
      bridge_quote: "先说这场冲突为什么会落到卫青帐中。"
    },
    {
      paragraph_index: 2,
      beat_id: "B2",
      listener_knows: "卫青没有把冲突送入正式程序。",
      listener_asks: "李敢保住了什么？",
      new_contribution: "此前军功如何改变了人物在关系网中的位置",
      question_in_id: "Q2",
      question_out_id: "Q3",
      fact_ids_used: ["F3"],
      first_sentence: "此前的军功把人留在关系网里。",
      bridge_quote: "再回到李敢仍能随驾的结果。"
    },
    {
      paragraph_index: 3,
      beat_id: "B3",
      listener_knows: "前两段已经解释了程序为什么没有启动。",
      listener_asks: "谁仍能决定最后处置？",
      new_contribution: "payoff",
      question_in_id: "Q3",
      question_out_id: "RESOLVED",
      fact_ids_used: ["F2"],
      first_sentence: "李敢仍能随驾。"
    }
  ];
}

// Minimal fixture satisfying validateFactPoolPersisted's 40-fact floor. CLI-level tests write
// this alongside production-run.json because the persistence gate now requires it — a real run
// would have a populated pool by the time --script is supplied.
function writeFactPoolFixture(directory) {
  const facts = Array.from(
    { length: 45 },
    (_, i) => "### F" + (i + 1) + " [Score: 2] [Source: fixture]\n测试事实第" + (i + 1) + "条。"
  ).join("\n\n");
  fs.writeFileSync(path.join(directory, "02-fact-pool.md"), "## Act 1\n\n" + facts + "\n");
}

function validFinalScript() {
  return [
    "公元前117年，霍去病在甘泉宫射杀了李敢。先说这场冲突为什么会落到卫青帐中。",
    "此前的军功把人留在关系网里。再回到李敢仍能随驾的结果。",
    "李敢仍能随驾。"
  ].join("\n\n");
}

test("accepts final prose when it obeys opening and paragraph locks", () => {
  const run = validRun();
  run.retention.opening.script_required_patterns = ["公元前117年，霍去病在甘泉宫射杀了李敢"];
  assert.deepEqual(validateFinalScript(run, validFinalScript(), validParagraphLocks()), []);
});

test("rejects a final opening that withholds a contracted result", () => {
  const run = validRun();
  run.retention.opening.script_required_patterns = ["公元前117年，霍去病在甘泉宫射杀了李敢"];
  const script = validFinalScript().replace("公元前117年，霍去病在甘泉宫射杀了李敢。", "霍去病举弓，箭头对准李敢。");
  const errors = validateFinalScript(run, script, validParagraphLocks());
  assert.match(errors.join("\n"), /final opening must match required pattern/);
});

test("rejects a final paragraph that names a future entity", () => {
  const run = validRun();
  run.retention.opening.script_required_patterns = ["公元前117年，霍去病在甘泉宫射杀了李敢"];
  run.truth_promise.source_claims[1].entity_aliases = ["李广"];
  const script = validFinalScript().replace("此前的军功", "李广的军功");
  const errors = validateFinalScript(run, script, validParagraphLocks());
  assert.match(errors.join("\n"), /names 李广 before source claim F2 is disclosed/);
});

test("CLI reports PASS for a complete production run", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "polish-video-script-"));
  const file = path.join(directory, "production-run.json");
  fs.writeFileSync(file, JSON.stringify(validRun()));

  try {
    const result = spawnSync(process.execPath, [validatorPath, "--file", file], { encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /PASS production run/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects an unresolved non-investigation promise", () => {
  const run = validRun();
  run.truth_promise.question_type = "motive";
  run.truth_promise.answer.status = "unresolved";
  const result = validateProductionRun(run);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /unresolved promise/);
});

test("rejects a run with no declared audience human switch", () => {
  const run = validRun();
  run.audience_contract.primary_human_switches = [];
  const result = validateProductionRun(run);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /one or two switches/);
});

test("rejects a run with no accountable narrator stance", () => {
  const run = validRun();
  run.narrator_persona.stance = "卫青很复杂。";
  const result = validateProductionRun(run);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /must begin with 我认定/);
});

test("rejects a narrator that delays judgment until after the first third", () => {
  const run = validRun();
  run.narrator_persona.stance_reveal_beat = "B3";
  run.beats[0].stance_relation = "prove";
  run.beats[2].stance_relation = "reveal";
  const result = validateProductionRun(run);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /first third/);
});

test("rejects a warm persona beat before the narrator has taken a stance", () => {
  const run = validRun();
  run.narrator_persona.stance_reveal_beat = "B2";
  run.beats[0].stance_relation = "prove";
  run.beats[1].stance_relation = "reveal";
  run.beats[0].persona_temperature = "warm";
  run.narrator_persona.temperature_arc[0].temperature = "warm";
  const result = validateProductionRun(run);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /warm persona beat must not precede/);
});

test("rejects archive-first framing outside an investigation", () => {
  const run = validRun();
  run.audience_contract.source_boundary_role = "engine";
  const result = validateProductionRun(run);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /only an investigation genre/);
});

test("rejects a slow scene without a lived-scene budget", () => {
  const run = validRun();
  run.truth_promise.detail_map.slow_scenes[0].target_chars = 80;
  run.truth_promise.detail_map.slow_scenes[0].scene_carriers = ["卫青制止动作"];
  const result = validateProductionRun(run);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /target_chars/);
  assert.match(result.errors.join("\n"), /scene_carriers/);
});

test("rejects an undeclared fact used as the answer", () => {
  const run = validRun();
  run.truth_promise.answer.claim_ids = ["F99"];
  const result = validateProductionRun(run);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /undeclared source claim F99/);
});

test("rejects a missing discard list", () => {
  const run = validRun();
  run.truth_promise.detail_map.discard_list = [];
  const result = validateProductionRun(run);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /discard_list must contain at least 1 item/);
});

test("accepts a run with no compressed facts when every non-core fact is discarded", () => {
  const run = validRun();
  run.truth_promise.detail_map.compressed_fact_ids = [];
  const result = validateProductionRun(run);
  assert.deepEqual(result, { valid: true, errors: [] });
});

test("rejects a non-array compressed fact list", () => {
  const run = validRun();
  run.truth_promise.detail_map.compressed_fact_ids = "F3";
  const result = validateProductionRun(run);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /compressed_fact_ids must be an array/);
});

test("rejects biography material disguised as a causal phase", () => {
  const run = validRun();
  run.beats[1].phase_kind = "biography";
  const result = validateProductionRun(run);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /disguised as a causal phase/);
});

test("rejects a promised slow scene that the beat map never uses", () => {
  const run = validRun();
  run.beats[2].detail_ref = "camp_command";
  const result = validateProductionRun(run);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /hunting_ground must map to exactly one beat/);
});

test("rejects an interrupted opening that leaves the listener without orientation", () => {
  const run = validRun();
  run.retention.opening.opening_mode = "scene_return";
  run.retention.opening.action_status = "action_interrupted";
  run.retention.opening.reader_must_know = ["有人正在瞄准李敢"];
  run.retention.opening.bridge_to_next_beat = "";
  const result = validateProductionRun(run);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /reader_must_know must contain at least 3 items/);
  assert.match(result.errors.join("\n"), /bridge_to_next_beat is required/);
});

test("rejects a beat that drops the reader question relay", () => {
  const run = validRun();
  run.beats[1].reader_relay.question_in_id = "Q9";
  const result = validateProductionRun(run);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /question_in_id "Q9" does not continue/);
});

test("omitted relay ids are derived instead of demanded", () => {
  // The ids are bookkeeping: a carry keeps the incoming id, an answer opens the next. Making
  // the author hand-align them across every beat proved nothing about the script.
  const run = validRun();
  for (const beat of run.beats) {
    delete beat.reader_relay.question_in_id;
    delete beat.reader_relay.question_out_id;
  }
  const result = validateProductionRun(run);
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

test("the minimal beat contract drops planning prose the author never reads", () => {
  const run = validRun();
  for (const beat of run.beats) {
    delete beat.reader_belief_change;
    delete beat.state_change;
    delete beat.next_beat_forced_by;
    delete beat.reader_relay.facts_known_before;
  }
  const result = validateProductionRun(run);
  assert.deepEqual(result.errors, []);
});

test("optional beat fields are still validated when supplied", () => {
  const run = validRun();
  run.beats[1].state_change = { actor: "", information_or_resource_changed: "x", option_or_risk_changed: "y" };
  const result = validateProductionRun(run);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /state_change\.actor is required/);
});

test("rejects a stance that relies on a fact disclosed after its reveal beat", () => {
  const run = validRun();
  run.narrator_persona.stance_fact_ids = ["F2"];
  const result = validateProductionRun(run);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /stance_fact_ids must be disclosed no later than/);
});

function validBookReviewLog(paragraphCount = 3) {
  const lines = [];
  for (let index = 1; index <= paragraphCount; index += 1) {
    lines.push(JSON.stringify({
      finding: "book_review",
      paragraph_index: index,
      beat_id: "B" + index,
      meaning: "这一段要表达的意思 " + index,
      retrieved: [{ ref: "动作分解", locator: "book-usage-cards.md#动作" }],
      gap: "基线是抽象压缩句，无动作无声音",
      rewrite_action: "full-reproduce",
      kept_sentences: [],
      verdict: "rewritten"
    }));
  }
  return lines.join("\n") + "\n";
}

test("accepts a complete book_review log", () => {
  const errors = [];
  validateBookReviewLog(errors, validBookReviewLog(), 3, "generate");
  assert.deepEqual(errors, []);
});

test("rejects a paragraph with no book_review record", () => {
  const errors = [];
  validateBookReviewLog(errors, validBookReviewLog(2), 3, "generate");
  assert.match(errors.join("\n"), /book_review paragraph 3 is missing/);
});

test("rejects a book_review record that skipped the meaning statement", () => {
  const lines = validBookReviewLog().trim().split("\n");
  const record = JSON.parse(lines[1]);
  record.meaning = "";
  lines[1] = JSON.stringify(record);
  const errors = [];
  validateBookReviewLog(errors, lines.join("\n"), 3, "generate");
  assert.match(errors.join("\n"), /book_review paragraph 2\.meaning is required/);
});

test("rejects empty retrieval without a no-footing explanation", () => {
  const record = JSON.parse(validBookReviewLog(1));
  record.retrieved = [];
  const errors = [];
  validateBookReviewLog(errors, JSON.stringify(record), 1, "generate");
  assert.match(errors.join("\n"), /no_footing/);
});

test("rejects a pass verdict on a paragraph with a diagnosed gap", () => {
  const record = JSON.parse(validBookReviewLog(1));
  record.rewrite_action = "pass";
  const errors = [];
  validateBookReviewLog(errors, JSON.stringify(record), 1, "generate");
  assert.match(errors.join("\n"), /diagnosed a gap but passed/);
});

test("requires per-sentence reasons for kept baseline sentences in polish mode", () => {
  const record = JSON.parse(validBookReviewLog(1));
  record.kept_sentences = [{ sentence: "他是私生子。", reason: "" }];
  const errors = [];
  validateBookReviewLog(errors, JSON.stringify(record), 1, "polish");
  assert.match(errors.join("\n"), /kept_sentences\[0\]\.reason is required/);
});

test("CLI validates book_review records against paragraph locks", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "polish-video-script-"));
  const run = validRun();
  run.retention.opening.script_required_patterns = ["公元前117年，霍去病在甘泉宫射杀了李敢"];
  const file = path.join(directory, "production-run.json");
  const scriptFile = path.join(directory, "final.md");
  const locksFile = path.join(directory, "paragraph-locks.jsonl");
  const auditFile = path.join(directory, "audit-log.jsonl");
  fs.writeFileSync(file, JSON.stringify(run));
  fs.writeFileSync(scriptFile, validFinalScript());
  fs.writeFileSync(locksFile, validParagraphLocks().map((lock) => JSON.stringify(lock)).join("\n") + "\n");
  writeFactPoolFixture(directory);

  try {
    fs.writeFileSync(auditFile, validBookReviewLog());
    const pass = spawnSync(process.execPath, [validatorPath, "--file", file, "--script", scriptFile, "--paragraph-locks", locksFile, "--audit-log", auditFile], { encoding: "utf8" });
    assert.equal(pass.status, 0);
    assert.match(pass.stdout, /PASS production run/);

    fs.writeFileSync(auditFile, validBookReviewLog(2));
    const missing = spawnSync(process.execPath, [validatorPath, "--file", file, "--script", scriptFile, "--paragraph-locks", locksFile, "--audit-log", auditFile], { encoding: "utf8" });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /book_review paragraph 3 is missing/);

    const noAudit = spawnSync(process.execPath, [validatorPath, "--file", file, "--script", scriptFile, "--paragraph-locks", locksFile], { encoding: "utf8" });
    assert.equal(noAudit.status, 1);
    assert.match(noAudit.stderr, /--audit-log is required/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects a paragraph lock without new_contribution", () => {
  const run = validRun();
  run.retention.opening.script_required_patterns = ["公元前117年，霍去病在甘泉宫射杀了李敢"];
  const locks = validParagraphLocks();
  delete locks[1].new_contribution;
  const errors = validateFinalScript(run, validFinalScript(), locks);
  assert.match(errors.join("\n"), /paragraph lock 2\.new_contribution is required/);
});

test("rejects a run whose fact supply cannot cover the target duration", () => {
  const run = validRun();
  run.metrics_contract.target_duration_seconds = 1800;
  const result = validateProductionRun(run);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /fact budget/);
  assert.match(result.errors.join("\n"), /shorten the duration or add material/);
});

// --- Transplant-mode fixtures -------------------------------------------------

const TRANSPLANT_RAW = [
  "韩信点兵，多多益善。刘邦问他能带多少兵，他说臣多多益善耳。",
  "帐下诸将无不叹服，都以为统帅之才莫过于此。",
  "这一段讲的是统帅与君主之间的试探与分寸。",
  "结尾落在兵仙两个字上，回扣开头的问答。"
].join("\n\n");

const TRANSPLANT_COMMENTS = [
  "这条讲得太透了，原来统帅最怕的是君主猜忌",
  "兵仙结局那一下真的头皮发麻"
].join("\n");

function validAutopsy() {
  return {
    original_meta: {
      source_ownership: "external",
      outbreak_time: "2026-05",
      source_ref: "douyin://example-video"
    },
    comment_data: { status: "provided" },
    shell_identified: "suspense_cause",
    opening_mechanism: {
      hook_type: "result-first",
      information_order: "先给结果再倒回来路",
      withhold: "处置者身份",
      first_12_15_char_class: "人+代价",
      rhythm_profile: "短句开场",
      promise_structure: "开头提问结尾回答",
      opening_mode: "result_then_rewind"
    },
    acts: [
      { act_id: "A1", function: "冲突", temperature: "cold", hook_mechanism: "结果先行+倒带", evidence_quote: "韩信点兵，多多益善。", summary: "开头给出结果并倒带" },
      { act_id: "A2", function: "场景", temperature: "warm", hook_mechanism: "帐内对峙慢场景", evidence_quote: "帐下诸将无不叹服", summary: "场景展开" },
      { act_id: "A3", function: "收束", temperature: "hot", hook_mechanism: "点名代价", evidence_quote: "结尾落在兵仙两个字上", summary: "收束回答开头" }
    ],
    injuries: [],
    fingerprint_blocklist: [{ phrase: "兵仙两个字", note: "原作者标志性落点说法" }],
    why_it_works: {
      hypotheses: [
        { claim: "结果先行让前 5 秒立住", load_bearing: true, status: "comment_verified", comment_evidence: ["这条讲得太透了"] }
      ]
    },
    fit_assessment: {
      temperature_match: "新主题同为 cold→warm→hot",
      density_match: "密度可承",
      audience_prior: "同受众",
      stakes_magnitude: "同为性命级",
      fact_capacity_ratio: "新素材 9 条事实可撑 480s",
      verdict: "fit",
      notes: "无"
    }
  };
}

function validTransplantRun() {
  const run = validRun();
  run.mode = "transplant";
  run.mode_resolution = {
    mode: "transplant",
    source_ownership: "external",
    rationale: "用户提供了爆款转录稿与新主题素材",
    user_declared: true
  };
  run.retention.opening.script_required_patterns = ["公元前117年，霍去病在甘泉宫射杀了李敢"];
  run.retention.opening.selected_text = "公元前117年，霍去病在甘泉宫射杀了李敢。";
  const transplantFields = [
    { original_act_id: "A1", inherited: { function: "冲突", temperature: "cold", hook_mechanism: "结果先行+倒带" }, repair: "" },
    { original_act_id: "A2", inherited: { function: "场景", temperature: "warm", hook_mechanism: "帐内对峙慢场景" }, repair: "" },
    { original_act_id: "A3", inherited: { function: "收束", temperature: "hot", hook_mechanism: "点名代价" }, repair: "" }
  ];
  run.beats.forEach((beat, index) => {
    beat.transplant = transplantFields[index];
  });
  return run;
}

function validTransplantBookReviewLog(paragraphCount = 3) {
  const lines = [];
  for (let index = 1; index <= paragraphCount; index += 1) {
    lines.push(JSON.stringify({
      finding: "book_review",
      paragraph_index: index,
      beat_id: "B" + index,
      meaning: "这一段要表达的意思 " + index,
      retrieved: [{ ref: "动作分解", locator: "book-usage-cards.md#动作" }],
      gap: "基线是抽象压缩句，无动作无声音",
      rewrite_action: "full-reproduce",
      kept_sentences: [],
      benchmark: { original_locus: "A" + index, verdict: "ours_better", borrowed_move: "" },
      verdict: "rewritten"
    }));
  }
  return lines.join("\n") + "\n";
}

function setupTransplantFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "polish-transplant-"));
  const run = validTransplantRun();
  const autopsy = validAutopsy();
  const paths = {
    dir: directory,
    run: path.join(directory, "production-run.json"),
    script: path.join(directory, "final.md"),
    locks: path.join(directory, "paragraph-locks.jsonl"),
    audit: path.join(directory, "audit-log.jsonl"),
    raw: path.join(directory, "00-original-source.raw.txt"),
    autopsy: path.join(directory, "00-autopsy.json"),
    comments: path.join(directory, "comments.txt"),
    map: path.join(directory, "04-transplant-map.md")
  };
  fs.writeFileSync(paths.run, JSON.stringify(run, null, 2));
  fs.writeFileSync(paths.script, validFinalScript());
  fs.writeFileSync(paths.locks, validParagraphLocks().map((lock) => JSON.stringify(lock)).join("\n") + "\n");
  fs.writeFileSync(paths.raw, TRANSPLANT_RAW);
  fs.writeFileSync(paths.autopsy, JSON.stringify(autopsy, null, 2));
  fs.writeFileSync(paths.comments, TRANSPLANT_COMMENTS);
  fs.writeFileSync(paths.map, renderTransplantMap(autopsy, run));
  writeFactPoolFixture(directory);
  const wash = computeWashMetrics(validFinalScript(), TRANSPLANT_RAW);
  const auditText = validTransplantBookReviewLog() +
    JSON.stringify({ finding: "wash_overlap", overlap_ratio: wash.overlapRatio, longest_run: wash.longestRun, verdict: "pass" }) + "\n" +
    JSON.stringify({
      finding: "opening_fidelity",
      lane: "external",
      candidates: [
        {
          text: "公元前117年，霍去病在甘泉宫射杀了李敢。",
          fidelity: { hook_type: "inherit", withhold: "deviate: 新稿中段必须揭示，接力链需要" },
          skeleton_borrow: ["韩信点兵，多多益善。"]
        }
      ],
      selected_index: 0,
      selected_text: "公元前117年，霍去病在甘泉宫射杀了李敢。"
    }) + "\n";
  fs.writeFileSync(paths.audit, auditText);
  return paths;
}

function runTransplantValidator(paths, spawnOptions = {}) {
  return spawnSync(process.execPath, [
    validatorPath,
    "--file", paths.run,
    "--script", paths.script,
    "--paragraph-locks", paths.locks,
    "--audit-log", paths.audit,
    "--raw", paths.raw,
    "--autopsy", paths.autopsy,
    "--comments", paths.comments
  ], { encoding: "utf8", ...spawnOptions });
}

test("accepts a complete transplant production run (happy path)", () => {
  const paths = setupTransplantFixture();
  try {
    const result = runTransplantValidator(paths);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PASS production run/);
  } finally {
    fs.rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("transplant mode requires --raw and --autopsy", () => {
  const paths = setupTransplantFixture();
  try {
    const result = spawnSync(process.execPath, [validatorPath, "--file", paths.run], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires --autopsy/);
    assert.match(result.stderr, /requires --raw/);
  } finally {
    fs.rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("F0: a fabricated autopsy evidence quote fails, a punctuation-variant real quote passes", () => {
  const paths = setupTransplantFixture();
  try {
    const autopsy = JSON.parse(fs.readFileSync(paths.autopsy, "utf8"));
    autopsy.acts[0].evidence_quote = "韩信点兵……多多益善！";
    fs.writeFileSync(paths.autopsy, JSON.stringify(autopsy, null, 2));
    const realQuote = runTransplantValidator(paths);
    assert.equal(realQuote.status, 0, realQuote.stderr);

    autopsy.acts[0].evidence_quote = "这句引文在原稿里根本不存在";
    fs.writeFileSync(paths.autopsy, JSON.stringify(autopsy, null, 2));
    const fabricated = runTransplantValidator(paths);
    assert.equal(fabricated.status, 1);
    assert.match(fabricated.stderr, /evidence_quote must be a substring of the raw original source/);
  } finally {
    fs.rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("F0c: comment evidence must be a substring of the comments file", () => {
  const paths = setupTransplantFixture();
  try {
    const autopsy = JSON.parse(fs.readFileSync(paths.autopsy, "utf8"));
    autopsy.why_it_works.hypotheses[0].comment_evidence = ["评论文件里根本没有这一句"];
    fs.writeFileSync(paths.autopsy, JSON.stringify(autopsy, null, 2));
    const result = runTransplantValidator(paths);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /comment_evidence\[0\] must be a substring of the --comments file/);
  } finally {
    fs.rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("F0c: waived comments forbid comment_verified, and all-unverified passes", () => {
  const paths = setupTransplantFixture();
  try {
    const autopsy = JSON.parse(fs.readFileSync(paths.autopsy, "utf8"));
    autopsy.comment_data = { status: "waived", waiver_reason: "用户无法取得评论区数据" };
    fs.writeFileSync(paths.autopsy, JSON.stringify(autopsy, null, 2));
    const verified = runTransplantValidator(paths);
    assert.equal(verified.status, 1);
    assert.match(verified.stderr, /must not be comment_verified/);

    autopsy.why_it_works.hypotheses[0].status = "unverified";
    autopsy.why_it_works.hypotheses[0].comment_evidence = [];
    fs.writeFileSync(paths.autopsy, JSON.stringify(autopsy, null, 2));
    const unverified = runTransplantValidator(paths);
    assert.equal(unverified.status, 0, unverified.stderr);
  } finally {
    fs.rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("mode-laundering: a raw original in the run directory rejects mode polish", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "polish-laundering-"));
  try {
    const run = validRun();
    run.mode = "polish";
    const file = path.join(directory, "production-run.json");
    fs.writeFileSync(file, JSON.stringify(run));
    fs.writeFileSync(path.join(directory, "00-original-source.raw.txt"), TRANSPLANT_RAW);
    const result = spawnSync(process.execPath, [validatorPath, "--file", file], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /anti polish-laundering/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("self-owned claims need evidence under scripts/ or a waiver reason", () => {
  const paths = setupTransplantFixture();
  try {
    const run = JSON.parse(fs.readFileSync(paths.run, "utf8"));
    run.mode_resolution.source_ownership = "self";
    run.mode_resolution.self_owned_evidence = {};
    fs.writeFileSync(paths.run, JSON.stringify(run, null, 2));
    fs.writeFileSync(paths.audit, fs.readFileSync(paths.audit, "utf8").replace('"lane":"external"', '"lane":"self"'));

    const missing = runTransplantValidator(paths);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /self_owned_evidence\.path or \.waiver_reason is required/);

    fs.mkdirSync(path.join(paths.dir, "scripts"));
    fs.writeFileSync(path.join(paths.dir, "scripts", "old-draft.md"), "账号旧稿正文");
    run.mode_resolution.self_owned_evidence = { path: "scripts/old-draft.md" };
    fs.writeFileSync(paths.run, JSON.stringify(run, null, 2));
    const withEvidence = runTransplantValidator(paths, { cwd: paths.dir });
    assert.equal(withEvidence.status, 0, withEvidence.stderr);
  } finally {
    fs.rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("a hand-edited transplant map left column is a hard failure", () => {
  const paths = setupTransplantFixture();
  try {
    const tampered = fs.readFileSync(paths.map, "utf8").replace("冲突 / cold / 结果先行+倒带", "场景 / cold / 结果先行+倒带");
    fs.writeFileSync(paths.map, tampered);
    const result = runTransplantValidator(paths);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /left-column drift/);
  } finally {
    fs.rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("a missing or mismatched wash_overlap record is a hard failure", () => {
  const paths = setupTransplantFixture();
  try {
    const lines = fs.readFileSync(paths.audit, "utf8").trim().split("\n");
    fs.writeFileSync(paths.audit, lines.filter((line) => !line.includes('"wash_overlap"')).join("\n") + "\n");
    const missing = runTransplantValidator(paths);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /missing a wash_overlap record/);

    const forged = JSON.stringify({ finding: "wash_overlap", overlap_ratio: 0.5, longest_run: 99, verdict: "pass" });
    fs.writeFileSync(paths.audit, lines.filter((line) => !line.includes('"wash_overlap"')).join("\n") + "\n" + forged + "\n");
    const mismatched = runTransplantValidator(paths);
    assert.equal(mismatched.status, 1);
    assert.match(mismatched.stderr, /do not match the recomputed scan/);
  } finally {
    fs.rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("opening_fidelity: missing record, unknown inherit parameter, and external-lane overlap all fail", () => {
  const paths = setupTransplantFixture();
  try {
    const lines = fs.readFileSync(paths.audit, "utf8").trim().split("\n");
    const withoutOpening = lines.filter((line) => !line.includes('"opening_fidelity"'));
    fs.writeFileSync(paths.audit, withoutOpening.join("\n") + "\n");
    const missing = runTransplantValidator(paths);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /missing an opening_fidelity record/);

    const record = JSON.parse(lines.find((line) => line.includes('"opening_fidelity"')));
    record.candidates[0].fidelity.nonexistent_param = "inherit";
    fs.writeFileSync(paths.audit, withoutOpening.join("\n") + "\n" + JSON.stringify(record) + "\n");
    const unknownParam = runTransplantValidator(paths);
    assert.equal(unknownParam.status, 1);
    assert.match(unknownParam.stderr, /inherits unknown opening_mechanism parameter nonexistent_param/);

    record.candidates[0].fidelity = { hook_type: "inherit" };
    record.selected_text = "韩信点兵，多多益善，这才是要紧处。";
    fs.writeFileSync(paths.audit, withoutOpening.join("\n") + "\n" + JSON.stringify(record) + "\n");
    const overlap = runTransplantValidator(paths);
    assert.equal(overlap.status, 1);
    assert.match(overlap.stderr, /shares a \d+-char run with the raw original source/);
  } finally {
    fs.rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("kept_sentences matching the raw original are wash failures in transplant mode", () => {
  const paths = setupTransplantFixture();
  try {
    const lines = fs.readFileSync(paths.audit, "utf8").trim().split("\n");
    const record = JSON.parse(lines[0]);
    record.kept_sentences = [{ sentence: "韩信点兵，多多益善。", reason: "想保留原稿金句" }];
    lines[0] = JSON.stringify(record);
    fs.writeFileSync(paths.audit, lines.join("\n") + "\n");
    const result = runTransplantValidator(paths);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /kept_sentences\[0\] matches the raw original source/);
  } finally {
    fs.rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("book_review.benchmark is required with a valid verdict in transplant mode", () => {
  const paths = setupTransplantFixture();
  try {
    const lines = fs.readFileSync(paths.audit, "utf8").trim().split("\n");
    const record = JSON.parse(lines[0]);
    delete record.benchmark;
    lines[0] = JSON.stringify(record);
    fs.writeFileSync(paths.audit, lines.join("\n") + "\n");
    const missing = runTransplantValidator(paths);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /benchmark is required in transplant mode/);

    record.benchmark = { original_locus: "A1", verdict: "both_mediocre" };
    lines[0] = JSON.stringify(record);
    fs.writeFileSync(paths.audit, lines.join("\n") + "\n");
    const noTechnique = runTransplantValidator(paths);
    assert.equal(noTechnique.status, 1);
    assert.match(noTechnique.stderr, /benchmark\.technique \(required when the verdict is both_mediocre\)/);
  } finally {
    fs.rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("F6: more than 3 repaired acts fails even within the 30% ratio", () => {
  const acts = [];
  const beats = [];
  for (let index = 1; index <= 14; index += 1) {
    acts.push({
      act_id: "A" + index,
      function: "场景",
      temperature: "cold",
      hook_mechanism: "机制" + index,
      evidence_quote: "韩信点兵，多多益善。",
      summary: "幕 " + index
    });
    beats.push({
      id: "B" + index,
      transplant: {
        original_act_id: "A" + index,
        inherited: { function: "场景", temperature: "cold", hook_mechanism: "机制" + index },
        repair: index <= 4 ? "修补 " + index : ""
      }
    });
  }
  const autopsy = {
    acts,
    comment_data: { status: "waived", waiver_reason: "无评论数据" },
    shell_identified: "suspense_cause",
    opening_mechanism: { opening_mode: "collision" },
    why_it_works: { hypotheses: [] }
  };
  const run = {
    mode: "transplant",
    beats,
    retention: { structure_shell: "suspense_cause", opening: { opening_mode: "collision" } }
  };
  const errors = [];
  validateTransplantContract(errors, run, autopsy, { rawText: TRANSPLANT_RAW, commentsText: undefined, commentsFlagPassed: false });
  assert.match(errors.join("\n"), /exceed 3 acts/);
  assert.doesNotMatch(errors.join("\n"), /exceed 30%/);
});

test("F4/F5/F7/F8 consistency: mismatches fail undeclared, declared repairs pass", () => {
  const autopsy = validAutopsy();
  const makeRun = () => {
    const run = validTransplantRun();
    return run;
  };
  const base = () => ({ rawText: TRANSPLANT_RAW, commentsText: TRANSPLANT_COMMENTS, commentsFlagPassed: true });

  // F5: temperature mismatch without a repair fails
  let run = makeRun();
  run.beats[1].transplant.inherited.temperature = "hot";
  let errors = [];
  validateTransplantContract(errors, run, autopsy, base());
  assert.match(errors.join("\n"), /inherited\.temperature must match autopsy act A2/);

  // the same mismatch with a declared repair passes F5 (and is counted by F6 —
  // with only 3 acts a single repair already exceeds the 30% ratio, so F6 fires here)
  run = makeRun();
  run.beats[1].transplant.inherited.temperature = "hot";
  run.beats[1].transplant.repair = "幕功能缺失修补：该幕改为判断幕";
  errors = [];
  validateTransplantContract(errors, run, autopsy, base());
  assert.doesNotMatch(errors.join("\n"), /inherited\.temperature/);
  assert.match(errors.join("\n"), /exceed 30%/);

  // F4: inherited.function missing and unrepaired fails
  run = makeRun();
  delete run.beats[0].transplant.inherited.function;
  errors = [];
  validateTransplantContract(errors, run, autopsy, base());
  assert.match(errors.join("\n"), /inherited\.function is required/);

  // F7: shell mismatch needs transplant.shell_repair_reason
  run = makeRun();
  run.retention.structure_shell = "collision";
  errors = [];
  validateTransplantContract(errors, run, autopsy, base());
  assert.match(errors.join("\n"), /structure_shell must match the autopsied shell/);
  run.transplant = { shell_repair_reason: "原稿开头违反禁开场清单，骨架同壳换开场机制" };
  errors = [];
  validateTransplantContract(errors, run, autopsy, base());
  assert.deepEqual(errors, []);

  // F8: opening_mode mismatch needs transplant.opening_repair_reason
  run = makeRun();
  run.retention.opening.opening_mode = "collision";
  errors = [];
  validateTransplantContract(errors, run, autopsy, base());
  assert.match(errors.join("\n"), /opening_mode must match the autopsied opening mode/);
  run.transplant = { opening_repair_reason: "原稿钩违反禁开场清单，重铸为对撞开场" };
  errors = [];
  validateTransplantContract(errors, run, autopsy, base());
  assert.deepEqual(errors, []);
});

test("fact-pool persistence: missing file is a hard rejection", () => {
  // Requirement 3 (information density) had zero machine visibility — a survey this session
  // found 02-fact-pool.md persisted in only 1 of 51 run directories. This check makes the
  // SKILL.md listing an actual requirement rather than a suggestion.
  const errors = [];
  validateFactPoolPersisted(errors, { poolPath: "/x/02-fact-pool.md", poolText: undefined });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /is missing/);
});

test("fact-pool persistence: a real 59-fact pool passes clean", () => {
  const realPoolPath = fileURLToPath(new URL(
    "../../../../scripts/polish-notes/manchu-1911-antiqing-transplant/02-fact-pool.md",
    import.meta.url
  ));
  // Skip gracefully if run outside the full repo checkout (e.g. a packaged skill with no
  // scripts/polish-notes history) rather than failing on an environment difference.
  if (!fs.existsSync(realPoolPath)) return;
  const realPool = fs.readFileSync(realPoolPath, "utf8");
  const errors = [];
  validateFactPoolPersisted(errors, { poolPath: "/x/02-fact-pool.md", poolText: realPool });
  assert.deepEqual(errors, []);
});

test("fact-pool persistence: fewer than 40 facts is rejected", () => {
  const thin = Array.from({ length: 5 }, (_, i) => `### F${i + 1} [Score: 2]\n事实${i + 1}`).join("\n\n");
  const errors = [];
  validateFactPoolPersisted(errors, { poolPath: "/x/02-fact-pool.md", poolText: thin });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /has 5 facts/);
});
