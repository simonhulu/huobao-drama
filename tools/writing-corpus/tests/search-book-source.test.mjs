import assert from "node:assert/strict";
import test from "node:test";

import { searchBookSource } from "../search-book-source.mjs";

test("offline source search returns bounded page-located dictionary evidence", async () => {
  const results = await searchBookSource({
    book_id: "chinese-fiction-description-dictionary",
    query: "白描",
    limit: 3,
  });

  assert.ok(results.length > 0 && results.length <= 3);
  assert.ok(results.some((result) => result.locator === "page-953"));
  assert.ok(results.every((result) => result.text.length <= 600));
});

test("offline source search returns heading-located EPUB evidence", async () => {
  const results = await searchBookSource({
    book_id: "southern-weekend-commentary-writing",
    query: "长句改短句",
    limit: 5,
  });

  assert.ok(results.length > 0);
  assert.ok(results.some((result) => result.locator.includes("第一节")));
});
