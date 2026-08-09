#!/usr/bin/env node

// Render paragraph-locks.jsonl from the production run + the final script.
//
// Every field of a lock is derivable: the ids and the reader-relay text come from
// production-run.json's beats, and first_sentence / bridge_quote are spans of the paragraph
// itself. Hand-writing them meant transcribing the run file by hand and then having the
// validator check whether the transcription was faithful — an author checking their own
// copying, which is the failure mode this script removes.
//
// Usage:
//   node render-paragraph-locks.mjs --file <production-run.json> --script <final.md> \
//     [--out <paragraph-locks.jsonl>] [--check]
//
//   --out    write to this path (default: <run dir>/paragraph-locks.jsonl)
//   --check  do not write; exit 1 if the file on disk differs from what would be rendered

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// Must match splitScriptParagraphs in validate-production-run.mjs exactly, or the rendered
// locks will not line up with the paragraphs the validator sees.
function splitScriptParagraphs(scriptText) {
  return scriptText
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

const SENTENCE_END = /[。！？!?]["'」』）)]*/g;

// Sentence spans of a paragraph, each including its terminal punctuation. A trailing
// fragment with no end punctuation still counts as a sentence.
function sentenceSpans(paragraph) {
  const spans = [];
  let start = 0;
  for (const match of paragraph.matchAll(SENTENCE_END)) {
    const end = match.index + match[0].length;
    const text = paragraph.slice(start, end).trim();
    if (text) spans.push(text);
    start = end;
  }
  const tail = paragraph.slice(start).trim();
  if (tail) spans.push(tail);
  return spans;
}

function firstSentenceOf(paragraph) {
  const spans = sentenceSpans(paragraph);
  if (spans.length === 0) return paragraph;
  // The validator requires paragraph.startsWith(first_sentence); a paragraph never begins
  // with leading whitespace after trim, so the first span is a true prefix.
  return spans[0];
}

// The bridge is the forward-leaning tail the writer contract requires of every paragraph but
// the last. Take the final sentence; if it is very short (a hard-stop beat like 「他没走。」),
// include the one before it so the quote is substantial enough to be a meaningful anchor.
function bridgeQuoteOf(paragraph) {
  const spans = sentenceSpans(paragraph);
  if (spans.length === 0) return undefined;
  const last = spans[spans.length - 1];
  if (spans.length >= 2 && last.length < 12) {
    return spans[spans.length - 2] + last;
  }
  return last;
}

// Derive the question-id chain exactly as the validator does: the first beat inherits the open
// loop's id, a `carry` keeps the incoming id, an `answer` mints the next one. Both sides must
// derive it the same way or the locks will not match the run.
function deriveQuestionChain(run) {
  const beats = Array.isArray(run?.beats) ? run.beats : [];
  const openLoopId = run?.retention?.open_loop_id;
  const seed = /^Q(\d+)$/.exec(String(openLoopId ?? ""));
  let counter = seed ? Number(seed[1]) : 1;
  let incoming = openLoopId || "Q1";

  return beats.map((beat) => {
    const questionInId = incoming;
    let questionOutId = questionInId;
    if (beat?.reader_relay?.resolution === "answer") {
      counter += 1;
      questionOutId = "Q" + counter;
    }
    // `RESOLVED` is the terminal sentinel a final beat may declare to close the chain.
    if (beat?.reader_relay?.question_out_id === "RESOLVED") {
      questionOutId = "RESOLVED";
    }
    incoming = questionOutId;
    return { questionInId, questionOutId };
  });
}

function renderLocks(run, scriptText) {
  const beats = Array.isArray(run?.beats) ? run.beats : [];
  const paragraphs = splitScriptParagraphs(scriptText);
  const chain = deriveQuestionChain(run);
  const problems = [];

  if (paragraphs.length !== beats.length) {
    problems.push(
      "final script has " + paragraphs.length + " paragraphs but the run declares " +
        beats.length + " beats — the validator requires them to be equal, so fix the draft " +
        "or the beat map before rendering locks"
    );
  }

  const locks = [];
  const count = Math.min(paragraphs.length, beats.length);
  for (let index = 0; index < count; index += 1) {
    const paragraph = paragraphs[index];
    const beat = beats[index];
    const relay = beat?.reader_relay || {};

    const lock = {
      paragraph_index: index + 1,
      beat_id: beat?.id,
      // `facts_known_before` is optional in the minimal beat contract; the previous beat's
      // outgoing question is the honest fallback for "what the listener is holding here".
      listener_knows: Array.isArray(relay.facts_known_before)
        ? relay.facts_known_before.join("；")
        : relay.facts_known_before ||
          (index > 0 ? beats[index - 1]?.reader_relay?.question_out : undefined) ||
          relay.question_in,
      listener_asks: relay.question_in,
      question_in_id: chain[index]?.questionInId,
      question_out_id: chain[index]?.questionOutId,
      fact_ids_used: Array.isArray(beat?.fact_ids) ? [...beat.fact_ids] : [],
      first_sentence: firstSentenceOf(paragraph),
      // Optional in the minimal contract. When the beat does not spell out the belief change,
      // the outgoing question is what the paragraph actually contributed to the chain.
      new_contribution: beat?.reader_belief_change || relay.question_out
    };

    // The last paragraph has nothing to bridge to, and the validator only requires a
    // bridge_quote on paragraphs before the final one.
    if (index < count - 1) {
      const bridge = bridgeQuoteOf(paragraph);
      if (bridge) lock.bridge_quote = bridge;
    }

    for (const [key, value] of Object.entries(lock)) {
      const empty = value === undefined ||
        (typeof value === "string" && value.trim().length === 0) ||
        (Array.isArray(value) && value.length === 0);
      if (empty) {
        problems.push(
          "paragraph " + (index + 1) + ": cannot derive " + key +
            " — beat " + (beat?.id || "<missing id>") + " is missing the source field"
        );
      }
    }

    locks.push(lock);
  }

  return { locks, problems };
}

function serialize(locks) {
  return locks.map((lock) => JSON.stringify(lock)).join("\n") + "\n";
}

function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function main() {
  const runFile = arg("--file");
  const scriptFile = arg("--script");
  const check = process.argv.includes("--check");

  if (!runFile || !scriptFile) {
    process.stderr.write(
      "Usage: node render-paragraph-locks.mjs --file <production-run.json> " +
        "--script <final.md> [--out <paragraph-locks.jsonl>] [--check]\n"
    );
    process.exitCode = 2;
    return;
  }

  let run;
  let scriptText;
  try {
    run = JSON.parse(fs.readFileSync(path.resolve(runFile), "utf8"));
    scriptText = fs.readFileSync(path.resolve(scriptFile), "utf8");
  } catch (error) {
    process.stderr.write("Unable to read inputs: " + error.message + "\n");
    process.exitCode = 2;
    return;
  }

  const outFile = arg("--out") ||
    path.join(path.dirname(path.resolve(runFile)), "paragraph-locks.jsonl");

  const { locks, problems } = renderLocks(run, scriptText);

  if (problems.length > 0) {
    process.stderr.write("REJECT paragraph locks\n");
    for (const problem of problems) process.stderr.write("- " + problem + "\n");
    process.exitCode = 1;
    return;
  }

  const rendered = serialize(locks);

  if (check) {
    const existing = fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8") : "";
    if (existing !== rendered) {
      process.stderr.write(
        "paragraph-locks.jsonl is stale or hand-edited — re-render it with " +
          "render-paragraph-locks.mjs (locks are machine-derived from the run and the script)\n"
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write("PASS paragraph locks match the run and the script\n");
    return;
  }

  fs.writeFileSync(outFile, rendered, "utf8");
  process.stdout.write("Wrote " + locks.length + " paragraph locks to " + outFile + "\n");
}

export { renderLocks, serialize, splitScriptParagraphs, sentenceSpans, firstSentenceOf, bridgeQuoteOf };

const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(path.resolve(process.argv[1])) ===
      fs.realpathSync(new URL(import.meta.url).pathname);
  } catch {
    return false;
  }
})();
if (invokedDirectly) main();
