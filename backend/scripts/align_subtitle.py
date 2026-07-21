#!/usr/bin/env python3
"""
用 FunASR Paraformer 对中文 TTS 音频做字幕时间码对齐。
输入：音频文件路径 + 原始文本
输出：JSON 时间码 + ASS 字幕文件
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path


def align_sequences(recognized: list[str], original: list[str]):
    """
    用编辑距离把识别出的字符序列对齐回原始文本。
    返回：original 中每个字符对应的 recognized 下标，无法对齐时为 None。
    """
    n = len(recognized)
    m = len(original)
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        dp[i][0] = i
    for j in range(1, m + 1):
        dp[0][j] = j

    for i in range(1, n + 1):
        for j in range(1, m + 1):
            cost = 0 if recognized[i - 1] == original[j - 1] else 1
            dp[i][j] = min(
                dp[i - 1][j - 1] + cost,
                dp[i - 1][j] + 1,
                dp[i][j - 1] + 1,
            )

    aligned_indices = [None] * m
    i, j = n, m
    while i > 0 and j > 0:
        cost = 0 if recognized[i - 1] == original[j - 1] else 1
        if dp[i][j] == dp[i - 1][j - 1] + cost:
            if cost == 0:
                aligned_indices[j - 1] = i - 1
            i -= 1
            j -= 1
        elif dp[i][j] == dp[i - 1][j] + 1:
            i -= 1
        else:
            j -= 1

    return aligned_indices


def interpolate_missing_timestamps(timestamps: list[tuple[int, int]]):
    """
    对时间戳为 (0,0) 的字符做线性插值。
    假设开头和结尾的静音不超过 500ms。
    """
    n = len(timestamps)
    result = list(timestamps)

    # 找第一个有效时间戳，把前面的 (0,0) 也赋一个合理值
    first_valid = -1
    for i in range(n):
        if result[i][1] > result[i][0] > 0:
            first_valid = i
            break
    if first_valid > 0:
        start = max(0, result[first_valid][0] - 200)
        step = (result[first_valid][0] - start) / first_valid
        for i in range(first_valid):
            s = int(start + step * i)
            e = int(start + step * (i + 1))
            result[i] = (s, e)

    # 找最后一个有效时间戳
    last_valid = -1
    for i in range(n - 1, -1, -1):
        if result[i][1] > result[i][0] > 0:
            last_valid = i
            break
    if last_valid >= 0 and last_valid < n - 1:
        end = result[last_valid][1] + 200
        step = (end - result[last_valid][1]) / (n - last_valid)
        for i in range(last_valid + 1, n):
            s = int(result[last_valid][1] + step * (i - last_valid - 1))
            e = int(result[last_valid][1] + step * (i - last_valid))
            result[i] = (s, e)

    # 中间缺失的线性插值
    i = 0
    while i < n:
        if result[i][0] == 0 and result[i][1] == 0:
            j = i
            while j < n and result[j][0] == 0 and result[j][1] == 0:
                j += 1
            if i > 0 and j < n:
                prev_start, prev_end = result[i - 1]
                next_start, next_end = result[j]
                gap = next_start - prev_end
                count = j - i + 1
                for k in range(i, j):
                    ratio = (k - i + 1) / count
                    s = int(prev_end + gap * (k - i) / count)
                    e = int(prev_end + gap * (k - i + 1) / count)
                    result[k] = (s, e)
            i = j
        else:
            i += 1

    return result


def normalize_text(text: str) -> str:
    """去掉 CJK 字符间空格，合并换行，用于对齐。"""
    text = re.sub(r"([\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])", r"\1", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def split_into_cues(chars: list[str], timestamps: list[tuple[int, int]], max_chars: int = 20):
    """
    把字符序列按标点切分成字幕句。
    规则：
    - 句末标点（。！？；\n）切分
    - 停顿标点（，、：）且当前 cue 已较长时切分
    - 强制切分时优先在停顿标点前切分，避免把单个字或标点单独成 cue
    - 末尾孤立的标点合并回前一个 cue
    """
    sentence_end_marks = set("。！？；\n")
    pause_marks = set("，、：")
    all_punctuations = set("，。！？、；：\"'\"'（）【】")

    cues: list[dict] = []
    current_chars: list[str] = []
    current_times: list[tuple[int, int]] = []

    def flush():
        if current_chars:
            text = "".join(current_chars).strip()
            start = current_times[0][0]
            end = current_times[-1][1]
            if end > start and text:
                cues.append({"text": text, "startMs": start, "endMs": end})
            current_chars.clear()
            current_times.clear()

    def is_mostly_punctuation(text: str) -> bool:
        return len([c for c in text if c in all_punctuations]) > len(text) * 0.5

    for i, (ch, (s, e)) in enumerate(zip(chars, timestamps)):
        current_chars.append(ch)
        current_times.append((s, e))

        if ch in sentence_end_marks:
            flush()
        elif ch in pause_marks and len(current_chars) >= max_chars:
            flush()
        elif len(current_chars) >= max_chars * 2:
            # 强制切分：从末尾往前找最近的停顿标点
            split_idx = -1
            for k in range(len(current_chars) - 1, max_chars // 2, -1):
                if current_chars[k] in pause_marks:
                    split_idx = k + 1
                    break
            if split_idx > 0:
                remainder_chars = current_chars[split_idx:]
                remainder_times = current_times[split_idx:]
                current_chars = current_chars[:split_idx]
                current_times = current_times[:split_idx]
                flush()
                current_chars = remainder_chars
                current_times = remainder_times
            else:
                flush()

    flush()

    # 合并末尾孤立的标点小 cue
    merged: list[dict] = []
    for cue in cues:
        if merged and is_mostly_punctuation(cue["text"]) and len(cue["text"]) <= 2:
            merged[-1]["text"] += cue["text"]
            merged[-1]["endMs"] = cue["endMs"]
        else:
            merged.append(cue)

    return merged


def wrap_ass_text(text: str, font_size: int = 48, play_res_x: int = 1920, margin: int = 60) -> str:
    """ASS 中文自动换行，优先在标点处断开。

    默认 margin=60（两侧共留 120px），让每行能容纳约 40 个汉字，
    避免行长短、居中后两侧留白过大的问题。
    """
    char_width = font_size * 0.9
    max_chars = max(10, min(42, int((play_res_x - margin * 2) / char_width)))

    pause_marks = set("，。！？、；：")

    def wrap_line(line: str) -> list[str]:
        trimmed = line.strip()
        if len(trimmed) <= max_chars:
            return [trimmed]

        # 找最佳断点：不超过 max_chars 的前提下，尽量靠右的停顿标点
        best_idx = max_chars
        for k in range(max_chars, max_chars // 2, -1):
            if trimmed[k] in pause_marks:
                best_idx = k + 1
                break
        first = trimmed[:best_idx].rstrip()
        rest = trimmed[best_idx:].lstrip()
        return [first] + wrap_line(rest)

    lines = []
    for line in text.split("\n"):
        lines.extend(wrap_line(line))
    return "\n".join(lines)


def format_ass_time(total_seconds: float) -> str:
    h = int(total_seconds // 3600)
    m = int((total_seconds % 3600) // 60)
    s = int(total_seconds % 60)
    cs = int(round((total_seconds % 1) * 100))
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def generate_ass(cues: list[dict], config: dict) -> str:
    """生成 ASS 字幕文件。"""
    font = config.get("font", "PingFang SC")
    size = config.get("size", 48)
    color = config.get("color", "#FFFFFF")
    position = config.get("position", "bottom")

    color = color.lstrip("#")
    if len(color) != 6:
        ass_color = "&H00FFFFFF"
    else:
        r, g, b = color[0:2], color[2:4], color[4:6]
        ass_color = f"&H00{b}{g}{r}"

    alignment = {"top": 8, "middle": 5, "bottom": 2}.get(position, 2)

    lines = [
        "[Script Info]",
        "Title: Huobao Subtitle",
        "ScriptType: v4.00+",
        "PlayResX: 1920",
        "PlayResY: 1080",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        f"Style: Default,{font},{size},{ass_color},&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,{alignment},20,20,40,1",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]

    def escape_ass(text: str) -> str:
        return text.replace("\\", "\\\\").replace("{", "\\{").replace("}", "\\}").replace("\n", "\\N")

    for cue in cues:
        start = format_ass_time(cue["startMs"] / 1000.0)
        end = format_ass_time(cue["endMs"] / 1000.0)
        wrapped = wrap_ass_text(cue["text"], font_size=size)
        text = escape_ass(wrapped)
        lines.append(f"Dialogue: 0,{start},{end},Default,,0,0,0,,{text}")

    return "\n".join(lines) + "\n"


def align_audio_text(audio_path: str, original_text: str, converter, model):
    """
    对音频和原文做对齐，返回 cues。
    """
    if not os.path.exists(audio_path):
        raise FileNotFoundError(f"Audio not found: {audio_path}")

    print(f"[align] audio: {audio_path}", file=sys.stderr)
    print(f"[align] text: {original_text[:80]}...", file=sys.stderr)

    res = model.generate(input=audio_path)
    recognized_raw = res[0]["text"]  # 连续字符串，含标点
    raw_timestamps = res[0]["timestamp"]  # 仅非标点字符有时间戳

    # 把标点也补上时间戳：标点前一个非标点字符的结束时间作为起点，
    # 后一个非标点字符的开始时间作为终点；如果相邻则共用边界。
    recognized_chars = list(recognized_raw)
    timestamps: list[tuple[int, int]] = []
    t_idx = 0
    punctuations = set("，。！？、；：\"'\"'（）【】")
    for i, ch in enumerate(recognized_chars):
        if ch.strip() == "" or ch in punctuations:
            # 标点：找前后最近的有效时间戳
            prev_end = raw_timestamps[t_idx - 1][1] if t_idx > 0 else 0
            next_start = raw_timestamps[t_idx][0] if t_idx < len(raw_timestamps) else prev_end
            if prev_end == 0:
                prev_end = next_start
            timestamps.append((prev_end, next_start if next_start > prev_end else prev_end))
        else:
            if t_idx < len(raw_timestamps):
                timestamps.append(raw_timestamps[t_idx])
                t_idx += 1
            else:
                # 备用：复制最后一个时间戳
                timestamps.append(raw_timestamps[-1] if raw_timestamps else (0, 0))

    print(f"[align] recognized {len(recognized_chars)} chars / {len(timestamps)} timestamps", file=sys.stderr)

    normalized_original = normalize_text(original_text)
    original_chars = list(normalized_original)

    # 对齐时统一转简体，避免繁简差异导致错位
    recognized_simp = [converter.convert(c) for c in recognized_chars]
    original_simp = [converter.convert(c) for c in original_chars]

    aligned_indices = align_sequences(recognized_simp, original_simp)

    original_timestamps = []
    for idx in aligned_indices:
        if idx is not None:
            original_timestamps.append(timestamps[idx])
        else:
            original_timestamps.append((0, 0))

    # 对未对齐字符插值
    original_timestamps = interpolate_missing_timestamps(original_timestamps)

    cues = split_into_cues(original_chars, original_timestamps)

    # 过滤掉完全未匹配到的 cue（通常很短）
    cues = [c for c in cues if c["endMs"] > c["startMs"] + 100]

    return cues, recognized_raw, normalized_original


def main():
    parser = argparse.ArgumentParser(description="Align Chinese TTS audio with original text using FunASR")
    parser.add_argument("--audio", required=True, help="Path to audio file")
    parser.add_argument("--text", required=True, help="Original text")
    parser.add_argument("--output-dir", default=".", help="Output directory for JSON and ASS")
    parser.add_argument("--font", default="PingFang SC")
    parser.add_argument("--size", type=int, default=48)
    parser.add_argument("--color", default="#FFFFFF")
    parser.add_argument("--position", default="bottom", choices=["top", "middle", "bottom"])
    args = parser.parse_args()

    from funasr import AutoModel
    import opencc

    # FunASR 第一次调用时会从 modelscope 下载模型到 ~/.cache/modelscope/hub/models。
    # 后续启动只要模型文件存在，就会直接从缓存加载；日志里的 "Downloading Model"
    # 只是 modelscope 的进度提示文字，实际并不会重复下载大文件。
    print("[init] loading FunASR models from cache (first run may download)...", file=sys.stderr)
    model = AutoModel(
        model="paraformer-zh",
        vad_model="fsmn-vad",
        punc_model="ct-punc",
        disable_update=True,
    )
    converter = opencc.OpenCC("t2s")
    print("[init] model loaded", file=sys.stderr)

    cues, recognized, normalized = align_audio_text(args.audio, args.text, converter, model)

    os.makedirs(args.output_dir, exist_ok=True)
    base_name = Path(args.audio).stem

    json_path = os.path.join(args.output_dir, f"{base_name}.timing.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(
            {
                "audio": args.audio,
                "originalText": args.text,
                "normalizedText": normalized,
                "recognizedText": recognized,
                "cueCount": len(cues),
                "cues": cues,
            },
            f,
            ensure_ascii=False,
            indent=2,
        )
    print(f"[out] timing JSON: {json_path}", file=sys.stderr)

    ass_content = generate_ass(
        cues,
        {"font": args.font, "size": args.size, "color": args.color, "position": args.position},
    )
    ass_path = os.path.join(args.output_dir, f"{base_name}.ass")
    with open(ass_path, "w", encoding="utf-8") as f:
        f.write(ass_content)
    print(f"[out] ASS subtitle: {ass_path}", file=sys.stderr)

    print(json.dumps(cues, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
