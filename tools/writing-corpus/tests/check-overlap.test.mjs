import assert from "node:assert/strict";
import test from "node:test";

import { findOverlaps, normalizeComparableText } from "../check-overlap.mjs";

test("normalizes punctuation without erasing Chinese wording", () => {
  assert.equal(normalizeComparableText("门一关，争论才开始。"), "门一关争论才开始");
});

test("finds long copied runs and ignores shorter similarities", () => {
  const sources = [{ book_id: "book-a", text: "他把窗推开以后，屋里的纸全被风吹起来了。" }];
  const copied = findOverlaps("屋里很静。他把窗推开以后，屋里的纸全被风吹起来了。", sources, 12);
  const independent = findOverlaps("屋里很静。他推开窗，纸页忽然翻动。", sources, 12);
  assert.ok(copied[0].length >= 18);
  assert.deepEqual(independent, []);
});
