#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "..", "..");
const corpusRoot = resolve(repoRoot, "data", "writing-corpus");
const booksRoot = resolve(corpusRoot, "books");
const defaultOutput = resolve(corpusRoot, "source-unit-inventory.json");

function pageUnits(markdown) {
  return [...markdown.matchAll(/^<!-- page: (\d+); confidence: ([0-9.]+); status: (\w+) -->$/gm)].map((match) => ({
    id: `page-${match[1]}`,
    kind: "page",
    locator: `page-${match[1]}`,
    parse_status: match[3] === "ok" ? "usable" : "review",
    confidence: Number(match[2]),
    semantic_status: "indexed_pending_full_screening",
  }));
}

function epubUnits(markdown, coverage) {
  const headings = [...markdown.matchAll(/^(#{1,6})\s+(.+)$/gm)].map((match, index) => ({
    id: `heading-${index + 1}`,
    kind: "heading",
    locator: match[2].trim(),
    level: match[1].length,
    parse_status: "usable",
    semantic_status: "indexed_pending_full_screening",
  }));
  const entries = (coverage.source_entries || []).map((entry) => ({
    id: `source-entry-${entry}`,
    kind: "source_entry",
    locator: entry,
    parse_status: "usable",
    semantic_status: "indexed_pending_full_screening",
  }));
  return { headings, entries };
}

export async function buildSourceInventory() {
  const manifest = JSON.parse(await readFile(resolve(corpusRoot, "manifest.json"), "utf8"));
  const books = [];
  for (const source of manifest.books) {
    const coverage = JSON.parse(await readFile(resolve(booksRoot, source.coverage), "utf8"));
    const markdown = await readFile(resolve(booksRoot, source.markdown), "utf8");
    if (source.source_format === "pdf") {
      const units = pageUnits(markdown);
      const reviewUnits = units.filter((unit) => unit.parse_status === "review").length;
      books.push({
        book_id: source.id,
        source_status: source.status,
        source_units: coverage.source_units,
        usable_units: units.length - reviewUnits,
        review_units: reviewUnits,
        heading_units: 0,
        units,
      });
      continue;
    }
    const { headings, entries } = epubUnits(markdown, coverage);
    books.push({
      book_id: source.id,
      source_status: source.status,
      source_units: coverage.source_units,
      usable_units: coverage.processed_units,
      review_units: coverage.anomalous_units,
      heading_units: headings.length,
      units: [...entries, ...headings],
    });
  }
  return {
    schema_version: 1,
    generated_from_manifest: "data/writing-corpus/manifest.json",
    corpus_status: books.some((book) => book.review_units > 0)
      ? "indexed_with_local_review_items"
      : "indexed",
    books,
  };
}

async function main() {
  const inventory = await buildSourceInventory();
  const output = process.argv.includes("--write") ? defaultOutput : null;
  if (output) {
    await writeFile(output, JSON.stringify(inventory, null, 2) + "\n", "utf8");
    process.stdout.write(`${output}\n`);
  } else {
    process.stdout.write(JSON.stringify(inventory, null, 2) + "\n");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
