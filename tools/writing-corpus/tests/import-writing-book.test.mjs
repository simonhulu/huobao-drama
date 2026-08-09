import assert from "node:assert/strict";
import test from "node:test";

import { normalizeEpubMarkdown } from "../import-writing-book.mjs";

test("normalizes EPUB paragraph classes into stable Markdown headings", () => {
  const input = [
    '<span id="txt001.html"></span>',
    '<p class="chapterTitle">第一讲　怎样捕捉一个好选题</p>',
    '<p class="sectionTitle">第一节　找到值得评论的问题</p>',
    '<p class="subSectionTitle">从反常处开始</p>',
    '<p>正文内容。</p>',
  ].join("\n\n");

  assert.equal(normalizeEpubMarkdown(input), [
    '<!-- source-entry: txt001.html -->',
    '# 第一讲　怎样捕捉一个好选题',
    '## 第一节　找到值得评论的问题',
    '### 从反常处开始',
    '正文内容。',
  ].join("\n\n") + "\n");
});

test("keeps ordinary emphasis out of the heading hierarchy", () => {
  const input = [
    '<p class="calibre5">普通强调</p>',
    '<p class="bodyText">正文内容。</p>',
  ].join("\n\n");

  assert.equal(normalizeEpubMarkdown(input), "普通强调\n\n正文内容。\n");
});
