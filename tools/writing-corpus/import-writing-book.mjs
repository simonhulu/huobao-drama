#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const toolRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(toolRoot, "..", "..");
const corpusRoot = join(repoRoot, "data", "writing-corpus");
const booksRoot = join(corpusRoot, "books");

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value == null) throw new Error(`invalid argument near ${key}`);
    result[key.slice(2)] = value;
  }
  for (const required of ["id", "title", "author", "input"]) {
    if (!result[required]) throw new Error(`missing --${required}`);
  }
  if (!/^[a-z0-9-]+$/.test(result.id)) throw new Error("--id must use lowercase ASCII slugs");
  return result;
}

async function sha256(filePath) {
  const data = await readFile(filePath);
  return createHash("sha256").update(data).digest("hex");
}

export function normalizeEpubMarkdown(input) {
  const headingClasses = [
    ["chapterTitle", "#"],
    ["sectionTitle", "##"],
    ["subSectionTitle", "###"],
  ];
  let body = input.replace(/\r\n/g, "\n");
  for (const [className, marker] of headingClasses) {
    const pattern = new RegExp(
      `^<p\\b[^>]*class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/p>$`,
      "gim",
    );
    body = body.replace(pattern, `${marker} $1`);
  }
  return body
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, "")
    .replace(/^<span id="([^"]+\.(?:xhtml|html))"><\/span>$/gim, "<!-- source-entry: $1 -->")
    .replace(/^<span class="(?:calibre5|calibre_6)">([\s\S]*?)<\/span>$/gim, "$1")
    .replace(/<\/?(?:span|div|p)\b[^>]*>/gi, "")
    .replace(/^\s*(?:!\[[^\]]*\]\([^)]*\)|<img\b[^>]*>)\s*$/gim, "")
    .replace(/^(第[一二三四五六七八九十百0-9]+讲[　 \t]+.+)$/gm, "# $1")
    .replace(/^(第[一二三四五六七八九十百0-9]+节[　 \t]+.+)$/gm, "## $1")
    .replace(/^([一二三四五六七八九十百]+、[^\n]{2,60})$/gm, "### $1")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim() + "\n";
}

function frontmatter(metadata) {
  return [
    "---",
    `book_id: ${metadata.id}`,
    `title: ${JSON.stringify(metadata.title)}`,
    `author: ${JSON.stringify(metadata.author)}`,
    `source_format: ${metadata.format}`,
    `source_sha256: ${metadata.sha256}`,
    `source_bytes: ${metadata.bytes}`,
    `converter: ${JSON.stringify(metadata.converter)}`,
    "---",
    "",
  ].join("\n");
}

async function importEpub(inputPath, metadata, outputDirectory) {
  const workDirectory = await mkdtemp(join(tmpdir(), "polish-book-epub-"));
  const rawPath = join(workDirectory, "book.md");
  await execFileAsync("pandoc", [inputPath, "--to=gfm", "--wrap=none", "--output", rawPath], {
    maxBuffer: 1024 * 1024 * 32,
  });
  let body = await readFile(rawPath, "utf8");
  const expectedEntries = [...new Set(body.match(/index_split_\d+\.html/g) || [])].sort();
  const presentEntries = [...new Set(
    [...body.matchAll(/^<span id="([^"]+\.(?:xhtml|html))"><\/span>$/gim)].map((match) => match[1])
  )].sort();
  const missingEntries = expectedEntries.filter((entry) => !presentEntries.includes(entry));
  body = normalizeEpubMarkdown(body);
  const headingCount = (body.match(/^#{1,6}\s+/gm) || []).length;
  const bookText = frontmatter({ ...metadata, converter: `pandoc ${await commandVersion("pandoc", ["--version"])}` })
    + "<!-- source-entry: epub-spine -->\n\n"
    + body;
  await writeFile(join(outputDirectory, "book.md"), bookText, "utf8");
  return {
    source_units: Math.max(expectedEntries.length, presentEntries.length),
    processed_units: presentEntries.length,
    anomalous_units: missingEntries.length,
    character_count: body.length,
    headings: headingCount,
    source_entries: presentEntries,
    missing_entries: missingEntries,
    status: missingEntries.length === 0 ? "converted" : "source_incomplete",
  };
}

async function commandVersion(command, args) {
  try {
    const { stdout } = await execFileAsync(command, args);
    return stdout.split("\n")[0].trim();
  } catch {
    return "unknown";
  }
}

async function compileVisionOCR(workRoot) {
  const source = join(toolRoot, "ocr-pdf-vision.swift");
  const binary = join(workRoot, "ocr-pdf-vision");
  await execFileAsync("swiftc", [source, "-o", binary, "-framework", "PDFKit", "-framework", "Vision", "-framework", "AppKit"], {
    maxBuffer: 1024 * 1024 * 8,
  });
  return binary;
}

async function runProcess(command, args) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", rejectPromise);
    child.once("exit", (code) => code === 0 ? resolvePromise() : rejectPromise(new Error(`${command} exited ${code}`)));
  });
}

async function importPdf(inputPath, metadata, outputDirectory, concurrency, scale) {
  const { stdout } = await execFileAsync("pdfinfo", [inputPath]);
  const pageMatch = stdout.match(/^Pages:\s+(\d+)$/m);
  if (!pageMatch) throw new Error("pdfinfo did not report a page count");
  const pageCount = Number(pageMatch[1]);
  const workRoot = resolve(repoRoot, "tmp", "book-import", metadata.id, metadata.sha256.slice(0, 12));
  const pagesDirectory = join(workRoot, "pages");
  await mkdir(pagesDirectory, { recursive: true });
  const binary = await compileVisionOCR(workRoot);
  const chunkSize = Math.ceil(pageCount / concurrency);
  const workers = [];
  for (let worker = 0; worker < concurrency; worker += 1) {
    const start = worker * chunkSize + 1;
    const end = Math.min(pageCount, (worker + 1) * chunkSize);
    if (start <= end) workers.push(runProcess(binary, [inputPath, pagesDirectory, String(start), String(end), String(scale)]));
  }
  await Promise.all(workers);

  const pageFiles = (await readdir(pagesDirectory)).filter((name) => name.endsWith(".json")).sort();
  const pages = [];
  const anomalies = [];
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const name = `${String(pageNumber).padStart(4, "0")}.json`;
    if (!pageFiles.includes(name)) {
      anomalies.push({ page: pageNumber, reason: "missing_ocr_output" });
      pages.push(`<!-- page: ${pageNumber}; status: missing -->\n`);
      continue;
    }
    const parsed = JSON.parse(await readFile(join(pagesDirectory, name), "utf8"));
    const compactText = parsed.text.replace(/[ \t]+$/gm, "").replace(/\n{4,}/g, "\n\n\n").trim();
    const suspicious = parsed.characterCount < 20 || parsed.averageConfidence < 0.45;
    if (suspicious) {
      anomalies.push({
        page: pageNumber,
        reason: parsed.characterCount < 20 ? "low_character_count" : "low_confidence",
        character_count: parsed.characterCount,
        average_confidence: parsed.averageConfidence,
      });
    }
    pages.push(
      `<!-- page: ${pageNumber}; confidence: ${Number(parsed.averageConfidence).toFixed(4)}; status: ${suspicious ? "review" : "ok"} -->\n\n${compactText}\n`
    );
  }
  const body = pages.join("\n");
  const bookText = frontmatter({ ...metadata, converter: `Apple Vision OCR scale=${scale}` }) + body;
  await writeFile(join(outputDirectory, "book.md"), bookText, "utf8");
  return {
    source_units: pageCount,
    processed_units: pageFiles.length,
    anomalous_units: anomalies.length,
    character_count: body.length,
    anomalies,
    status: anomalies.length === 0 ? "converted" : "converted_with_review_items",
  };
}

async function updateManifest(entry) {
  await mkdir(booksRoot, { recursive: true });
  const manifestPath = join(corpusRoot, "manifest.json");
  let manifest = { schema_version: 1, books: [] };
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {}
  const books = manifest.books.filter((book) => book.id !== entry.id);
  books.push(entry);
  books.sort((left, right) => left.id.localeCompare(right.id));
  await writeFile(manifestPath, JSON.stringify({ schema_version: 1, books }, null, 2) + "\n", "utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = resolve(args.input);
  const sourceStat = await stat(inputPath);
  const format = extname(inputPath).slice(1).toLowerCase();
  if (!["pdf", "epub"].includes(format)) throw new Error(`unsupported input format: ${format}`);
  const metadata = {
    id: args.id,
    title: args.title,
    author: args.author,
    format,
    sha256: await sha256(inputPath),
    bytes: sourceStat.size,
  };
  const outputDirectory = join(booksRoot, args.id);
  await mkdir(outputDirectory, { recursive: true });
  const coverage = format === "epub"
    ? await importEpub(inputPath, metadata, outputDirectory)
    : await importPdf(inputPath, metadata, outputDirectory, Number(args.concurrency || 4), Number(args.scale || 2.8));
  await writeFile(join(outputDirectory, "coverage.json"), JSON.stringify({ ...metadata, ...coverage }, null, 2) + "\n", "utf8");
  await updateManifest({
    id: metadata.id,
    title: metadata.title,
    author: metadata.author,
    source_format: metadata.format,
    source_filename: basename(inputPath),
    source_sha256: metadata.sha256,
    source_bytes: metadata.bytes,
    markdown: `${metadata.id}/book.md`,
    coverage: `${metadata.id}/coverage.json`,
    status: coverage.status,
  });
  process.stdout.write(`${metadata.id}: ${coverage.status}, ${coverage.character_count} characters\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
