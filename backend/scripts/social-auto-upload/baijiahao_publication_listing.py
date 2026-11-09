"""Read-only publication lookup through the bound browser account's API client."""
import asyncio
import json
import re
from urllib.parse import parse_qs, urlencode, urlparse

from baijiahao_draft_listing import _fresh_row, _title_text


LIST_URL = "https://baijiahao.baidu.com/pcui/article/lists"
REQUEST_TIMEOUT = 15
DISPOSE_TIMEOUT = 2
TIME_BUDGET = 120
MAX_PAGES = 50
PROOF_FIELDS = ("title", "status", "type", "created_at", "updated_at", "rmb_duration",
                "file_name", "app_id", "has_edited_times", "bjh_video_finger_printing",
                "source_trace", "source_type")
STATUS_LABELS = {"publish": "已发布", "review": "审核中"}


class BaijiahaoPublicationApiError(RuntimeError):
    def __init__(self, message, diagnostic, *, allow_ui_fallback=False):
        super().__init__(message)
        self.diagnostic = dict(diagnostic)
        self.allow_ui_fallback = allow_ui_fallback


def _integer(value):
    if isinstance(value, bool) or not isinstance(value, (int, str)) or not re.fullmatch(r"[0-9]+", str(value)):
        raise ValueError("invalid integer")
    return int(value)


def _response_url(url, parameters):
    parsed = urlparse(url)
    return (parsed.scheme == "https" and parsed.hostname == "baijiahao.baidu.com"
            and parsed.path == "/pcui/article/lists" and parsed.port in (None, 443)
            and not parsed.username and not parsed.password and not parsed.fragment
            and parse_qs(parsed.query, keep_blank_values=True) == {
                key: [str(value)] for key, value in parameters.items()})


async def locate_baijiahao_publication(request, *, title, attempted_at, target, expected_id=None, match):
    """Return one strict server candidate, or explain whether UI can add proof.

    A candidate still needs the bridge's complete local media and upload checks.
    Identity conflicts and malformed responses never authorize a weaker lookup.
    """
    diagnostic = {"outcome": "incomplete", "pagesScanned": 0, "rowsScanned": 0,
                  "source": "authenticated_list_api"}
    seen = set()

    def fail(outcome, message, *, fallback=False):
        diagnostic["outcome"] = outcome
        raise BaijiahaoPublicationApiError(message, diagnostic, allow_ui_fallback=fallback)

    async def load(number):
        parameters = {"currentPage": str(number), "pageSize": "10", "collection": "",
                      "search": "", "type": "", "clearBeforeFetch": "false"}
        response = None
        try:
            try:
                response = await asyncio.wait_for(request.get(LIST_URL + "?" + urlencode(parameters),
                    timeout=int(REQUEST_TIMEOUT * 1000), max_redirects=0), REQUEST_TIMEOUT)
            except Exception as error:
                diagnostic["errorType"] = type(error).__name__
                fail("incomplete", "作品接口暂时不可用，改用只读页面核对", fallback=True)
            if not _response_url(response.url, parameters):
                fail("invalid_response", "作品接口来源或分页参数不匹配")
            if response.status in (408, 429) or 500 <= response.status <= 599:
                fail("incomplete", "作品接口暂时不可用，改用只读页面核对", fallback=True)
            if response.status != 200:
                fail("invalid_response", "作品接口未返回已认证的成功响应")
            try:
                body = await asyncio.wait_for(response.text(), REQUEST_TIMEOUT)
            except Exception as error:
                diagnostic["errorType"] = type(error).__name__
                fail("incomplete", "作品接口响应读取超时或失败，改用只读页面核对", fallback=True)
            try:
                data = json.loads(body)
                if not isinstance(data, dict) or type(data.get("errno")) is not int or data["errno"] != 0:
                    fail("invalid_response", "作品接口未返回认证成功的数据")
                items, page = data["data"]["list"], data["data"]["page"]
                current, total, count = (_integer(page[key]) for key in ("currentPage", "totalPage", "totalCount"))
                if not isinstance(items, list) or current != number or len(items) > 10:
                    raise ValueError("invalid page")
                if count == 0:
                    if items or number != 1 or total not in (0, 1):
                        raise ValueError("invalid empty page")
                elif (total != (count + 9) // 10 or number > total
                      or len(items) != min(10, count - (number - 1) * 10)):
                    raise ValueError("invalid pagination")
                rows = []
                page_ids = set()
                for item in items:
                    if not isinstance(item, dict):
                        raise ValueError("invalid record")
                    value = item.get("article_id", item.get("id"))
                    _integer(value)
                    identifier = str(value)
                    if identifier in seen or identifier in page_ids:
                        fail("ambiguous", "作品接口重复返回同一 ID，保持待核对")
                    page_ids.add(identifier)
                    record = {"article_id": identifier, **{key: item[key] for key in PROOF_FIELDS if key in item}}
                    status = item.get("status")
                    label = STATUS_LABELS.get(status) if isinstance(status, str) else None
                    rows.append({"id": identifier, "title": item.get("title"),
                        "time": item.get("created_at"), "video": item.get("type") == "video",
                        "draft": status == "draft", "statusLabels": [label] if label else [],
                        "record": record, "source": "authenticated_list_api",
                        "url": "https://baijiahao.baidu.com/builder/preview/s?id=" + identifier})
                return rows, total
            except BaijiahaoPublicationApiError:
                raise
            except (ValueError, TypeError, KeyError):
                fail("invalid_response", "作品接口数据、ID 或分页无效，保持待核对")
        finally:
            if response is not None:
                try:
                    await asyncio.wait_for(response.dispose(), DISPOSE_TIMEOUT)
                except Exception:
                    pass

    async def run():
        if target != "baijiahao-video" or (expected_id is not None and (
                not isinstance(expected_id, str) or not re.fullmatch(r"[0-9]+", expected_id))):
            fail("identity_mismatch", "作品核对类型或原作品 ID 无效")
        for number in range(1, MAX_PAGES + 1):
            rows, total = await load(number)
            seen.update(row["id"] for row in rows)
            diagnostic.update(pagesScanned=number, rowsScanned=len(seen))
            candidates = []
            for row in rows:
                if expected_id == row["id"] and (not row["video"] or _title_text(row["title"]) != _title_text(title)):
                    fail("identity_mismatch", "原作品 ID 的类型或完整文案不匹配，保持待核对")
                if expected_id is None and not _fresh_row(row, title, attempted_at):
                    continue
                try:
                    candidate = match([row], title, attempted_at, target=target, expected_id=expected_id)
                except RuntimeError:
                    continue
                if candidate.get("id") != row["id"]:
                    fail("identity_mismatch", "作品接口候选 ID 不匹配")
                candidates.append(candidate)
            if len(candidates) > 1:
                diagnostic["candidateIds"] = [candidate["id"] for candidate in candidates]
                fail("ambiguous", "当前页存在多个匹配的发表作品，保持待核对")
            if candidates:
                diagnostic.update(outcome="matched", candidateId=candidates[0]["id"])
                return candidates[0], diagnostic
            if number >= total:
                fail("unmatched" if expected_id in seen else "not_found",
                     "作品接口未提供明确的发表回执，改用只读页面核对", fallback=True)
        fail("incomplete", "作品接口达到 50 页查询上限，保持待核对")

    try:
        return await asyncio.wait_for(run(), TIME_BUDGET)
    except BaijiahaoPublicationApiError:
        raise
    except asyncio.TimeoutError:
        fail("incomplete", "作品接口总查询超时，改用只读页面核对", fallback=True)
    except Exception as error:
        diagnostic["errorType"] = type(error).__name__
        fail("invalid_response", "作品接口核对异常，保持待核对")
