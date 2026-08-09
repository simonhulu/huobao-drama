import assert from "node:assert/strict";
import test from "node:test";

import { scanSentenceHealth } from "../scripts/scan-sentence-health.mjs";

function rules(text) {
  return scanSentenceHealth(text).map((f) => f.rule);
}

// The four defects below all shipped in real drafts. Each is the reason its rule exists.

test("catches a verb reused inside one over-compressed clause", () => {
  assert.ok(rules("他退到楼上无路可退。").includes("repeated-char"));
});

test("catches a compound verb whose head was swallowed by the locative", () => {
  // 中弹 lost its 中 to 半空中.
  assert.ok(rules("人在半空中了弹。").includes("swallowed-verb"));
});

test("catches an age statement with no subject", () => {
  assert.ok(rules("那年三十二岁。").includes("missing-subject"));
});

test("catches a naming clause attached to the wrong subject", () => {
  // Claims the house is named 恒知府胡同; the hutong is.
  assert.ok(rules("宅子在大东关小什字街，叫恒知府胡同。").includes("misattached-naming"));
});

test("mis-attached naming is advisory, because deciding it needs world knowledge", () => {
  // 「宅子…叫恒王府」 is correct (a mansion can be a 府); 「宅子…叫开封府」 is not. 府/城/关 are
  // both building words and place words, so no word list separates them — the rule points at
  // the sentence and the auditor agent gives the verdict.
  const [finding] = scanSentenceHealth("宅子在城东，叫恒王府。");
  assert.equal(finding.rule, "misattached-naming");
  assert.equal(finding.advisory, true);
});

// False positives are worse than misses here: a spurious finding pushes the treatment pass to
// inflate a correct short sentence into a padded one.

test("the corrected forms of all four defects are clean", () => {
  const corrected = [
    "他退上二楼，没路了。",
    "人在半空中中了弹。",
    "那年，他三十二岁。",
    "宅子在大东关小什字街，胡同叫恒知府胡同。"
  ].join("\n\n");
  assert.deepEqual(scanSentenceHealth(corrected), []);
});

test("a repeated proper noun is not a repeated-character defect", () => {
  // 「这条胡同，叫恒知府胡同」 says 胡同 twice and is correct.
  assert.deepEqual(rules("这条胡同，叫恒知府胡同。"), []);
});

test("naming a place after a place subject is correct attachment", () => {
  assert.deepEqual(rules("那条巷子，叫恒知府胡同。"), []);
  assert.deepEqual(rules("胡同在城东，叫恒知府胡同。"), []);
});

test("an action chain on one subject is not a runaway clause", () => {
  // Decomposing one act into steps is the wanted scene technique, not a defect.
  const chain = "兵围上来，砸开大门，把他从梦里惊醒，他摸出枪，打伤一名探兵，退上二楼。";
  assert.ok(!rules(chain).includes("runaway-clause"));
});

test("function-word repetition is never flagged", () => {
  const ordinary = "他的父亲做过知府，他的哥哥是内务府大臣，他自己什么官都不肯做。";
  assert.deepEqual(rules(ordinary), []);
});

test("markdown scaffolding and comments are skipped", () => {
  const withNoise = [
    "# 标题",
    "<!-- A1 设问 hot -->",
    "- article_id: x",
    "那年三十二岁。"
  ].join("\n\n");
  const findings = scanSentenceHealth(withNoise);
  assert.equal(findings.length, 1);
  // Paragraph numbering counts prose only, so the finding lands on paragraph 1.
  assert.equal(findings[0].paragraph, 1);
});

test("a beat comment above the prose does not hide the paragraph", () => {
  // Regression: real drafts put the beat comment on the first LINE of the block. Judging the
  // whole block by that line skipped every annotated paragraph — on one real draft that hid 10
  // of 15 paragraphs and reported PASS on a script containing a known 病句.
  const annotated = "<!-- A1 设问 hot · result_then_rewind -->\n那年三十二岁。";
  const findings = scanSentenceHealth(annotated);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "missing-subject");
});

test("an ordinary verb with 了 is not a swallowed compound", () => {
  // Regression: 中/上/下 are verbs in their own right. Flagging these was doubly harmful,
  // because the writer contract says to repair by adding the missing character — which would
  // turn 他中了毒 into 他中中了毒.
  for (const clean of ["他中了毒。", "袁世凯上了任。", "段祺瑞下了野。", "他中了枪。"]) {
    assert.deepEqual(rules(clean), [], clean + " must not be flagged");
  }
});

test("the swallowed-verb repair is not flagged as the defect it repairs", () => {
  assert.ok(rules("人在半空中了弹。").includes("swallowed-verb"));
  assert.deepEqual(rules("人在半空中中了弹。"), []);
});

test("findings carry the sentence and a concrete repair", () => {
  const [finding] = scanSentenceHealth("那年三十二岁。");
  assert.equal(finding.sentence, "那年三十二岁。");
  assert.match(finding.repair, /他三十二岁/);
});
