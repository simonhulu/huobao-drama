#!/usr/bin/env python3
"""
Build first-pass style packs from cleaned article JSONL.

This is not a fine-tune. It creates operational artifacts for complex writing:
surface statistics, paragraph examples for manual/LLM annotation, and prompt
templates that force thinking-model extraction before prose imitation.
"""

from __future__ import annotations

import argparse
import collections
import json
import math
import re
from pathlib import Path
from typing import Any, Iterable


AUTHOR_LABELS = {
    "banfo": "半佛仙人",
    "bohai": "渤海小吏",
    "wenboling": "温伯陵",
}

CONNECTORS = [
    "所以",
    "但是",
    "但",
    "可",
    "因为",
    "如果",
    "于是",
    "其实",
    "当然",
    "问题是",
    "换句话说",
    "你要知道",
    "这也难怪",
    "说到底",
]

SHORT_JUDGMENT_PATTERNS = [
    "这很重要",
    "他不一样",
    "这就很残酷",
    "问题就在这里",
    "这才是关键",
    "这才是根子",
    "这就很讽刺",
]

FUNCTION_LABELS = [
    "开场钩子",
    "常识翻译",
    "利益账本",
    "局势摆盘",
    "手牌分析",
    "错误合理化",
    "连锁后果",
    "时代结构",
    "人物入局",
    "命运收束",
    "反讽补刀",
    "现实映射",
]


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def iter_sentences(rows: Iterable[dict[str, Any]]) -> Iterable[str]:
    for row in rows:
        for s in row.get("sentences", []):
            if isinstance(s, str) and s.strip():
                yield s.strip()


def iter_paragraphs(rows: Iterable[dict[str, Any]]) -> Iterable[str]:
    for row in rows:
        for p in row.get("paragraphs", []):
            if isinstance(p, str) and p.strip():
                yield p.strip()


def sentence_len_stats(sentences: list[str]) -> dict[str, Any]:
    lens = sorted(len(s) for s in sentences)
    if not lens:
        return {}
    def pct(q: float) -> int:
        idx = min(len(lens) - 1, max(0, math.floor(q * (len(lens) - 1))))
        return lens[idx]
    return {
        "count": len(lens),
        "avg": round(sum(lens) / len(lens), 1),
        "p25": pct(0.25),
        "p50": pct(0.50),
        "p75": pct(0.75),
        "p90": pct(0.90),
    }


def count_connectors(sentences: list[str]) -> list[dict[str, Any]]:
    counts = []
    for word in CONNECTORS:
        count = sum(s.count(word) for s in sentences)
        if count:
            counts.append({"word": word, "count": count})
    return sorted(counts, key=lambda x: x["count"], reverse=True)


def collect_examples(paragraphs: list[str], limit: int = 60) -> list[dict[str, Any]]:
    examples = []
    for p in paragraphs:
        if 60 <= len(p) <= 260:
            examples.append(
                {
                    "text": p,
                    "char_count": len(p),
                    "annotation_todo": {
                        "function": FUNCTION_LABELS,
                        "why_here": "",
                        "sentence_moves": [],
                        "risk_of_bad_imitation": "",
                    },
                }
            )
        if len(examples) >= limit:
            break
    return examples


def collect_short_judgment_hits(sentences: list[str]) -> list[dict[str, Any]]:
    hits = []
    for s in sentences:
        stripped = re.sub(r"[。！？!?\s]+$", "", s)
        if len(stripped) <= 18 or any(p in stripped for p in SHORT_JUDGMENT_PATTERNS):
            if any(p in stripped for p in SHORT_JUDGMENT_PATTERNS):
                hits.append({"sentence": s, "risk": "short_judgment_template"})
    return hits[:80]


def author_thinking_model(slug: str) -> str:
    if slug == "banfo":
        return """# 半佛型思维模型

不要蒸馏口头禅，蒸馏他如何把复杂商业问题翻译成普通人账本。

默认推理链：
1. 从一个荒诞、反常识、让人想骂的现象切入。
2. 先承认读者的直觉，然后把问题换成“谁赚钱、谁付账”。
3. 拆第一层账：表面谁占便宜。
4. 拆第二层账：成本被转移给谁。
5. 拆第三层账：规则为什么奖励这种行为。
6. 给普通人代入：你在这个系统里到底是什么位置。
7. 用反讽收束，但不能靠段子遮住逻辑。
"""
    if slug == "bohai":
        return """# 渤海小吏型思维模型

不要蒸馏战报腔，蒸馏他如何把人物放回当时局势。

默认推理链：
1. 先摆出后人熟悉的结论或争议。
2. 回到当时，把地图、资源、人物、压力摆出来。
3. 分析各方手里有什么牌，哪些牌不能打。
4. 解释后人看着蠢的选择，为什么在当时可能合理。
5. 写一个选择怎样推到下一个后果。
6. 让局势一步步收紧，直到人物只剩少数选择。
7. 最后下判断，但判断必须从局势里长出来。
"""
    return """# 温伯陵型思维模型

不要蒸馏宏大词，蒸馏他如何把人物放进长时段结构。

默认推理链：
1. 从一个具体物件、现象或行业切口进入。
2. 拉到长时段背景，说明这个问题不是突然出现。
3. 找出结构性矛盾：钱、权、制度、技术或人心如何互相推动。
4. 让人物入场，说明他为什么会被时代推到前台。
5. 写人物如何推动结构，结构又如何反过来吞掉人物。
6. 收到命运判断或现实映射，不要空喊历史规律。
"""


def write_style_card(out_dir: Path, slug: str, stats: dict[str, Any]) -> None:
    label = AUTHOR_LABELS.get(slug, slug)
    text = f"""# {label} 风格卡 v0.2

## 使用边界

这不是仿写提示词，不复刻作者原句、口头禅或特定表达。它只抽取写作决策、段落功能、思维模型和质检规则。

## 第一轮统计

- 文章数：{stats['article_count']}
- 总字数：{stats['char_count']}
- 句子长度：{json.dumps(stats['sentence_len'], ensure_ascii=False)}
- 高频连接词：{', '.join(f"{x['word']}({x['count']})" for x in stats['connectors'][:12])}

## 使用方式

1. 先用 `thinking_model.md` 生成逻辑大纲。
2. 再读取 `annotated_evidence.md`，学习已审阅样本里的思维动作、人物难度和具体细节。
3. 从 `paragraph_examples.jsonl` 抽段落功能，不直接抽句子。
4. 写作前读取 `anti_ai_language/sentence_judge.md`。
5. 生成后必须走作者风格质检和中文病句质检，并留下退稿记录。
"""
    (out_dir / "style_card.md").write_text(text, encoding="utf-8")


def write_prompt_templates(out_dir: Path, slug: str) -> None:
    label = AUTHOR_LABELS.get(slug, slug)
    template = f"""# {label} 蒸馏提示模板

## 单篇文章标注 Prompt

你要分析一篇 `{label}` 文章。不要总结内容，标注写作决策。

输出 JSON：

```json
{{
  "topic": "文章写什么",
  "entry_point": "为什么从这里切入",
  "reader_assumption": "读者原本以为什么",
  "author_counter": "作者反过来讲什么",
  "core_question": "全文真正回答的问题",
  "material_order": ["先讲什么", "再讲什么", "何时转机制", "何时下判断"],
  "paragraph_moves": [
    {{
      "paragraph_index": 0,
      "function": "开场钩子/常识翻译/利益账本/局势摆盘/手牌分析/命运收束等",
      "why_here": "为什么这一段必须放在这里",
      "sentence_moves": ["句法动作，不抄原句"],
      "bad_imitation_risk": "AI 学坏会写成什么"
    }}
  ],
  "outline_pattern": "抽象后的大纲",
  "diction_notes": {{
    "natural_words": [],
    "dangerous_to_copy": [],
    "anti_ai_repairs": []
  }}
}}
```

## 新题材写作 Prompt

给定题材后，先输出：
1. 作者式逻辑大纲；
2. 段落功能表；
3. 词语风险表；
4. 读取 `annotated_evidence.md` 后，列出本题可用的思维动作和具体细节类型；
5. 预计打回点；
6. 再写正文。

正文完成后，必须列出至少 10 条质检打回记录并重写。
"""
    (out_dir / "distill_prompts.md").write_text(template, encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--clean-root", default="data/style-distill/clean")
    parser.add_argument("--out", default="data/style-distill/distilled-authors/authors")
    args = parser.parse_args()

    clean_root = Path(args.clean_root)
    out_root = Path(args.out)
    out_root.mkdir(parents=True, exist_ok=True)

    summary: dict[str, Any] = {}
    for author_dir in sorted(p for p in clean_root.iterdir() if p.is_dir()):
        articles_path = author_dir / "articles.jsonl"
        if not articles_path.exists():
            continue
        rows = read_jsonl(articles_path)
        sentences = list(iter_sentences(rows))
        paragraphs = list(iter_paragraphs(rows))
        slug = author_dir.name
        out_dir = out_root / slug
        out_dir.mkdir(parents=True, exist_ok=True)

        stats = {
            "author": AUTHOR_LABELS.get(slug, slug),
            "article_count": len(rows),
            "char_count": sum(int(r.get("char_count", 0)) for r in rows),
            "sentence_len": sentence_len_stats(sentences),
            "connectors": count_connectors(sentences),
            "short_judgment_risks": collect_short_judgment_hits(sentences),
        }
        summary[slug] = stats
        (out_dir / "surface_stats.json").write_text(
            json.dumps(stats, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        (out_dir / "thinking_model.md").write_text(
            author_thinking_model(slug), encoding="utf-8"
        )
        with (out_dir / "paragraph_examples.jsonl").open("w", encoding="utf-8") as f:
            for example in collect_examples(paragraphs):
                f.write(json.dumps(example, ensure_ascii=False) + "\n")
        write_style_card(out_dir, slug, stats)
        write_prompt_templates(out_dir, slug)

    (out_root.parent / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2)[:4000])


if __name__ == "__main__":
    main()
