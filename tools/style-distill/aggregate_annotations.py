#!/usr/bin/env python3
"""Aggregate completed annotation batches into auditable style evidence.

Input rows are the batch rows with ``annotation`` filled by a human or LLM.
The aggregator reports missing/invalid annotations instead of silently
pretending that an unreviewed sample is evidence.
"""

from __future__ import annotations

import argparse
import collections
import json
import sys
from pathlib import Path
from typing import Any


REQUIRED = {
    "entry_point", "reader_assumption", "material_order", "paragraph_function",
    "sentence_moves", "human_emotion", "concrete_detail", "thinking_model",
    "difficulty_and_cost", "anti_ai_risk", "confidence",
}


def annotation_errors(annotation: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    missing = sorted(REQUIRED - set(annotation))
    if missing:
        return [f"missing fields {','.join(missing)}"]
    for key in ("entry_point", "reader_assumption", "paragraph_function", "human_emotion", "concrete_detail", "thinking_model", "difficulty_and_cost"):
        if not isinstance(annotation.get(key), str) or not annotation[key].strip():
            errors.append(f"{key} is empty")
    for key in ("material_order", "sentence_moves"):
        value = annotation.get(key)
        if not isinstance(value, list) or not any(str(item).strip() for item in value):
            errors.append(f"{key} is empty")
    risks = annotation.get("anti_ai_risk")
    if not isinstance(risks, list) or len(risks) < 3:
        errors.append("anti_ai_risk must contain at least 3 checks")
    else:
        for index, risk in enumerate(risks):
            if not isinstance(risk, dict) or not all(str(risk.get(key) or "").strip() for key in ("type", "bad", "why_bad", "repair")):
                errors.append(f"anti_ai_risk[{index}] is incomplete")
    try:
        confidence = float(annotation.get("confidence"))
    except (TypeError, ValueError):
        errors.append("confidence is not numeric")
    else:
        if not 0 <= confidence <= 1:
            errors.append("confidence must be between 0 and 1")
    return errors


def read_rows(root: Path) -> tuple[list[dict[str, Any]], list[str]]:
    rows: list[dict[str, Any]] = []
    errors: list[str] = []
    for path in sorted(root.glob("**/batch-*.jsonl")):
        with path.open("r", encoding="utf-8") as handle:
            for line_no, line in enumerate(handle, 1):
                if not line.strip():
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError as exc:
                    errors.append(f"{path}:{line_no}: invalid JSON ({exc.msg})")
                    continue
                annotation = row.get("annotation")
                if not isinstance(annotation, dict):
                    errors.append(f"{path}:{line_no}: annotation missing")
                    continue
                problems = annotation_errors(annotation)
                if problems:
                    errors.append(f"{path}:{line_no}: {'; '.join(problems)}")
                    continue
                row["batch_file"] = str(path)
                rows.append(row)
    return rows, errors


def as_text(value: Any) -> str:
    if isinstance(value, list):
        return "；".join(as_text(item) for item in value)
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False, sort_keys=True)
    return str(value or "").strip()


def build_report(rows: list[dict[str, Any]], errors: list[str]) -> dict[str, Any]:
    authors: dict[str, Any] = {}
    for slug in sorted({str(row.get("author_slug", "unknown")) for row in rows}):
        author_rows = [row for row in rows if row.get("author_slug") == slug]
        functions = collections.Counter(as_text(row["annotation"]["paragraph_function"]) for row in author_rows)
        thinking = collections.Counter(as_text(row["annotation"]["thinking_model"]) for row in author_rows)
        risks = collections.Counter()
        risk_examples: list[dict[str, Any]] = []
        detail_examples: list[dict[str, Any]] = []
        difficulty_examples: list[dict[str, Any]] = []
        sentence_move_examples: list[dict[str, Any]] = []
        for row in author_rows:
            annotation = row["annotation"]
            for target, output, limit in (
                ("concrete_detail", detail_examples, 20),
                ("difficulty_and_cost", difficulty_examples, 20),
                ("sentence_moves", sentence_move_examples, 20),
            ):
                if len(output) < limit:
                    output.append({"sample_id": row.get("sample_id"), "value": annotation[target]})
            for risk in annotation.get("anti_ai_risk", []):
                if isinstance(risk, dict):
                    kind = str(risk.get("type") or "未分类").strip()
                    risks[kind] += 1
                    if len(risk_examples) < 30:
                        risk_examples.append({"sample_id": row.get("sample_id"), **risk})
        authors[slug] = {
            "author": author_rows[0].get("author", slug),
            "completed": len(author_rows),
            "avg_confidence": round(sum(float(row["annotation"].get("confidence", 0) or 0) for row in author_rows) / len(author_rows), 2),
            "paragraph_functions": functions.most_common(20),
            "thinking_models": thinking.most_common(20),
            "anti_ai_risks": risks.most_common(30),
            "risk_examples": risk_examples,
            "concrete_detail_examples": detail_examples,
            "difficulty_and_cost_examples": difficulty_examples,
            "sentence_move_examples": sentence_move_examples,
        }
    return {
        "version": "0.2",
        "completed": len(rows),
        "rejected_or_incomplete": len(errors),
        "authors": authors,
        "validation_errors": errors,
    }


def write_markdown(path: Path, report: dict[str, Any]) -> None:
    lines = ["# 标注聚合报告", "", "这份报告只统计已完成且字段齐全的样本；缺失标注不会被当成‘已通过’。", ""]
    lines += [f"- 已完成样本：{report['completed']}", f"- 未完成/不合格样本：{report['rejected_or_incomplete']}", ""]
    for slug, info in report["authors"].items():
        lines += [f"## {info['author']}", "", f"- 完成：{info['completed']} 条", f"- 平均置信度：{info['avg_confidence']}", "- 常见段落功能："]
        lines += [f"  - {name}：{count}" for name, count in info["paragraph_functions"]]
        lines += ["- 常见思维动作："]
        lines += [f"  - {name}：{count}" for name, count in info["thinking_models"]]
        lines += ["- 反 AI 风险："]
        lines += [f"  - {name}：{count}" for name, count in info["anti_ai_risks"]]
        lines.append("")
    if report["validation_errors"]:
        lines += ["## 需要返工的批次", ""]
        lines += [f"- {error}" for error in report["validation_errors"]]
        lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")


def write_author_evidence(root: Path, report: dict[str, Any]) -> None:
    """Write compact evidence files that can be loaded by the writing prompt."""
    for slug, info in report["authors"].items():
        lines = [
            f"# {info['author']} 标注证据 v0.2",
            "",
            "这份文件来自已通过字段审查的段落标注，不是口头禅列表，也不是原文复刻。写作时优先学习思维动作和材料安排。",
            "",
            f"- 已审阅样本：{info['completed']}",
            f"- 平均置信度：{info['avg_confidence']}",
            "",
            "## 高频思维动作",
            "",
        ]
        for name, count in info["thinking_models"][:20]:
            lines.append(f"- {name}（{count}）")
        lines += ["", "## 段落功能", ""]
        for name, count in info["paragraph_functions"][:20]:
            lines.append(f"- {name}（{count}）")
        lines += ["", "## 人物难度与具体细节", ""]
        for item in info["difficulty_and_cost_examples"][:12]:
            lines.append(f"- {item['value']}（样本 {item['sample_id']}）")
        lines += ["", "## 具体细节证据", ""]
        for item in info["concrete_detail_examples"][:12]:
            lines.append(f"- {item['value']}（样本 {item['sample_id']}）")
        lines += ["", "## 反 AI 风险与修复", ""]
        for item in info["risk_examples"][:24]:
            lines += [
                f"### {item.get('type', '未分类')}（样本 {item.get('sample_id')}）",
                f"- 坏例：{item.get('bad', '')}",
                f"- 问题：{item.get('why_bad', '')}",
                f"- 修复：{item.get('repair', '')}",
                "",
            ]
        (root / slug / "annotated_evidence.md").parent.mkdir(parents=True, exist_ok=True)
        (root / slug / "annotated_evidence.md").write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--batches", default="data/style-distill/annotation-batches")
    parser.add_argument("--out", default="data/style-distill/distilled-authors/annotation-report")
    parser.add_argument("--allow-incomplete", action="store_true", help="write a report without failing on missing/invalid rows")
    args = parser.parse_args()
    rows, errors = read_rows(Path(args.batches))
    report = build_report(rows, errors)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "annotation_summary.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    write_markdown(out / "annotation_report.md", report)
    write_author_evidence(Path("data/style-distill/distilled-authors/authors"), report)
    print(json.dumps({"completed": len(rows), "errors": len(errors), "out": str(out)}, ensure_ascii=False))
    return 2 if errors and not args.allow_incomplete else 0


if __name__ == "__main__":
    sys.exit(main())
