import assert from "node:assert/strict";
import test from "node:test";

import { buildSourceInventory } from "../build-source-inventory.mjs";

test("active corpus contains the four approved sources", async () => {
  const inventory = await buildSourceInventory();
  assert.deepEqual(
    inventory.books.map((book) => book.book_id).sort(),
    [
      "chinese-fiction-description-dictionary",
      "copywriting-fundamentals",
      "miaozan-copywriting",
      "southern-weekend-commentary-writing",
    ],
  );
});

test("dictionary coverage isolates OCR review pages without blocking usable pages", async () => {
  const inventory = await buildSourceInventory();
  const book = inventory.books.find((item) => item.book_id === "chinese-fiction-description-dictionary");
  assert.equal(book.source_units, 959);
  assert.equal(book.review_units, 11);
  assert.equal(book.usable_units, 948);
  assert.equal(book.units.filter((unit) => unit.kind === "page").length, 959);
});

test("complete EPUBs expose source entries and structural headings", async () => {
  const inventory = await buildSourceInventory();
  const miaozan = inventory.books.find((item) => item.book_id === "miaozan-copywriting");
  const commentary = inventory.books.find((item) => item.book_id === "southern-weekend-commentary-writing");
  assert.equal(miaozan.source_status, "converted");
  assert.equal(miaozan.source_units, 31);
  assert.ok(miaozan.heading_units >= 100);
  assert.equal(commentary.source_status, "converted");
  assert.equal(commentary.source_units, 15);
  assert.ok(commentary.heading_units >= 50);
});
