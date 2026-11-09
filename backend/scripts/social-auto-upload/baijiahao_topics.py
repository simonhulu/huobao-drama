"""Optional topic selection through Baijiahao's own video editor suggestions."""
from __future__ import annotations

import asyncio
from copy import deepcopy
import re
import time
import unicodedata


TOPIC_TIMEOUT_SECONDS = 10.0
EDITOR = '.videov2-title-wrap [contenteditable="true"]'
ITEM = '[class*="FeEditorApp-"][class$="-topicItem"][role="button"]:visible'


class RequiredTopicError(RuntimeError):
    metadata = None


def _text(value):
    return re.sub(r"\s+", " ", re.sub(r"[\u200b-\u200f\ufeff]", "", unicodedata.normalize("NFC", str(value or "")))).strip()


def _tags(payload):
    return list(dict.fromkeys(f"#{tag.strip().strip('#')}#" for tag in payload.get("tags", [])
                             if isinstance(tag, str) and tag.strip().strip('#')))


def _required_exact(payload):
    policy = payload.get("topicPolicy")
    if policy not in (None, "required-exact"):
        raise RuntimeError("百家号话题策略无效")
    return policy == "required-exact"


def _verify_exact_labels(payload, labels):
    if _required_exact(payload) and (not _tags(payload) or not set(_tags(payload)).issubset(labels)):
        raise RequiredTopicError("尚未选中平台精确话题：" + "、".join(_tags(payload)) + "；保留原编辑页，未发表")


async def _verify_exact_selection(editor, payload):
    if _required_exact(payload):
        labels = [_text(label) for label in await editor.locator('.video-title-tag[data-tag-type="topic"]').all_text_contents()]
        _verify_exact_labels(payload, labels)


def _base(payload):
    value = payload["description"].rstrip()
    for tag in reversed(_tags(payload)):
        if value.endswith(tag):
            value = value[:-len(tag)].rstrip()
    return value


def unselected_topic_suffix(payload, actual, prefix=None):
    prefix = _base(payload) if prefix is None else prefix
    if not isinstance(actual, str) or not actual.startswith(prefix):
        return False
    suffix = actual[len(prefix):].strip()
    return not suffix or any(tag.startswith(suffix) for tag in _tags(payload))


def video_description(payload, state):
    """Use the recorded optional suffix without weakening the original-body check."""
    if payload.get("target") not in (None, "baijiahao-video"):
        return payload["description"]
    metadata = state.get("details", {}).get("metadata", {})
    attempt = metadata.get("topicAttempt")
    if not attempt:
        return payload["description"]
    labels = attempt.get("selectedLabels")
    if (attempt.get("sourceDescription") != payload["description"] or attempt.get("baseDescription") != _base(payload)
            or attempt.get("status") not in ("selected", "skipped", "existing") or not isinstance(labels, list)
            or any(not isinstance(label, str) or not re.fullmatch(r"#[^#\r\n]+#", label) for label in labels)):
        raise RuntimeError("百家号话题尝试记录与原文案不一致")
    _verify_exact_labels(payload, labels)
    description = _text(attempt.get("description"))
    expected = _text(" ".join([_base(payload), *labels]))
    if attempt.get("unchanged") is True and attempt["status"] == "skipped" and not labels:
        expected = _text(payload["description"])
    if description != expected or _text(metadata.get("description", {}).get("value")) != description:
        raise RuntimeError("百家号实际文案与已记录的话题结果不一致")
    return description


async def _count(page):
    counter = page.locator('.videov2-title-wrap [class$="-topicCount"]')
    value = await counter.first.inner_text() if await counter.count() else "0/10"
    match = re.match(r"\s*(\d+)\s*/", value)
    return int(match[1]) if match else 0


async def _select_suffix(editor, prefix):
    suffix = await editor.evaluate("""(root,prefix) => {
      const value=root.textContent||'';
      if(!value.startsWith(prefix))throw Error('原描述正文已变化，不能修改末尾话题');
      return value.slice(prefix.length);
    }""", prefix)
    if not suffix:
        return False
    # Lexical may restore its model selection after a raw DOM range change.
    # Native selection keeps both in sync; verify the exact suffix before delete.
    await editor.press("ControlOrMeta+A")
    await editor.press("ArrowRight")
    for _ in suffix:
        await editor.press("Shift+ArrowLeft")
    selected = await editor.evaluate("""(root) => {
      const selection=window.getSelection();
      if(!selection||!root.contains(selection.anchorNode)||!root.contains(selection.focusNode))return null;
      return selection.toString();
    }""")
    if selected != suffix:
        raise RuntimeError("话题查询选区与原文案末尾不一致，未删除正文")
    return True


def _record(metadata, payload, actual, labels, status, reason="", unchanged=False):
    result = deepcopy(metadata)
    result["description"] = {**result["description"], "value": actual}
    result["topicAttempt"] = {"sourceDescription": payload["description"], "baseDescription": _base(payload),
                              "description": _text(actual), "selectedLabels": labels,
                              "status": status, "reason": reason, **({"unchanged": True} if unchanged else {})}
    video_description(payload, {"details": {"metadata": result}})
    return result


async def add_optional_topics(page, payload, metadata, *, timeout=TOPIC_TIMEOUT_SECONDS):
    """Use first suggestions by default, or require exact platform topics explicitly.

    Called after metadata/media validation and before the single publish click.
    A persisted attempt (including a skip) is reused on subsequent preflights.
    """
    tags = _tags(payload)
    required_exact = _required_exact(payload)
    if required_exact:
        _verify_exact_labels(payload, tags)
    if not tags:
        return metadata
    if metadata.get("topicAttempt"):
        video_description(payload, {"details": {"metadata": metadata}})
        await _verify_exact_selection(page.locator(EDITOR), payload)
        return metadata
    editor = page.locator(EDITOR)
    if await editor.count() != 1 or not await editor.is_visible():
        return _record(metadata, payload, metadata["description"]["value"], [], "skipped", "话题编辑器不可用，继续发表", True)
    original = await editor.inner_text()
    if original != metadata.get("description", {}).get("value"):
        raise RuntimeError("原编辑页文案已变化，不能覆盖正文")
    if await _count(page):
        # Read the labels already shown by the editor, without pinning any ID.
        labels = await editor.locator('.video-title-tag[data-tag-type="topic"]').all_text_contents()
        return _record(metadata, payload, original, [_text(label) for label in labels], "existing")
    base = _base(payload)
    labels = []
    prefix = base
    deadline = time.monotonic() + min(TOPIC_TIMEOUT_SECONDS, max(0.05, timeout))
    reason = ""
    for tag in tags:
        selected = None
        try:
            async with asyncio.timeout(max(0.001, deadline - time.monotonic())):
                if not labels:
                    actual = await editor.inner_text()
                    if not unselected_topic_suffix(payload, actual, prefix) or await _count(page):
                        raise RuntimeError("原描述正文或话题已变化，未覆盖文案")
                    await editor.fill(prefix)
                elif await _select_suffix(editor, prefix):
                    await page.keyboard.press("Backspace")
                await page.keyboard.insert_text(" ")
                await page.keyboard.type("#")
                await page.keyboard.insert_text(tag.strip("#"))
                while True:
                    loading = page.locator('[class*="FeEditorApp-"][class$="-topicLoading"]:visible')
                    items = page.locator(ITEM)
                    if not await loading.count() and await items.count():
                        matches = []
                        for candidate in await items.all() if required_exact else [items.first]:
                            name = await candidate.locator('[class$="-topicName"]').inner_text()
                            label = "#" + name.strip().strip("#").strip() + "#"
                            if not required_exact or label == tag:
                                matches.append((candidate, label))
                        if len(matches) == 1:
                            candidate, selected = matches[0]
                            await candidate.click(timeout=max(1, min(1000, (deadline - time.monotonic()) * 1000)))
                            break
                    # Empty rows can outlive the previous query's debounce.
                    # Give optional topics the same bounded wait as required ones.
                    await asyncio.sleep(0.1)
                if selected:
                    expected = _text(" ".join([prefix, selected]))
                    while _text(await editor.inner_text()) != expected or await _count(page) <= len(labels):
                        await asyncio.sleep(0.05)
                    labels.append(selected)
                    prefix = " ".join([prefix, selected])
                    continue
        except Exception:
            reason = "话题候选超时或选择失败，已跳过话题"
        # If the click completed as the deadline expired, preserve that result.
        if selected and _text(await editor.inner_text()) == _text(" ".join([prefix, selected])) and await _count(page) > len(labels):
            labels.append(selected)
            prefix = " ".join([prefix, selected])
        else:
            # Remove only this attempt's unfinished trailing query. The title
            # and any previously selected topics stay in the same editor.
            await page.keyboard.press("Escape")
            if not labels:
                actual = await editor.inner_text()
                if not unselected_topic_suffix(payload, actual, prefix) or await _count(page):
                    raise RuntimeError("原描述正文或话题已变化，未覆盖文案")
                await editor.fill(prefix)
            elif await _select_suffix(editor, prefix):
                await page.keyboard.press("Backspace")
        break
    await page.keyboard.press("Escape")
    try:
        await _verify_exact_selection(editor, payload)
    except RequiredTopicError as error:
        error.metadata = deepcopy(metadata)
        error.metadata.pop("topicAttempt", None)
        error.metadata["description"] = {**error.metadata["description"], "value": await editor.inner_text()}
        raise
    return _record(metadata, payload, await editor.inner_text(), labels,
                   "selected" if labels else "skipped", reason)
