# Polish Video Script Book-Knowledge Design

> Superseded by `2026-07-31-book-grounded-full-script-blind-eval.md`. The static-card runtime
> described below failed to establish a net full-writing benefit and has been removed from production.

## Status

Conversion, source indexing, structured retrieval, and first-pass production distillation are
complete. The active corpus contains four books: the complete replacement EPUBs for 《秒赞》 and
《南周评论写作课》, 《文案的基本修养》, and 《中国小说描写辞典》. The dictionary has 959 page
units: 948 are directly usable and 11 remain marked for OCR review. The runtime index contains
163 production writing units across vocabulary, sentences, paragraphs, structures, and concrete
description. Full chapter/page semantic screening remains ongoing, so the current unit count is
useful production coverage rather than a claim that every reusable technique has been exhausted.

Blind evaluation also rejects a universal rewrite policy. The first isolated 12-item round gave
the enhanced writer 6 wins, 5 losses, and 1 tie, but exposed 3 unsupported-detail failures. After
writer examples were removed from runtime packets and an explicit fact boundary was added, the
same-item regression had no hard failures but scored 5 wins and 7 losses. This second round is not
an independent holdout. The operational conclusion is to retrieve selectively, allow the writer
to use no unit when the draft is already stronger, and judge the resulting prose rather than unit
usage. A fresh holdout is still required to establish general improvement.

## Goal

Improve the Chinese spoken-writing quality of `polish-video-script` by learning transferable craft from four approved books. The result must improve precision, readability, scene specificity, sentence rhythm, and human voice without copying source prose, weakening factual boundaries, or replacing retention structure with decorative writing.

Success means the skill can explain which writing technique it used, why that technique fits the current paragraph, and whether a blind comparison shows an improvement over the existing skill.

## Sources and roles

| Source | Primary role | Explicit non-role |
| --- | --- | --- |
| 《文案的基本修养》 | Audience, promise, creative judgment, expression purpose | Historical facts or a universal prose voice |
| 《秒赞》 | Titles, openings, memorability, concise spoken phrasing | A phrase bank or mandatory punch-line system |
| 《南周评论写作课：怎样表达一个观点》 | Fact organization, argument, counterargument, mechanism, paragraph and full-text structure | Fictional reconstruction authority |
| 《中国小说描写辞典》 | Actions, expressions, environments, sensory and concrete description | Copyable literary sentences or ornate diction by default |

Every chapter receives a processing result: extracted knowledge, reviewed-no-applicable-knowledge, or parse anomaly. Card count is not a proxy for source coverage.

## Domain rules

### Advanced wording

"Advanced wording" means choosing an expression that fits the sentence's semantic function, narrative position, and spoken rhythm. It does not mean replacing a common word with a more formal synonym.

For example, `然后` may signal chronological movement, causality, escalation, or only a weak splice. The correct repair may be to keep it, delete it, replace it with an action, reorder the sentence, or use a function-specific bridge. `进一步来说` is not an automatic upgrade.

### Fine-grained writing units

The runtime knowledge layer is not limited to high-level principles. It contains five unit kinds:

- lexical moves for semantic word choice and weak-connector repair;
- sentence patterns for information order, length, rhythm, and spoken clarity;
- paragraph patterns for focus, fact-opinion movement, transition, and argument;
- structure patterns for opening, explanation, escalation, and ending;
- description patterns for concrete objects, body movement, weather, crowd, space, and sensory effects.

Each unit records its use conditions, avoid conditions, executable operations, newly written
positive and negative examples, and source locators. The merged `writing-units.jsonl` index is
retrieved by deterministic metadata scoring. No vector database is required, and the Markdown
books are never placed wholesale into the model context.

### Technique cards

Each production card contains:

```json
{
  "id": "craft.transition.action-carry.v1",
  "status": "candidate | production | quarantined",
  "source_refs": [{ "book_id": "...", "locator": "chapter/page" }],
  "semantic_function": "what the expression must accomplish",
  "writing_stage": ["writer_pass", "editorial_audit"],
  "paragraph_functions": ["scene", "argument", "transition"],
  "genres": ["history", "philosophy", "general"],
  "temperature": ["cold", "warm", "hot"],
  "principle": "transferable rule",
  "use_when": ["conditions"],
  "avoid_when": ["conditions"],
  "moves": ["information-order or rhythm operations"],
  "positive_examples": ["newly written examples"],
  "negative_examples": ["newly written examples"],
  "audit_questions": ["questions with falsifiable answers"],
  "confidence": 0.0
}
```

Original prose remains in the offline Markdown corpus with chapter/page locators. Runtime examples
are newly written. The production unit files contain operations and locators, not source excerpts;
the corpus must never become a sentence-completion or imitation bank.

## Pipeline

```text
PDF / EPUB
  -> source fingerprint
  -> Markdown with chapter/page anchors
  -> parse and OCR quality report
  -> chapter inventory
  -> source-unit inventory and bounded evidence search
  -> candidate principles/cards/writing units/mistakes/evaluation items
  -> independent source and applicability review
  -> duplicate/conflict resolution
  -> blind A/B evaluation
  -> production assets
  -> routed writer packet and independent editorial audit
```

### Ingestion

- EPUB sources are converted by spine order and retain chapter headings and source-entry anchors.
- Image-only PDFs are OCRed page by page and retain `<!-- page: N -->` markers.
- Repeated headers, footers, isolated page numbers, and OCR artifacts are cleaned mechanically but raw page OCR remains reproducible.
- Empty, low-character, high-garbage, and failed pages enter the anomaly report instead of disappearing.
- Source manifests store the original filename, byte size, SHA-256, page or spine count, import timestamp, converter, and converter version.

### Distillation

Every source unit produces one of three coverage states: extracted knowledge,
reviewed-no-applicable-knowledge, or parse/OCR anomaly. Distillation can produce:

1. Writing principles.
2. High-level technique cards.
3. Applicable scenarios.
4. Newly written positive and negative examples.
5. Forbidden mistakes or hard-banned fixed expressions.
6. Fine-grained lexical, sentence, paragraph, structure, and description units.
7. Evaluation items with expected judgments and repair criteria.

Extraction is not approval. A second pass checks source fidelity, spoken-video applicability, duplication, conflict with existing contracts, and whether the rule is more specific than generic advice. Unsupported, purely literary, overgeneralized, or unstable cards are quarantined.

### Promotion

A card reaches `production` only when it has a valid source locator, passes the schema validator, survives independent review, and improves or does not regress the relevant blind-evaluation dimension. Promotion records are versioned. A production card may later be demoted when blind tests or release data show repeated harm.

## Runtime contract

The book-knowledge layer is subordinate to existing contracts:

```text
metrics and promise
  -> truth and narrator stance
  -> genre and retention structure
  -> beat and scene contract
  -> routed book-craft packet
  -> writer pass
  -> independent book-craft audit
```

The layer cannot alter topic, factual claims, central promise, genre, beat order, or retention structure. Before drafting a paragraph, deterministic metadata routing selects at most three high-level cards and a bounded fine-grained packet by semantic function, paragraph function, genre, temperature, object, scene, emotion, repair intent, and explicit weak terms. The fine-grained caps are two lexical moves, one sentence pattern, one paragraph pattern, one structure pattern, and two description patterns. `general` metadata is fallback context and never counts as an exact match. There is no usage quota.

The editorial audit judges the resulting prose, not card-name compliance. A card or writing unit
that produces stiffness, repetition, unsupported detail, or ornament without information gain has
failed even when applied exactly as written. Retrieval is an option set, not an instruction to
rewrite every sentence.

## Hard-banned expressions

Curated fixed AI phrases and fixed syntactic frames are hard gates. Any exact normalized match rejects the clean spoken script with no contextual waiver. Examples include `值得一提的是`, `众所周知`, `不可否认的是`, `接下来让我们`, and curated variants of formulaic `不是……而是……` frames.

Common spoken connectors such as `但是`, `后来`, and `所以` are not hard-banned. They are checked separately for semantic necessity and repetition frequency. Adding an expression to the hard list requires a specific pattern, examples, and a repair instruction; negative-example words do not automatically become banned.

## Evaluation

Use a fixed holdout set spanning openings, scene narration, factual explanation, transitions, emotional turns, and endings. For every item, generate or repair with the baseline skill and the book-enhanced skill while keeping upstream contracts identical. Hide version identity during paired review.

Score:

- spoken naturalness;
- lexical precision;
- sentence-shape variation;
- concrete imagery and useful detail;
- logic and narrative movement;
- hard-ban compliance and AI-pattern density;
- over-writing, source imitation, or factual drift.

Automated checks prove only hard constraints and measurable patterns. Promotion depends on paired blind preference. Real publication retention and completion data can validate or overturn lab results, but writing cards must not claim causality from a single release.

## Repository layout

```text
.codex/skills/polish-video-script/
  sources/books/
    manifest.json
    <book-id>/book.md
    <book-id>/coverage.json
  knowledge/books/
    writing-units.jsonl
    by-source/*.jsonl
    source-unit-inventory.json
    writing-evaluation-items.jsonl
    technique-cards.jsonl
    principles.jsonl
    hard-banned-expressions.json
    evaluation-items.jsonl
    promotion-log.jsonl
  references/book-craft-layer.md
  scripts/import-writing-book.mjs
  scripts/build-source-inventory.mjs
  scripts/search-book-source.mjs
  scripts/retrieve-writing-knowledge.mjs
  scripts/merge-writing-knowledge.mjs
  scripts/validate-book-knowledge.mjs
  scripts/scan-hard-banned-expressions.mjs
  tests/book-knowledge.test.mjs
```

The original binaries remain in the user's source location. Git stores Markdown source text and derived assets. Absolute source paths are import inputs only and never become runtime dependencies.

## Completion criteria

- All four source fingerprints match the approved files.
- EPUB conversion preserves spine order; the scanned dictionary has page-level OCR coverage.
- Every chapter/page has a processed or anomalous status.
- All production cards validate and have source locators.
- Clean-script hard-ban scanning has tests for exact and normalized matches.
- Writer routing returns no more than three relevant production cards.
- Baseline versus enhanced blind-evaluation results are persisted, including ties and regressions.
- `polish-video-script` references the book-craft layer in writer and editorial stages only.
