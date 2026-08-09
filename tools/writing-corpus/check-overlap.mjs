#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const toolRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(toolRoot, "..", "..");
const corpusRoot = resolve(repoRoot, "data", "writing-corpus");
const booksRoot = resolve(corpusRoot, "books");

export function normalizeComparableText(text) {
  return text.normalize("NFKC").replace(/[^\p{Script=Han}A-Za-z0-9]/gu, "").toLowerCase();
}

export function findOverlaps(candidateText, sources, minLength = 14) {
  if (!Number.isInteger(minLength) || minLength < 8) throw new Error("minLength must be an integer of at least 8");
  const candidate = normalizeComparableText(candidateText);
  const candidateGrams = new Map();
  for (let index = 0; index <= candidate.length - minLength; index += 1) {
    const gram = candidate.slice(index, index + minLength);
    const positions = candidateGrams.get(gram) || [];
    positions.push(index);
    candidateGrams.set(gram, positions);
  }

  const matches = [];
  for (const source of sources) {
    const sourceText = normalizeComparableText(source.text);
    for (let sourceIndex = 0; sourceIndex <= sourceText.length - minLength; sourceIndex += 1) {
      const gram = sourceText.slice(sourceIndex, sourceIndex + minLength);
      const candidatePositions = candidateGrams.get(gram);
      if (!candidatePositions) continue;
      for (const candidateIndex of candidatePositions) {
        let length = minLength;
        while (
          candidateIndex + length < candidate.length
          && sourceIndex + length < sourceText.length
          && candidate[candidateIndex + length] === sourceText[sourceIndex + length]
        ) length += 1;
        matches.push({
          book_id: source.book_id,
          candidate_index: candidateIndex,
          source_index: sourceIndex,
          length,
          text: candidate.slice(candidateIndex, candidateIndex + length),
        });
      }
    }
  }

  return matches
    .sort((left, right) => right.length - left.length || left.candidate_index - right.candidate_index)
    .filter((match, index, all) => !all.slice(0, index).some((kept) => (
      kept.book_id === match.book_id
      && kept.candidate_index <= match.candidate_index
      && kept.candidate_index + kept.length >= match.candidate_index + match.length
    )))
    .slice(0, 100);
}

function parseArgs(argv) {
  const result = { min: 14 };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--candidate") result.candidate = argv[++index];
    else if (key === "--min") result.min = Number(argv[++index]);
    else throw new Error(`unknown argument: ${key}`);
  }
  if (!result.candidate) throw new Error("--candidate is required");
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(await readFile(resolve(corpusRoot, "manifest.json"), "utf8"));
  const [candidateText, sources] = await Promise.all([
    readFile(resolve(args.candidate), "utf8"),
    Promise.all(manifest.books.map(async (book) => ({
      book_id: book.id,
      text: await readFile(resolve(booksRoot, book.markdown), "utf8"),
    }))),
  ]);
  const matches = findOverlaps(candidateText, sources, args.min);
  process.stdout.write(JSON.stringify({ min_length: args.min, match_count: matches.length, matches }, null, 2) + "\n");
  if (matches.length > 0) process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
