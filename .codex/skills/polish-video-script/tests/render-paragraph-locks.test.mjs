import assert from "node:assert/strict";
import test from "node:test";

import {
  renderLocks,
  sentenceSpans,
  firstSentenceOf,
  bridgeQuoteOf,
  splitScriptParagraphs
} from "../scripts/render-paragraph-locks.mjs";
import { validateFinalScript } from "../scripts/validate-production-run.mjs";

function beat(id, overrides = {}) {
  return {
    id,
    fact_ids: ["f-" + id],
    reader_belief_change: "观众开始怀疑 " + id + " 的账面数字",
    disclosure: { kind: "first", fact_ids: ["f-" + id] },
    reader_relay: {
      question_in_id: "Q1",
      question_in: "这笔账是谁记的？",
      facts_known_before: ["官方数字存在", "两百年前只有几千万"],
      fact_ids_disclosed_here: ["f-" + id],
      resolution: "carry",
      question_out_id: "Q1",
      question_out: "这笔账是谁记的？",
      bridge_to_next: "往下一段推"
    },
    ...overrides
  };
}

test("sentence splitting keeps terminal punctuation and trailing fragments", () => {
  assert.deepEqual(sentenceSpans("甲来了。乙走了！丙呢？"), ["甲来了。", "乙走了！", "丙呢？"]);
  // A fragment with no end punctuation is still a sentence.
  assert.deepEqual(sentenceSpans("甲来了。然后"), ["甲来了。", "然后"]);
  // Closing quotes ride along with the punctuation they follow.
  assert.deepEqual(sentenceSpans("他说「走。」我没动。"), ["他说「走。」", "我没动。"]);
});

test("first_sentence is always a true prefix of the paragraph", () => {
  const paragraph = "腊月里收税，是这么个场面：差役堵在村口。回去交不了差。";
  const first = firstSentenceOf(paragraph);
  assert.ok(paragraph.startsWith(first), "validator requires paragraph.startsWith(first_sentence)");
});

test("bridge_quote absorbs a preceding sentence when the tail is a short hard stop", () => {
  // A bare 「他没走。」 tail is too short to anchor anything, so the previous sentence joins it.
  const withShortTail = "差役堵在村口，挨家收皇粮。他没走。";
  assert.equal(bridgeQuoteOf(withShortTail), "差役堵在村口，挨家收皇粮。他没走。");
  // A substantial tail stands alone.
  const withLongTail = "账记完了。现在回两百年前，把明朝那本账翻开，看它记着什么。";
  assert.equal(bridgeQuoteOf(withLongTail), "现在回两百年前，把明朝那本账翻开，看它记着什么。");
});

test("rendered locks satisfy the final-script validator", () => {
  const run = {
    beats: [beat("B1"), beat("B2"), beat("B3")],
    retention: { opening: { script_required_patterns: ["户口本"] } },
    truth_promise: { source_claims: [] }
  };
  const script = [
    "道光十四年，大清的户口本上写着四亿零一百万人。这个数字要一步步拆开看。",
    "明朝的账本上记着六千万。实际人口可能是一亿五千万，账面差了一倍还多。",
    "所以四亿里有一半是人口增长，一半是登记方式改了。账和人，从来不是一回事。"
  ].join("\n\n");

  const { locks, problems } = renderLocks(run, script);
  assert.deepEqual(problems, []);
  assert.equal(locks.length, 3);

  // The final paragraph needs no bridge; every earlier one must have one.
  assert.ok(locks[0].bridge_quote);
  assert.ok(locks[1].bridge_quote);
  assert.equal(locks[2].bridge_quote, undefined);

  const errors = validateFinalScript(run, script, locks);
  assert.deepEqual(errors, [], "machine-rendered locks must pass the validator unedited");
});

test("a paragraph/beat count mismatch is reported instead of producing silent partial locks", () => {
  const run = { beats: [beat("B1"), beat("B2")] };
  const { problems } = renderLocks(run, "只有一段。");
  assert.equal(problems.length, 1);
  assert.match(problems[0], /1 paragraphs but the run declares 2 beats/);
});

test("optional beat fields fall back to the question chain instead of failing", () => {
  // reader_belief_change and facts_known_before are optional in the minimal beat contract, so
  // the locks derive listener_knows / new_contribution from the relay questions instead.
  const first = beat("B1");
  const second = beat("B2");
  delete second.reader_belief_change;
  delete second.reader_relay.facts_known_before;
  const run = { beats: [first, second] };
  const { locks, problems } = renderLocks(run, "第一段在这里。\n\n第二段在这里。");
  assert.deepEqual(problems, []);
  assert.equal(locks[1].new_contribution, second.reader_relay.question_out);
  assert.equal(locks[1].listener_knows, first.reader_relay.question_out);
});

test("a beat with no id at all is still reported", () => {
  const broken = beat("B2");
  delete broken.id;
  const run = { beats: [beat("B1"), broken] };
  const { problems } = renderLocks(run, "第一段在这里。\n\n第二段在这里。");
  assert.equal(problems.length, 1);
  assert.match(problems[0], /paragraph 2: cannot derive beat_id/);
});

test("the derived question chain carries and advances like the validator's", () => {
  const b1 = beat("B1", { reader_relay: { ...beat("B1").reader_relay, resolution: "carry" } });
  const b2 = beat("B2", {
    reader_relay: { ...beat("B2").reader_relay, resolution: "answer", question_out: "那笔钱去哪了？" }
  });
  const b3 = beat("B3", { reader_relay: { ...beat("B3").reader_relay, resolution: "carry" } });
  const run = { beats: [b1, b2, b3], retention: { open_loop_id: "Q1" } };
  const { locks } = renderLocks(run, "一段。\n\n二段。\n\n三段。");
  assert.deepEqual(
    locks.map((lock) => [lock.question_in_id, lock.question_out_id]),
    [["Q1", "Q1"], ["Q1", "Q2"], ["Q2", "Q2"]]
  );
});

test("paragraph splitting matches the validator's own splitter", () => {
  // Both sides must treat blank-line runs identically or the locks will not line up.
  const script = "一段。\n\n\n  \n二段。\n\n三段。\n";
  assert.deepEqual(splitScriptParagraphs(script), ["一段。", "二段。", "三段。"]);
});
