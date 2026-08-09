#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "..", "..");
const corpusRoot = resolve(repoRoot, "data", "writing-corpus");
const booksRoot = resolve(corpusRoot, "books");

function excerpt(text, query, maxLength = 600) {
  const compact = text.replace(/\n{3,}/g, "\n\n").trim();
  const index = compact.indexOf(query);
  if (index < 0 || compact.length <= maxLength) return compact.slice(0, maxLength);
  const start = Math.max(0, index - Math.floor((maxLength - query.length) / 2));
  return compact.slice(start, start + maxLength);
}

function pdfChunks(markdown) {
  const matches = [...markdown.matchAll(/^<!-- page: (\d+);[^\n]* -->$/gm)];
  return matches.map((match, index) => ({
    locator: `page-${match[1]}`,
    text: markdown.slice(match.index + match[0].length, matches[index + 1]?.index ?? markdown.length),
  }));
}

function epubChunks(markdown) {
  const lines = markdown.split("\n");
  const path = [];
  const chunks = [];
  let current = { locator: "frontmatter", lines: [] };
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (!heading) {
      current.lines.push(line);
      continue;
    }
    if (current.lines.some((item) => item.trim())) chunks.push({ locator: current.locator, text: current.lines.join("\n") });
    const level = heading[1].length;
    path.splice(level - 1);
    path[level - 1] = heading[2].trim();
    current = { locator: path.filter(Boolean).join(" / "), lines: [] };
  }
  if (current.lines.some((item) => item.trim())) chunks.push({ locator: current.locator, text: current.lines.join("\n") });
  return chunks;
}

export async function searchBookSource({ book_id, query, limit = 5 }) {
  if (!book_id || !query?.trim()) throw new Error("book_id and non-empty query are required");
  const manifest = JSON.parse(await readFile(resolve(corpusRoot, "manifest.json"), "utf8"));
  const book = manifest.books.find((item) => item.id === book_id);
  if (!book) throw new Error(`unknown book_id: ${book_id}`);
  const markdown = await readFile(resolve(booksRoot, book.markdown), "utf8");
  const chunks = book.source_format === "pdf" ? pdfChunks(markdown) : epubChunks(markdown);
  const terms = [...new Set(query.trim().split(/\s+/).filter(Boolean))];
  return chunks
    .map((chunk) => {
      const exact = chunk.text.includes(query) ? 10 : 0;
      const termScore = terms.reduce((sum, term) => sum + (chunk.text.includes(term) ? 2 : 0), 0);
      return { ...chunk, score: exact + termScore };
    })
    .filter((chunk) => chunk.score > 0)
    .sort((left, right) => right.score - left.score || left.locator.localeCompare(right.locator))
    .slice(0, Math.max(1, Math.min(Number(limit) || 5, 20)))
    .map((chunk) => ({ book_id, locator: chunk.locator, text: excerpt(chunk.text, query) }));
}

async function main() {
  const query = JSON.parse(process.argv[2] || "{}");
  process.stdout.write(JSON.stringify(await searchBookSource(query), null, 2) + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
