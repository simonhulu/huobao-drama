#!/usr/bin/env python3
"""
Clean exported Zhihu article JSON into JSONL for style distillation.

This script deliberately uses only the Python standard library so it can run in
the current repo without adding dependencies.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
from html.parser import HTMLParser
from pathlib import Path
from typing import Any


AUTHOR_FROM_FILE = {
    "半佛仙人": "banfo",
    "渤海小吏": "bohai",
    "温伯陵": "wenboling",
}


class ArticleHTMLParser(HTMLParser):
    BLOCK_TAGS = {
        "p",
        "br",
        "div",
        "h1",
        "h2",
        "h3",
        "h4",
        "li",
        "blockquote",
    }

    SKIP_TAGS = {"script", "style", "noscript"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skip_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in self.SKIP_TAGS:
            self.skip_depth += 1
            return
        if tag in self.BLOCK_TAGS:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in self.SKIP_TAGS and self.skip_depth:
            self.skip_depth -= 1
            return
        if tag in self.BLOCK_TAGS:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if self.skip_depth:
            return
        if data:
            self.parts.append(data)

    def text(self) -> str:
        raw = "".join(self.parts)
        return normalize_text(raw)


def normalize_text(raw: str) -> str:
    text = html.unescape(raw)
    text = text.replace("\u00a0", " ").replace("\u3000", " ")
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r" *\n+ *", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    lines = [line.strip() for line in text.splitlines()]
    return "\n".join(line for line in lines if line).strip()


def html_to_text(content: str) -> str:
    parser = ArticleHTMLParser()
    parser.feed(content or "")
    parser.close()
    return parser.text()


def split_paragraphs(text: str) -> list[str]:
    return [p.strip() for p in re.split(r"\n{1,}", text) if p.strip()]


def split_sentences(text: str) -> list[str]:
    pieces = re.split(r"(?<=[。！？!?；;])\s*", text)
    return [p.strip() for p in pieces if p.strip()]


def infer_author(path: Path, item: dict[str, Any]) -> tuple[str, str]:
    name = ""
    for author, slug in AUTHOR_FROM_FILE.items():
        if author in path.name:
            return author, slug
    raw_author = str(item.get("author") or "")
    for author, slug in AUTHOR_FROM_FILE.items():
        if author in raw_author:
            name = author
            return name, slug
    return path.stem, "unknown"


def stable_id(author_slug: str, item: dict[str, Any], text: str) -> str:
    basis = "|".join(
        [
            author_slug,
            str(item.get("id") or ""),
            str(item.get("title") or ""),
            text[:500],
        ]
    )
    return hashlib.sha256(basis.encode("utf-8")).hexdigest()[:16]


def clean_one_file(path: Path) -> list[dict[str, Any]]:
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, list):
        raise ValueError(f"{path} must contain a JSON array")

    cleaned: list[dict[str, Any]] = []
    seen_text_hashes: set[str] = set()

    for item in data:
        if not isinstance(item, dict):
            continue
        content = str(item.get("content") or "")
        text = html_to_text(content)
        if len(text) < 800:
            continue
        text_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
        if text_hash in seen_text_hashes:
            continue
        seen_text_hashes.add(text_hash)

        author, slug = infer_author(path, item)
        paragraphs = split_paragraphs(text)
        sentences = split_sentences(text)
        cleaned.append(
            {
                "article_id": stable_id(slug, item, text),
                "source_id": str(item.get("id") or ""),
                "author": author,
                "author_slug": slug,
                "title": normalize_text(str(item.get("title") or "")),
                "url": str(item.get("url") or ""),
                "created_time": str(item.get("created_time") or ""),
                "text": text,
                "paragraphs": paragraphs,
                "sentences": sentences,
                "char_count": len(text),
                "paragraph_count": len(paragraphs),
                "sentence_count": len(sentences),
            }
        )
    return cleaned


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="data/style-distill/clean")
    parser.add_argument("inputs", nargs="+")
    args = parser.parse_args()

    out_root = Path(args.out)
    all_rows: list[dict[str, Any]] = []
    summary: dict[str, Any] = {"authors": {}}

    for input_path in args.inputs:
        path = Path(input_path)
        rows = clean_one_file(path)
        if not rows:
            continue
        author_slug = rows[0]["author_slug"]
        write_jsonl(out_root / author_slug / "articles.jsonl", rows)
        all_rows.extend(rows)
        summary["authors"][author_slug] = {
            "author": rows[0]["author"],
            "articles": len(rows),
            "chars": sum(r["char_count"] for r in rows),
            "avg_chars": round(sum(r["char_count"] for r in rows) / len(rows)),
            "source_file": str(path),
        }

    write_jsonl(out_root / "all_articles.jsonl", all_rows)
    summary["total_articles"] = len(all_rows)
    summary["total_chars"] = sum(r["char_count"] for r in all_rows)
    (out_root / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
