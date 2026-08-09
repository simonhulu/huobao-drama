import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildAttentionTimeline } from "../scripts/build-attention-timeline.mjs";
import { sha256, validateProgressiveRun } from "../scripts/validate-progressive-run.mjs";

const skillRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function makeStage({ id, order, name, relation, text, prior = [] }) {
  const contentHash = sha256(text);
  return {
    id,
    order,
    name,
    status: "locked",
    stage_job: order === 1 ? "挖出总洞" : relation === "pay" ? "支付总洞" : "用新证据深化总洞",
    audience_belief_before: `阶段${order}之前的判断`,
    audience_belief_after: `阶段${order}之后发生改变的判断`,
    main_hole_relation: relation,
    primary_driver: "海",
    evidence_ids: [`E${order}`],
    subholes_opened: relation === "pay" ? [] : [`H${order}`],
    subholes_paid: relation === "pay" ? ["H1", "H2"] : [],
    creator_decision_needed: null,
    intentionally_unpaid: relation === "pay" ? "无，当前阶段支付总洞" : "总洞答案留到结尾",
    must_preserve: ["总洞对象不变"],
    activation_event_id: `activate-${id}`,
    draft_versions: [
      {
        actor: "ai",
        text,
        content_hash: contentHash,
        parent_hash: null,
        reason: "current-stage proposal"
      }
    ],
    why_this_draft: {
      material_reason: `证据E${order}会改变观众对人物选择的判断`,
      theory_reason: relation === "pay" ? "按承诺支付原则兑现总洞" : "用海的层层探索深化信息缺口",
      structural_reason: `观众从阶段${order}之前的判断转向阶段${order}之后的判断`,
      intentionally_unpaid: relation === "pay" ? "无，当前阶段完成支付" : "人物最终动机暂不支付"
    },
    upstream_locked_hashes: prior.map((stage) => ({ stage_id: stage.id, hash: stage.locked_hash })),
    locked_text: text,
    locked_hash: contentHash,
    lock_event_id: `lock-${id}`,
    downstream_constraints: ["后文不得把争议动机写成确定事实"]
  };
}

function validRun() {
  const stages = [];
  stages.push(makeStage({ id: "S1", order: 1, name: "开头", relation: "open", text: "他拿到任命书当天，把官印退回了案头。" }));
  stages.push(makeStage({ id: "S2", order: 2, name: "探索", relation: "deepen", text: "卷宗里压着一条命令，满屋官员没有一个肯签字。他读完后，手停在了任命书上。", prior: stages }));
  stages.push(makeStage({ id: "S3", order: 3, name: "支付", relation: "pay", text: "接下这个职位，他的名字就会出现在那条命令下面。他把官印留在案头，走出了屋子。", prior: stages }));

  const events = [
    { id: "topic-confirm", kind: "topic_confirm", actor: "creator", target_id: "topic", content_hash: sha256("一次反常辞官") },
    { id: "contract-lock", kind: "contract_lock", actor: "creator", target_id: "contract" },
    { id: "map-lock", kind: "map_lock", actor: "creator", target_id: "stage_map" }
  ];
  for (const stage of stages) {
    events.push({ id: stage.activation_event_id, kind: "stage_activate", actor: "creator", target_id: stage.id });
    events.push({ id: stage.lock_event_id, kind: "stage_lock", actor: "creator", target_id: stage.id, content_hash: stage.locked_hash });
  }

  const assembledText = stages.map((stage) => stage.locked_text).join("\n\n");
  const assembledHash = sha256(assembledText);
  return {
    schema_version: 2,
    mode: "transplant",
    run_id: "fixture-progressive",
    status: "AUDITED_CANDIDATE",
    contract: {
      status: "locked",
      topic: "一次反常辞官",
      topic_confirm_event_id: "topic-confirm",
      audience: "对权力和人性好奇的普通观众",
      target_platform: "douyin",
      target_duration_seconds: 60,
      thesis: "真正的拒绝不是放弃利益，而是拒绝替制度背书",
      main_hole: "他为什么在到达权力顶点时主动辞官",
      promise: { text: "看清辞官背后的制度选择", currency: "cognitive", subject: "辞官原因", scope: "这一项任命" },
      planned_payoff: { text: "解释他拒绝背书的具体原因", currency: "cognitive", subject: "辞官原因", scope: "这一项任命" },
      primary_driver: "海",
      audience_bridge: "用反常选择吸引，以卷宗证据支付",
      driver_contract: {
        primary: "海",
        evidence_ids: ["E1", "E2", "E3"],
        mechanism: "每一层卷宗证据都缩小辞官原因的可能性",
        selection_effect: "只选择会改变观众答案判断的事实",
        exploration_endpoint: "终点从个人恐惧推进到拒绝制度背书"
      },
      lock_event_id: "contract-lock"
    },
    stage_map: { status: "locked", lock_event_id: "map-lock", stages },
    events,
    assembly: { text: assembledText, content_hash: assembledHash },
    audits: ["fact", "structure_payment", "sentence"].map((type) => ({
      id: `audit-${type}`,
      type,
      verdict: "pass",
      input_content_hash: assembledHash
    })).concat([
      {
        id: "audit-retention",
        type: "retention",
        verdict: "pass",
        input_content_hash: assembledHash,
        details: {
          prediction_policy: "qualitative_only",
          timing_basis: {
            kind: "character_ratio_estimate",
            target_duration_seconds: 60
          },
          windows: [
            {
              id: "0_2s",
              status: "pass",
              stage_id: "S1",
              exact_quote: "他拿到任命书当天，把官印退回了案头。",
              viewer_pull: "成功当天主动退印的异常结果立刻形成为什么辞官的缺口",
              evidence: "人物、异常动作和结果在第一句同时出现"
            },
            {
              id: "2_5s",
              status: "pass",
              stage_id: "S1",
              exact_quote: "把官印退回了案头",
              viewer_pull: "观众能说出自己缺的是他反常辞官的原因",
              evidence: "动作与总洞对象一致"
            },
            {
              id: "5_15s",
              status: "pass",
              stage_id: "S2",
              exact_quote: "卷宗里压着一条命令",
              viewer_pull: "第一份卷宗证据缩小辞官原因而没有提前填平总洞",
              evidence: "具体命令替代空泛铺垫"
            },
            {
              id: "body",
              status: "pass",
              stage_id: "S2",
              exact_quote: "满屋官员没有一个肯签字",
              viewer_pull: "新证据把答案从个人得失推向制度责任",
              evidence: "阶段二改变了观众对辞官动机的判断"
            },
            {
              id: "ending",
              status: "pass",
              stage_id: "S3",
              exact_quote: "他把官印留在案头，走出了屋子",
              viewer_pull: "结尾按原对象和认知货币支付总洞",
              evidence: "辞官原因被收束为拒绝制度背书"
            }
          ],
          stage_chain: [
            {
              stage_id: "S1",
              status: "pass",
              incoming_pull: "观众尚未意识到信息缺口",
              new_information: "人物在任命当天主动退回官印",
              outgoing_pull: "他为什么在成功当天辞官",
              main_hole_relation: "open"
            },
            {
              stage_id: "S2",
              status: "pass",
              incoming_pull: "辞官是否源于个人恐惧",
              new_information: "无人肯签字的命令成为决定性证据",
              outgoing_pull: "这条命令为什么值得他放弃权位",
              main_hole_relation: "deepen"
            },
            {
              stage_id: "S3",
              status: "pass",
              incoming_pull: "命令与辞官之间的制度关系",
              new_information: "接受任命等于替命令承担合法性",
              outgoing_pull: "总洞已经支付",
              main_hole_relation: "pay"
            }
          ],
          overall_reason: "每个阶段都改变答案状态，并把同一个辞官问题推向最终支付"
        }
      },
      {
        id: "audit-comment-share",
        type: "comment_share",
        verdict: "pass",
        input_content_hash: assembledHash,
        details: {
          prediction_policy: "qualitative_only",
          comment_strategy: "confrontation",
          comment_trigger: {
            stage_id: "S3",
            exact_quote: "接下这个职位，他的名字就会出现在那条命令下面。",
            mechanism: "观众会争论辞职究竟是逃避责任还是拒绝背书",
            expected_comment: "辞职也可能是另一种负责"
          },
          viewer_owned_gap: {
            stage_id: "S3",
            question: "退出有问题的制度究竟算逃避还是拒绝共谋",
            intentionally_open: true,
            answerable_by_viewer: true
          },
          share_trigger: {
            stage_id: "S3",
            exact_quote: "他把官印留在案头，走出了屋子",
            target_person: "正在纠结是否退出一份违背原则工作的朋友",
            send_reason: "这句话能替发送者表达退出不等于失败"
          },
          retell_line: "一个人升到权力顶点后辞官，因为接受任命就等于替一条坏命令背书。",
          overall_reason: "结尾同时提供可争论立场和可以定向转发给朋友的关系价值"
        }
      }
    ])
  };
}

function errorsFor(run) {
  return validateProgressiveRun(run).errors.join("\n");
}

test("accepts a fully locked and freshly audited progressive run", () => {
  assert.deepEqual(validateProgressiveRun(validRun()), { valid: true, errors: [] });
});

test("accepts independent generation mode without an original or transplant artifacts", () => {
  const run = validRun();
  run.mode = "generate";
  assert.deepEqual(validateProgressiveRun(run), { valid: true, errors: [] });
});

test("rejects publishable prose in a future planned stage", () => {
  const run = validRun();
  run.status = "MAP_LOCKED";
  delete run.assembly;
  delete run.audits;
  run.stage_map.stages[2].status = "planned";
  assert.match(errorsFor(run), /E_PREMATURE_FUTURE_DRAFT/);
});

test("requires an independent creator activation event before drafting", () => {
  const run = validRun();
  run.events = run.events.filter((event) => event.id !== "activate-S2");
  assert.match(errorsFor(run), /activation_event_id references unknown event/);
});

test("does not require an anti-AI preflight for AI-authored drafts", () => {
  const run = validRun();
  const version = run.stage_map.stages[0].draft_versions[0];
  version.text = "这不是一次辞官，而是一次拒绝。";
  version.content_hash = sha256(version.text);
  assert.deepEqual(validateProgressiveRun(run), { valid: true, errors: [] });
});

test("does not allow one event to mean both lock and advance", () => {
  const run = validRun();
  run.stage_map.stages[1].lock_event_id = "activate-S2";
  assert.match(errorsFor(run), /E_LOCK_ADVANCE_CONFLATED/);
});

test("detects any mutation of creator-locked text", () => {
  const run = validRun();
  run.stage_map.stages[0].locked_text += "后来又被系统改了一句。";
  assert.match(errorsFor(run), /E_LOCKED_SPAN_MUTATED/);
});

test("rejects generic post-hoc rationale", () => {
  const run = validRun();
  run.stage_map.stages[0].why_this_draft = {
    material_reason: "增强留存",
    theory_reason: "制造悬念",
    structural_reason: "吸引观众",
    intentionally_unpaid: "引发共鸣"
  };
  assert.match(errorsFor(run), /E_GENERIC_RATIONALE/);
});

test("requires downstream stages to consume the creator's latest locked hash", () => {
  const run = validRun();
  run.stage_map.stages[2].upstream_locked_hashes[0].hash = "stale";
  assert.match(errorsFor(run), /E_CREATOR_DECISION_NOT_PROPAGATED/);
});

test("assembly cannot insert an unapproved bridge or final polish", () => {
  const run = validRun();
  run.assembly.text = run.assembly.text.replace("\n\n", "\n\n与此同时，\n\n");
  assert.match(errorsFor(run), /E_ASSEMBLY_HASH_MISMATCH/);
});

test("audits must bind the exact assembled hash", () => {
  const run = validRun();
  run.audits[0].input_content_hash = "old-hash";
  assert.match(errorsFor(run), /E_STALE_AUDIT/);
});

test("promise and payoff must match in value currency, subject, and scope", () => {
  const run = validRun();
  run.contract.planned_payoff.scope = "整个王朝";
  assert.match(errorsFor(run), /E_PROMISE_SCOPE_MISMATCH/);
});

test("requires creator topic confirmation before the creative contract", () => {
  const run = validRun();
  run.events = run.events.filter((event) => event.id !== "topic-confirm");
  assert.match(errorsFor(run), /contract\.topic_confirm_event_id references unknown event/);
});

test("topic confirmation binds the exact topic text", () => {
  const run = validRun();
  run.contract.topic = "一场反常罢官";
  assert.match(errorsFor(run), /E_TOPIC_NOT_CONFIRMED/);
});

test("topic confirmation must precede creative-contract lock", () => {
  const run = validRun();
  [run.events[0], run.events[1]] = [run.events[1], run.events[0]];
  assert.match(errorsFor(run), /E_TOPIC_CONFIRM_ORDER/);
});

test("requires every opened subhole to be paid by the assembled ending", () => {
  const run = validRun();
  run.stage_map.stages[2].subholes_paid = ["H1"];
  assert.match(errorsFor(run), /E_SUBHOLE_SEMANTIC_ORPHAN: H2 is never paid/);
});

test("a tomb driver requires a real boundary and access rule", () => {
  const run = validRun();
  run.contract.primary_driver = "墓";
  run.contract.driver_contract = {
    primary: "墓",
    evidence_ids: ["E1"],
    mechanism: "进入真实限制开放的档案目录",
    selection_effect: "只选择能证明边界存在的材料"
  };
  for (const stage of run.stage_map.stages) stage.primary_driver = "墓";
  const errors = errorsFor(run);
  assert.match(errors, /driver_contract\.boundary is required/);
  assert.match(errors, /driver_contract\.access_rule is required/);
});

test("skill text enforces complete-draft review and targeted repair", () => {
  const skill = fs.readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
  const protocol = fs.readFileSync(path.join(skillRoot, "references/progressive-coauthoring.md"), "utf8");
  const emotionAuditor = fs.readFileSync(path.join(skillRoot, "agents/logic-emotion-auditor.md"), "utf8");
  assert.match(skill, /Never generate a complete script and ask the creator to approve it afterward/);
  assert.match(skill, /### Step 3\. `glm_writer` 写完整初稿/u);
  assert.match(skill, /### Step 4\. 句法审查/u);
  assert.match(skill, /### Step 7\. 只修失败段，不全文重写/u);
  assert.match(skill, /Keep every passing paragraph byte-identical/u);
  assert.match(skill, /glm_writer` is the sole prose writer/u);
  assert.match(skill, /same.*hash|exact.*hash/isu);
  assert.doesNotMatch(skill, /anti-ai-auditor|scan-forbidden-expressions\.mjs/iu);
  assert.doesNotMatch(skill, /modern-storyteller|spoken voice|voice checks|scan-fact-anchors\.mjs/iu);
  assert.match(skill, /historical-story-reviewer/iu);
  assert.match(protocol, /A lock event cannot double as an activation event/);
  assert.doesNotMatch(protocol, /anti-ai-auditor|anti_ai_preflight|scan-forbidden-expressions\.mjs|literal_language/iu);
  assert.match(protocol, /Do not include the next draft in this turn/);
  assert.match(skill, /Do not output a full paragraph matrix or restate successful relays/u);
  assert.match(skill, /Do not output a start\/end emotion matrix/u);
  assert.match(emotionAuditor, /只问三个会改变修稿决定的问题/u);
  assert.match(emotionAuditor, /触发/u);
  assert.match(emotionAuditor, /升级/u);
  assert.match(emotionAuditor, /高潮与释放/u);
  assert.match(emotionAuditor, /只列出需要改稿的段落或连续段落/u);
  assert.doesNotMatch(emotionAuditor, /\*\*主语清晰\*\*|\*\*宾语清晰\*\*|\*\*物理合理\*\*|\*\*视角一致\*\*|\*\*信息增量\*\*/u);
});

test("completed runs expose seven stable artifacts and clean working data", () => {
  const skill = fs.readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
  const artifactsStart = skill.indexOf("## Run Artifacts");
  const workflowStart = skill.indexOf("## Canonical 13-Step Workflow");
  assert.ok(artifactsStart >= 0 && workflowStart > artifactsStart);
  const artifacts = skill.slice(artifactsStart, workflowStart);
  for (const name of [
    "01-confirmed-topic.md",
    "02-creative-plan.md",
    "03-outline.md",
    "04-first-draft.md",
    "05-final-script.md",
    "06-title.md",
    "07-publishing-package.json"
  ]) {
    assert.match(artifacts, new RegExp(name.replaceAll(".", "\\."), "u"));
  }
  assert.match(artifacts, /only these seven stable/u);
  assert.match(artifacts, /temporary workspace outside the completed run directory/u);
  assert.match(artifacts, /completed run is invalid if any other file or\s+subdirectory remains/u);
  assert.match(skill, /### Finalization and cleanup/u);
  assert.match(skill, /remove every file and directory in the run folder except the seven canonical artifacts/u);
  assert.match(skill, /Step 11 writes `05-final-script\.md`/u);
  assert.match(skill, /Step 12 writes `06-title\.md` and updates[\s\S]*`05-final-script\.md`/u);
  assert.match(skill, /Step 13 writes `07-publishing-package\.json`/u);
});

test("skill fixes the canonical 13-step workflow order and confirmation gates", () => {
  const skill = fs.readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
  const protocol = fs.readFileSync(path.join(skillRoot, "references/progressive-coauthoring.md"), "utf8");
  const autopsy = fs.readFileSync(path.join(skillRoot, "agents/original-autopsy.md"), "utf8");
  const violentSearch = fs.readFileSync(path.join(skillRoot, "references/violent-search.md"), "utf8");
  const factCuration = fs.readFileSync(path.join(skillRoot, "references/fact-curation.md"), "utf8");

  const orderedHeadings = Array.from({ length: 13 }, (_, index) => `### Step ${index + 1}.`);
  let priorIndex = -1;
  for (const heading of orderedHeadings) {
    const currentIndex = skill.indexOf(heading);
    assert.ok(currentIndex > priorIndex, `${heading} must appear after the previous workflow step`);
    priorIndex = currentIndex;
  }

  assert.match(skill, /This is the only production route for new and revised runs/);
  assert.match(skill, /Step 1\. `\$viral-topic-creator` 创作主题并确认故事合同/);
  assert.match(skill, /explicit creator decision.*确认主方案/isu);
  assert.match(skill, /Step 2\. history agents 设计创作方案/);
  assert.match(skill, /Step 5\. 历史故事结构门 \+ slippery 审核认知接力/);
  assert.match(skill, /Step 6\. emotion auditor 审核情绪推进/);
  assert.match(skill, /Step 9\. `viral-opening-optimizer` 优化开头/);
  assert.match(skill, /Step 10\. `viral-ending-engagement` 优化结尾/);
  assert.match(skill, /Step 11\. 最终机械扫描与同哈希终审/);
  assert.match(skill, /Step 12\. `\$viral-title-agent` 创作标题、用户确认并写入文稿/);
  assert.match(skill, /Step 13\. Publishing package handoff/u);
  assert.match(skill, /title:.*confirmed title/isu);
  assert.match(skill, /body_sha256.*manuscript_sha256/isu);
  assert.doesNotMatch(skill, /### 0\. Breakout Original Intake/);
  assert.doesNotMatch(skill, /### 6\. Progressive Stage Loop/);
  assert.doesNotMatch(skill, /Do a small feasibility search/);
  assert.doesNotMatch(skill, /After `creator_contract_lock_event_id` exists, perform targeted research/);

  assert.match(protocol, /mode = generate[\s\S]*?mode = transplant/);
  assert.match(protocol, /AUTOPSY_READY\s+# original mode only[\s\S]*?SEARCH_RUNNING\s+# generate mode goes here directly/);
  assert.match(protocol, /In generate mode, skip[\s\S]*?AUTOPSY_READY/);
  assert.match(skill, /Before invoking any agent or treating pasted material as a source, ask exactly one question/);
  assert.match(skill, /If no, persist `mode = generate`\s+and enter Step 1 immediately/);
  assert.doesNotMatch(skill, /If no proven original script\/transcript is available, stop/);
  assert.match(autopsy, /The confirmed new topic \(mandatory before dissection\)/);
  assert.match(autopsy, /Do not\s+interrupt the original-to-topic-to-dissection sequence/);
  assert.doesNotMatch(autopsy, /Comment-section data \(mandatory/);
  assert.match(violentSearch, /In original mode, run it\s+after the original structure dissection is ready/);
  assert.match(violentSearch, /in generate mode, run it\s+directly from the\s+confirmed topic/);
  assert.match(factCuration, /Runs after search and before the creative contract/);
});

test("internal autopsy identifiers never become medical Chinese workflow labels", () => {
  const skill = fs.readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
  const autopsyAgent = fs.readFileSync(path.join(skillRoot, "agents/original-autopsy.md"), "utf8");

  assert.match(skill, /Keep `autopsy`, `AUTOPSY_READY`, `autopsy_complete`, and `00-autopsy\.(?:md|json)` as internal identifiers only/);
  assert.match(skill, /Use `原稿解剖` as the Chinese display name/);
  assert.match(skill, /Never render the workflow stage as `尸检`/);
  assert.match(skill, /Preserve `尸检` only when it is part of quoted or subject-matter content/);
  assert.match(autopsyAgent, /User-facing Chinese must say `原稿解剖`/);
  assert.match(autopsyAgent, /Internal `autopsy` identifiers must never be translated literally/);
  assert.doesNotMatch(autopsyAgent, /forensic anatomist/);
});

test("builds an honest estimated attention timeline bound to the assembled hash", () => {
  const run = validRun();
  const timeline = buildAttentionTimeline(run);
  assert.equal(timeline.input_content_hash, run.assembly.content_hash);
  assert.equal(timeline.timing_basis.kind, "character_ratio_estimate");
  assert.equal(timeline.timing_basis.target_duration_seconds, 60);
  assert.deepEqual(timeline.checkpoints.slice(0, 3).map((item) => item.id), ["2s", "5s", "15s"]);
  assert.ok(timeline.checkpoints.every((item) => item.exact_quote.length > 0));
});

test("requires retention and comment-share diagnostics before audited handoff", () => {
  const run = validRun();
  run.audits = run.audits.filter((audit) => !["retention", "comment_share"].includes(audit.type));
  const errors = errorsFor(run);
  assert.match(errors, /missing required retention audit/);
  assert.match(errors, /missing required comment_share audit/);
});

test("rejects a retention pass when any attention window is still risky", () => {
  const run = validRun();
  const audit = run.audits.find((item) => item.type === "retention");
  audit.details.windows[1].status = "risk";
  audit.details.windows[1].repair = "把总洞对象提前到第一句末尾";
  assert.match(errorsFor(run), /E_RETENTION_VERDICT_CONTRADICTION/);
});

test("rejects retention diagnostics that omit a required time window", () => {
  const run = validRun();
  const audit = run.audits.find((item) => item.type === "retention");
  audit.details.windows = audit.details.windows.filter((item) => item.id !== "5_15s");
  assert.match(errorsFor(run), /E_RETENTION_WINDOW_MISSING: 5_15s/);
});

test("a timed retention window must inspect the stage occupying that checkpoint", () => {
  const run = validRun();
  const audit = run.audits.find((item) => item.type === "retention");
  audit.details.windows.find((item) => item.id === "0_2s").stage_id = "S3";
  assert.match(errorsFor(run), /E_RETENTION_TIMELINE_STAGE_MISMATCH: 0_2s/);
});

test("rejects diagnostic reports that pretend to predict exact metric rates", () => {
  const run = validRun();
  const audit = run.audits.find((item) => item.type === "retention");
  audit.details.prediction_policy = "estimated_2s_bounce_37_percent";
  assert.match(errorsFor(run), /E_FABRICATED_METRIC_RATE/);
});

test("rejects a generic CTA as the claimed comment trigger", () => {
  const run = validRun();
  const audit = run.audits.find((item) => item.type === "comment_share");
  audit.details.comment_trigger.exact_quote = "你怎么看？评论区告诉我。";
  run.stage_map.stages[2].locked_text += "你怎么看？评论区告诉我。";
  run.stage_map.stages[2].locked_hash = sha256(run.stage_map.stages[2].locked_text);
  run.assembly.text = run.stage_map.stages.map((stage) => stage.locked_text).join("\n\n");
  run.assembly.content_hash = sha256(run.assembly.text);
  audit.input_content_hash = run.assembly.content_hash;
  assert.match(errorsFor(run), /E_GENERIC_ENGAGEMENT_CTA/);
});

test("requires comment and share trigger quotes to exist in the locked script", () => {
  const run = validRun();
  const audit = run.audits.find((item) => item.type === "comment_share");
  audit.details.share_trigger.exact_quote = "这句根本不在文稿里";
  assert.match(errorsFor(run), /E_ENGAGEMENT_TRIGGER_NOT_FOUND/);
});

test("a viewer-owned comment gap cannot recycle the paid main hole", () => {
  const run = validRun();
  const audit = run.audits.find((item) => item.type === "comment_share");
  audit.details.viewer_owned_gap.question = run.contract.main_hole;
  assert.match(errorsFor(run), /E_COMMENT_GAP_IS_CREATOR_DEBT/);
});

test("skill requires both prepublish diagnostic tools without claiming real rates", () => {
  const skill = fs.readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
  assert.match(skill, /retention-auditor\.md/);
  assert.match(skill, /comment-share-auditor\.md/);
  assert.match(skill, /Never predict a numeric 2-second bounce, 5-second completion, overall completion, comment, or share rate/);
});
