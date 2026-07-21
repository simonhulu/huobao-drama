#!/usr/bin/env python3
"""Create deterministic, reviewable LLM/manual annotation batches.

The batches are deliberately about writing decisions, not summaries. They are
safe to regenerate: sample IDs are content-derived and existing annotations
are never overwritten by this script.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any


LABELS = {"banfo": "半佛仙人", "bohai": "渤海小吏", "wenboling": "温伯陵"}
DIMENSIONS = [
    "entry_point",
    "reader_assumption",
    "material_order",
    "paragraph_function",
    "sentence_moves",
    "human_emotion",
    "concrete_detail",
    "thinking_model",
    "difficulty_and_cost",
    "anti_ai_risk",
]


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_no, line in enumerate(handle, 1):
            if not line.strip():
                continue
            value = json.loads(line)
            if not isinstance(value, dict):
                raise ValueError(f"{path}:{line_no} is not an object")
            rows.append(value)
    return rows


def existing_annotations(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    return {
        str(row.get("sample_id")): row.get("annotation")
        for row in read_jsonl(path)
        if row.get("sample_id") and row.get("annotation") is not None
    }


def sample_id(author_slug: str, article_id: str, paragraph_index: int, text: str) -> str:
    raw = f"{author_slug}|{article_id}|{paragraph_index}|{text}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:20]


def task_prompt(author: str, paragraph: str, previous: str, following: str) -> str:
    context = "\n".join(
        part for part in [
            f"上文：{previous}" if previous else "",
            f"待标注段落：{paragraph}",
            f"下文：{following}" if following else "",
        ] if part
    )
    return f"""你是中文非虚构写作的编辑，不要总结这段文章，也不要夸它。请分析{author}的写作决策。

{context}

请回答：
1. 这段为什么从这里切入，读者原本会怎么想？
2. 段落中每一句分别做了什么，不要抄句子，要写句法动作和信息动作。
3. 哪个具体细节让抽象判断变得可信？人物承受了什么压力，付出了什么代价？
4. 请逐项检查：主谓/修饰搭配、成语承受对象、代词指代、硬造比喻、半截动作、假反转、稳但虚、连续短句模板、上帝视角、成功节点缺困难/应对/代价。
5. 至少列出 3 个最可能的反 AI 风险，每个都给出坏例子和修复原则；没有明显风险时也要写明检查结果，不要留空。
6. 这段在全文大纲中负责什么，它怎样把读者推向下一段？

只返回 JSON，不要 Markdown：
{{
  "entry_point": "",
  "reader_assumption": "",
  "material_order": [],
  "paragraph_function": "",
  "sentence_moves": [],
  "human_emotion": "",
  "concrete_detail": "",
  "thinking_model": "",
  "difficulty_and_cost": "",
  "anti_ai_risk": [{{"type": "", "bad": "", "why_bad": "", "repair": ""}}],
  "confidence": 0
}}"""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--clean-root", default="data/style-distill/clean")
    parser.add_argument("--out", default="data/style-distill/annotation-batches")
    parser.add_argument("--examples-per-author", type=int, default=60)
    parser.add_argument("--batch-size", type=int, default=10)
    args = parser.parse_args()

    clean_root = Path(args.clean_root)
    out_root = Path(args.out)
    manifest: dict[str, Any] = {"version": "0.2", "dimensions": DIMENSIONS, "authors": {}}
    for author_dir in sorted(p for p in clean_root.iterdir() if p.is_dir()):
        source = author_dir / "articles.jsonl"
        if not source.exists():
            continue
        rows = read_jsonl(source)
        candidates: list[dict[str, Any]] = []
        for row in rows:
            paragraphs = row.get("paragraphs", [])
            if not isinstance(paragraphs, list):
                continue
            for index, paragraph in enumerate(paragraphs):
                if not isinstance(paragraph, str) or not 60 <= len(paragraph) <= 320:
                    continue
                candidates.append({
                    "article_id": str(row.get("article_id", "")),
                    "title": str(row.get("title", "")),
                    "paragraph_index": index,
                    "paragraph": paragraph,
                    "previous": paragraphs[index - 1] if index else "",
                    "following": paragraphs[index + 1] if index + 1 < len(paragraphs) else "",
                })
        # Stable spread across the corpus rather than simply taking the first articles.
        candidates.sort(key=lambda item: sample_id(author_dir.name, item["article_id"], item["paragraph_index"], item["paragraph"]))
        selected = candidates[: max(0, args.examples_per_author)]
        author_out = out_root / author_dir.name
        author_out.mkdir(parents=True, exist_ok=True)
        batch_paths: list[str] = []
        for batch_no, start in enumerate(range(0, len(selected), args.batch_size), 1):
            path = author_out / f"batch-{batch_no:03d}.jsonl"
            prior = existing_annotations(path)
            with path.open("w", encoding="utf-8") as handle:
                for item in selected[start:start + args.batch_size]:
                    sid = sample_id(author_dir.name, item["article_id"], item["paragraph_index"], item["paragraph"])
                    handle.write(json.dumps({
                        "sample_id": sid,
                        "author_slug": author_dir.name,
                        "author": LABELS.get(author_dir.name, author_dir.name),
                        "source": {k: item[k] for k in ("article_id", "title", "paragraph_index")},
                        "text": item["paragraph"],
                        "context": {"previous": item["previous"], "following": item["following"]},
                        "target_dimensions": DIMENSIONS,
                        "annotation_prompt": task_prompt(LABELS.get(author_dir.name, author_dir.name), item["paragraph"], item["previous"], item["following"]),
                        # Refresh prompts without deleting completed annotation work.
                        "annotation": prior.get(sid),
                    }, ensure_ascii=False) + "\n")
            batch_paths.append(str(path))
        manifest["authors"][author_dir.name] = {
            "author": LABELS.get(author_dir.name, author_dir.name),
            "candidate_paragraphs": len(candidates),
            "selected": len(selected),
            "batches": batch_paths,
        }
    (out_root / "manifest.json").parent.mkdir(parents=True, exist_ok=True)
    (out_root / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
