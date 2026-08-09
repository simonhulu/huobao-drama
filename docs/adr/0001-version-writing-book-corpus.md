---
status: superseded by ADR-0002
---

# Version the extracted writing-book corpus with the skill

`polish-video-script` keeps Markdown extracted from the four approved writing books in Git, while the original PDF and EPUB binaries remain outside the repository and are identified by SHA-256. This makes every derived writing rule reproducible and reviewable without adding the binary sources or relying on machine-specific absolute paths. The choice deliberately accepts a larger text repository; removing the corpus later would require a history-rewrite decision if it has already been pushed.

The corpus is never loaded wholesale into a production prompt. It is an offline evidence source for versioned writing units, technique cards, hard-banned expressions, evaluation items, and coverage reports. Runtime retrieval uses the committed JSONL index and deterministic field scoring; it does not require a vector database. Each paragraph receives a bounded packet of relevant lexical moves, sentence patterns, paragraph patterns, structure patterns, and description patterns. Runtime examples are newly written, and source excerpts are never exposed as a copyable phrase bank.
