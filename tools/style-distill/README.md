# Style Distillation Pipeline

This pipeline turns exported author article JSON into operational writing assets.
It is designed for complex Chinese long-form writing, not surface imitation.

## Run

```bash
python3 tools/style-distill/clean_articles.py \
  "/Users/zhangshijie/Downloads/[用户文章] (99+ 封私信 _ 80 条消息) 半佛仙人_20260721 (共136条).json" \
  "/Users/zhangshijie/Downloads/[用户文章] (99+ 封私信 _ 80 条消息) 渤海小吏_20260721 (共137条).json" \
  "/Users/zhangshijie/Downloads/[用户文章] (99+ 封私信 _ 80 条消息) 温伯陵_20260721 (共136条).json"

python3 tools/style-distill/build_author_style_pack.py

python3 tools/style-distill/make_annotation_batches.py

# 完成批次中的 annotation 字段后运行；有缺失时默认失败
python3 tools/style-distill/aggregate_annotations.py

# 仅在查看中间进度时使用
python3 tools/style-distill/aggregate_annotations.py --allow-incomplete
```

## Output

- `data/style-distill/clean/*/articles.jsonl`: cleaned article corpus.
- `data/style-distill/distilled-authors/authors/*/style_card.md`: author style card.
- `data/style-distill/distilled-authors/authors/*/thinking_model.md`: thinking model.
- `data/style-distill/distilled-authors/authors/*/paragraph_examples.jsonl`: examples to annotate.
- `data/style-distill/distilled-authors/anti_ai_language/*`: anti-AI language guardrails.
- `data/style-distill/distilled-authors/hybrid/*`: hybrid writing system for commercial history scripts.
- `data/style-distill/annotation-batches/*`: deterministic paragraph annotation tasks.
- `data/style-distill/distilled-authors/annotation-report/*`: only completed annotation evidence and validation failures.
- `data/style-distill/distilled-authors/authors/*/annotated_evidence.md`: author-specific evidence fed back into complex writing prompts.
- `data/style-distill/distilled-authors/authors/*/outline_patterns.json`: author outline generators.
- `data/style-distill/distilled-authors/authors/*/paragraph_moves.jsonl`: paragraph-function library.
- `data/style-distill/distilled-authors/authors/*/sentence_moves.jsonl`: sentence-action library.
- `data/style-distill/distilled-authors/authors/*/anti_ai_negative_samples.jsonl`: rejected sentence library.
- `data/style-distill/distilled-authors/authors/*/qa_gate.md`: author-specific review gate.
- `data/style-distill/distilled-authors/hybrid/writing_os.md`: executable orchestration order.
- `data/style-distill/distilled-authors/hybrid/style_router.json`: weighted module router.
- `data/style-distill/distilled-authors/hybrid/final_qa.md`: final structural, author, and human-language gate.

## Review contract

The generated packs are not considered fully distilled until the annotation batches are completed and aggregated. A writing run must produce a rejection log, repair the rejected lines, and pass a second review for author logic, human diction, subject-predicate fit, pronoun reference, natural imagery, closed actions, and difficulty/cost at turning points.

## Principle

Do not copy catchphrases. Extract writing decisions:

1. Why this entry point.
2. Why this material order.
3. What each paragraph does.
4. How abstract concepts become ordinary human scenes.
5. What sentence-level mistakes must be rejected.
