import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { scanForBannedExpressions } from "../scripts/scan-forbidden-expressions.mjs";

const skillRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const expressionsPath = path.resolve(skillRoot, "../../../data/style-distill/writing-books/hard-banned-expressions.json");
const expressions = JSON.parse(fs.readFileSync(expressionsPath, "utf8")).expressions;

const reportedAiPatterns = [
  "可真正让人绝望的，不是它的军队有多强——而是它扩张，靠的根本不是武力。",
  "历史上打赢了仗的征服者——架空了哈里发的布韦希王朝。",
  "横扫西亚的塞尔柱帝国——最后一个个都成了伊斯兰体系的一部分。",
  "这是黑洞——谁撞进去，谁就被同化。"
];

test("blocks the reported contrast, dash-hammer, and absolute-summary AI patterns", () => {
  for (const sentence of reportedAiPatterns) {
    const hits = scanForBannedExpressions(sentence, expressions);
    assert.ok(hits.length > 0, `expected a hard-block hit for: ${sentence}`);
  }
});

test("blocks explicit similes and metaphor labels instead of letting AI decorate the meaning", () => {
  const metaphorSamples = [
    "这套制度像一张网一样，把所有人困在里面。",
    "宗教成了一台同化引擎。",
    "这条政策如同一把刀，切断了他们的退路。"
  ];
  for (const sentence of metaphorSamples) {
    const hits = scanForBannedExpressions(sentence, expressions);
    assert.ok(hits.length > 0, `expected a metaphor hard-block hit for: ${sentence}`);
  }
});
