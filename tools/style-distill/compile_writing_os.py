#!/usr/bin/env python3
"""Compile annotation batches into an executable writing operating system.

This turns evidence into routing files, paragraph/sentence move libraries,
negative examples, and QA gates. It does not copy source prose into prompts.
"""

from __future__ import annotations

import argparse
import collections
import json
from pathlib import Path
from typing import Any


LABELS = {"banfo": "半佛仙人", "bohai": "渤海小吏", "wenboling": "温伯陵"}

OUTLINE_PATTERNS = {
    "banfo": [
        "从荒诞现象切入",
        "承认读者直觉，再把问题翻译成谁赚钱、谁付账",
        "拆第一层账：表面谁占便宜",
        "拆第二层账：成本转移给谁",
        "拆第三层账：规则为什么奖励它继续发生",
        "把普通人放回账单里",
        "用事实反讽收束，不用空泛道德总结",
    ],
    "bohai": [
        "先摆出后人熟悉的结论或争议",
        "回到当时，摆地图、人物、资源和压力",
        "分析各方手里的牌与不能打的牌",
        "解释看似愚蠢的选择为什么在当时合理",
        "写一个选择如何推到下一个后果",
        "让局势逐步收紧，直到只剩少数选择",
        "让判断从局势里长出来",
    ],
    "wenboling": [
        "从具体物件、现象或身体经验切入",
        "拉到长时段背景",
        "找出钱、权、制度、技术或人心的结构矛盾",
        "让人物成为被时代推到前台的人",
        "写人物推动结构，结构反过来吞掉人物",
        "收束到命运判断或现实映射",
    ],
}

ROUTERS = {
    "business_logic": {"banfo": 0.55, "bohai": 0.15, "wenboling": 0.10},
    "situation_analysis": {"banfo": 0.10, "bohai": 0.55, "wenboling": 0.15},
    "historical_depth": {"banfo": 0.10, "bohai": 0.20, "wenboling": 0.35},
    "fate_theme": {"banfo": 0.10, "bohai": 0.25, "wenboling": 0.45},
    "human_diction": {"banfo": 0.25, "bohai": 0.25, "wenboling": 0.25},
}


def read_completed(root: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for path in sorted(root.glob("**/batch-*.jsonl")):
        with path.open(encoding="utf-8") as handle:
            for line in handle:
                if not line.strip():
                    continue
                row = json.loads(line)
                if isinstance(row.get("annotation"), dict):
                    rows.append(row)
    return rows


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")


def qa_gate(author: str) -> str:
    return f"""# {author} 作者风格 QA Gate

逐段检查，任一项失败就退回：

1. 本段是否有明确功能，而不是只在搬运资料？
2. 是否采用了 {author} 的思维动作，而不是复制口头禅或句子？
3. 判断前是否有事实、动作、数字、关系或具体物件铺垫？
4. 关键选择是否写出当时能看到的手牌、困难、应对和代价？
5. 是否出现主谓误配、成语对象错位、悬空代词、硬造比喻或半截动作？
6. 是否把“稳但虚”的表达换成了自然、可理解、能产生画面的说法？
7. 是否连续使用“事实—短判断—转折—总结”的同构节奏？

退回必须记录：原句、问题类型、读者为什么会卡住、重写要补什么、修复句。没有退回记录不代表通过，必须说明本段检查了什么。
"""


def final_qa() -> str:
    return """# 最终 QA Gate

## 结构质检

- 主轴回答的是人物如何活、如何选择、付出什么，而不是资料发生了什么。
- 每个关键成功节点都回答：难在哪里、普通人为什么熬不住、人物靠什么扛住、谁为此付账。
- 关键转折至少有一个场景级展开，不用一句“后来证明他押对了”带过。
- 段落功能顺序有变化，不能整篇重复同一个事实—总结模板。

## 作者思维质检

- 商业机制调用半佛：利益链、成本、账单落到谁身上。
- 人物选择调用渤海：当时有哪些牌、哪些牌不能打、压力如何收紧。
- 命运与时代调用温伯陵：结构如何把人物推上去，又如何反过来收取代价。
- 每段标注了所用模块和句法动作；不能只写“像某作者”。

## 中文人话质检

- 主语能承受谓语和形容词。
- 成语落在正确的人或对象身上。
- “它/这/这个事情”都有明确指代。
- 比喻是自然汉语，不写“钱的水流旁边”这类硬画面。
- 动作有闭环，写清人物看见、算出、决定、忍住或失去什么。
- 不用空泛的“具有不确定性”，优先写可理解的处境和后果。

## 交付门槛

至少两轮返工，并附 JSONL 打回记录。没有打回记录的稿件默认不合格。
"""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--batches", default="data/style-distill/annotation-batches")
    parser.add_argument("--out", default="data/style-distill/distilled-authors")
    args = parser.parse_args()
    rows = read_completed(Path(args.batches))
    if not rows:
        raise SystemExit("no completed annotations")
    out = Path(args.out)
    by_author: dict[str, list[dict[str, Any]]] = collections.defaultdict(list)
    for row in rows:
        by_author[str(row["author_slug"])].append(row)

    for slug, author_rows in by_author.items():
        author_out = out / "authors" / slug
        paragraph_moves = []
        sentence_moves = []
        negatives = []
        for row in author_rows:
            ann = row["annotation"]
            common = {"author": LABELS.get(slug, slug), "sample_id": row["sample_id"], "source_title": row["source"].get("title")}
            paragraph_moves.append({**common, "function": ann["paragraph_function"], "why_here": ann["entry_point"], "thinking_model": ann["thinking_model"], "concrete_detail": ann["concrete_detail"], "difficulty_and_cost": ann["difficulty_and_cost"]})
            for move in ann["sentence_moves"]:
                sentence_moves.append({**common, "sentence_move": move, "abstract_pattern": ann["thinking_model"], "anti_template_warning": ann["anti_ai_risk"][:3]})
            for risk in ann["anti_ai_risk"]:
                negatives.append({**common, "bad_sentence": risk["bad"], "problem": risk["type"], "why_bad": risk["why_bad"], "repair": risk["repair"]})
        write_json(author_out / "outline_patterns.json", {"author": LABELS.get(slug, slug), "patterns": OUTLINE_PATTERNS[slug], "sample_count": len(author_rows)})
        write_jsonl(author_out / "paragraph_moves.jsonl", paragraph_moves)
        write_jsonl(author_out / "sentence_moves.jsonl", sentence_moves)
        write_jsonl(author_out / "anti_ai_negative_samples.jsonl", negatives)
        (author_out / "qa_gate.md").write_text(qa_gate(LABELS.get(slug, slug)), encoding="utf-8")

    hybrid = out / "hybrid"
    write_json(hybrid / "style_router.json", {"hybrid_style": "商业历史人物口播", "weights": ROUTERS, "routing_rule": "按段落任务选择模块，不平均混合；具体句子由反 AI 质检器兜底。"})
    (hybrid / "final_qa.md").write_text(final_qa(), encoding="utf-8")
    (hybrid / "writing_os.md").write_text("""# 商业历史人物写作操作系统 v0.2

输入题材后，先锁定人生主轴，再通过 `style_router.json` 选择段落模块；随后读取对应作者的 `outline_patterns.json`、`paragraph_moves.jsonl` 和 `sentence_moves.jsonl`，只学习写作决策，不复制原句。

执行顺序：选题与主轴 -> 风格路由 -> 作者式逻辑大纲 -> 段落功能表 -> 逐段生成 -> 作者 QA Gate -> 反 AI 负样本扫描 -> 结构深度复审 -> 返工 -> 最终 QA。

每一段交付时必须能回答：这段在全文中做什么、为什么现在出现、用了哪个作者模块、人物或普通人承受了什么、下一段被什么问题推动出来。任何一步答不上来，退回大纲，不直接润色句子。
""", encoding="utf-8")
    print(json.dumps({"completed_annotations": len(rows), "authors": {slug: len(items) for slug, items in by_author.items()}, "out": str(out)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
