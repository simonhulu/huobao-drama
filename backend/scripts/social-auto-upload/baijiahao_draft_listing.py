"""Read-only Baijiahao draft lookup; the caller owns the page and persistence."""
import asyncio
import json
import re
from datetime import datetime
from urllib.parse import parse_qs, urlparse
from zoneinfo import ZoneInfo


CONTENT_URL = "https://baijiahao.baidu.com/builder/rc/content"
ROW = ".client_pages_content_v2_components_articleItem"
MAX_PAGES = 50
TIME_BUDGET = 120
# Cold browser profiles on the external disk need longer to synchronize API rows and DOM.
STEP_TIMEOUT = 45000


class BaijiahaoDraftListingError(RuntimeError):
    def __init__(self, message, diagnostic):
        super().__init__(message)
        self.diagnostic = dict(diagnostic)


_SNAPSHOT = r"""() => {
  const visible = e => !!e && !!e.getClientRects().length;
  const rows = [...document.querySelectorAll('.client_pages_content_v2_components_articleItem')]
    .filter(visible).map(e => {
      const a = e.querySelector('.title a');
      let id = null, url = null;
      try {
        const u = new URL(a.href);
        const ids = u.searchParams.getAll('id');
        if (['http:', 'https:'].includes(u.protocol) && !u.username && !u.password &&
            u.hostname === 'baijiahao.baidu.com' &&
            ['/builder/preview/s', '/s'].includes(u.pathname) &&
            ids.length === 1 && /^\d+$/.test(ids[0])) {
          id = ids[0]; url = u.origin + u.pathname + '?id=' + id;
        }
      } catch {}
      return {id, url, title:a?.textContent.trim(), time:e.querySelector('.time')?.textContent.trim(),
        video:!!e.querySelector('.icon.video'),
        statusLabels:[...e.querySelectorAll('[class*="articleTags"] *')].filter(n=>!n.children.length).map(n=>n.textContent.trim()),
        draft:[...e.querySelectorAll('[class*="articleTags"] *')].some(n=>n.textContent.trim()==='草稿')};
    });
  const next = document.querySelector('.cheetah-pagination-next');
  return {rows,
    loading:[...document.querySelectorAll('.cheetah-spin-spinning[aria-busy="true"]')].some(visible),
    empty:[...document.querySelectorAll('.cheetah-empty-description')]
      .some(e=>visible(e)&&e.textContent.trim()==='暂无数据'),
    page:document.querySelector('.cheetah-pagination-item-active')?.textContent.trim(),
    nextDisabled:!next || next.getAttribute('aria-disabled')==='true' || !!next.querySelector('button:disabled'),
    draftSelected:[...document.querySelectorAll('[role="tab"][aria-selected="true"]')]
      .some(e=>e.textContent.trim()==='草稿')};
}"""

_SYNC = """expected => {
  const s = (""" + _SNAPSHOT + """)();
  if (s.loading || (expected.draft && !s.draftSelected)) return false;
  if (JSON.stringify(s.rows.map(r=>r.id)) !== JSON.stringify(expected.ids)) return false;
  if (!expected.ids.length) return s.empty ? s : false;
  if (expected.totalPages > 1 && s.page !== String(expected.page)) return false;
  return s;
}"""


async def _load(page, action, *, search, number, collection="draft"):
    """Bind to a new request, read JSON in Python, then wait for those DOM IDs."""
    def requested(request):
        u = urlparse(request.url)
        q = parse_qs(u.query, keep_blank_values=True)
        return (request.method == "GET" and u.hostname == "baijiahao.baidu.com"
                and u.path == "/pcui/article/lists"
                and q.get("search") == [search] and q.get("currentPage") == [str(number)]
                and q.get("collection") == [collection])

    async with page.expect_request(requested, timeout=STEP_TIMEOUT) as pending:
        await action()
    response = await (await pending.value).response()
    if response is None or response.status != 200:
        raise RuntimeError("草稿列表请求失败")
    # response.json() in the browser would round numeric 64-bit IDs. Python's
    # JSON decoder keeps integers exact; candidates still come only from hrefs.
    data = json.loads(await response.text())
    if data.get("errno") != 0:
        raise RuntimeError("草稿列表接口返回失败")
    items, pagination = data["data"]["list"], data["data"]["page"]
    current, total, count = (int(pagination[k]) for k in ("currentPage", "totalPage", "totalCount"))
    if current != number or total < 0 or count < 0 or not isinstance(items, list):
        raise RuntimeError("草稿列表分页响应无效")
    if (items and (total < current or count < len(items))) or (not items and count != 0):
        raise RuntimeError("草稿列表数量与分页不一致")
    ids = []
    for item in items:
        article_id = str(item.get("article_id", item.get("id", "")))
        # Legacy small-video cards link to their nid, not their article_id.
        # Synchronize that observed display identity, while keeping the true
        # article_id below for the caller's strict publication verification.
        identifier = str(item.get("nid", "")) if item.get("type") == "ugc_video" else article_id
        if not re.fullmatch(r"[0-9]+", article_id) or not re.fullmatch(r"[0-9]+", identifier):
            raise RuntimeError("草稿列表响应缺少可靠 ID")
        ids.append(identifier)
    handle = await page.wait_for_function(_SYNC, arg={"ids": ids, "page": number,
        "totalPages": total, "draft": collection == "draft"}, timeout=STEP_TIMEOUT)
    try:
        snapshot = await handle.json_value()
    finally:
        await handle.dispose()
    # Preserve the matching server record, not only its DOM presentation.
    # Python keeps 64-bit article IDs exact; only proof fields are retained.
    fields = ("title", "status", "type", "created_at", "updated_at", "rmb_duration", "file_name", "app_id",
              "has_edited_times", "bjh_video_finger_printing", "source_trace", "source_type")
    snapshot["records"] = {
        identifier: {
            "article_id": str(item.get("article_id", item.get("id"))),
            **{key: item[key] for key in fields if key in item},
        } for identifier, item in zip(ids, items)
    }
    for row in snapshot["rows"]:
        row["record"] = snapshot["records"][row["id"]]
    return snapshot, total, count


def _fresh_row(row, title, attempted_at):
    """An unknown ID needs the full title and a dated time after this save began.

    The bridge matcher also allows truncated titles and times before the save.
    Those are insufficient when returning the first matching page. Minute-only
    labels cannot establish this boundary; known IDs do not need this filter.
    """
    if str(row.get("title") or "").strip() != title.strip():
        return False
    # The visible card time changes from creation time to release/update time
    # after moderation. The API record is authoritative when it is present;
    # the DOM time is only a compatibility fallback for older responses.
    record = row.get("record")
    if isinstance(record, dict) and record.get("created_at") is not None:
        value = record.get("created_at")
    else:
        value = row.get("time")
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y年%m月%d日 %H:%M:%S"):
        try:
            timestamp = datetime.strptime(str(value or "").strip(), fmt).replace(
                tzinfo=ZoneInfo("Asia/Shanghai")).timestamp()
        except ValueError:
            continue
        # The platform label has whole-second precision. Comparing it with the
        # local fractional second would reject a save completed in that second.
        return timestamp >= int(attempted_at)
    return False


async def locate_baijiahao_draft(page, *, title, attempted_at, target, expected_id=None, match, collection="draft"):
    """Return (candidate, exact-ID card locator, diagnostic), or a diagnostic error.

    `match` is bridge.matching_saved_draft. No editor is opened or modified.
    A unique fresh candidate on the current page completes the lookup; later
    pages and changing collection totals are not prerequisites for that proof.
    pagesScanned counts distinct completed draft pages; rowsScanned counts IDs.
    """
    search = "" if expected_id is not None else title[:30]
    diagnostic = {"outcome": "incomplete", "pagesScanned": 0, "rowsScanned": 0}
    seen, scanned = set(), set()

    def fail(outcome, message):
        diagnostic["outcome"] = outcome
        raise BaijiahaoDraftListingError(message, diagnostic)

    def matched(rows):
        if expected_id is None:
            rows = [row for row in rows if _fresh_row(row, title, attempted_at)]
        return match(rows, title, attempted_at, target=target, expected_id=expected_id)

    async def run():
        if expected_id is not None and (not isinstance(expected_id, str)
                                       or not re.fullmatch(r"[0-9]+", expected_id)):
            fail("incomplete", "百家号草稿 ID 必须为数字字符串，查询失败")
        # Finish the initial 'all' query before switching tabs, so its delayed
        # response cannot replace a completed draft query.
        snapshot, total, count = await _load(page, lambda: page.goto(CONTENT_URL, wait_until="domcontentloaded", timeout=STEP_TIMEOUT),
                    search="", number=1, collection="")
        if collection == "draft":
            snapshot, total, count = await _load(page, lambda: page.get_by_role("tab", name="草稿", exact=True).click(timeout=STEP_TIMEOUT),
                                          search="", number=1)
        elif collection != "":
            fail("incomplete", "不支持的百家号作品列表")
        search_needed = bool(search)
        if collection == "" and search_needed:
            # A new publication may be visible in the main list before the
            # keyword index catches up. Keep the same exact-title/time matcher.
            for row in snapshot["rows"]:
                try:
                    matched([row])
                    search_needed = False
                    break
                except RuntimeError:
                    continue
        if search_needed:
            field = page.get_by_placeholder(re.compile(r"^输入标题关键[字词]$"))
            await field.fill(search, timeout=STEP_TIMEOUT)
            snapshot, total, count = await _load(page, lambda: field.press("Enter", timeout=STEP_TIMEOUT), search=search, number=1, collection=collection)

        number = 1
        while True:
            scanned.add(number)
            seen.update(row["id"] for row in snapshot["rows"])
            diagnostic.update(pagesScanned=len(scanned), rowsScanned=len(seen))
            # Singleton matching distinguishes zero from multiple candidates
            # without parsing the bridge matcher's human-readable exceptions.
            candidates = {}
            for row in snapshot["rows"]:
                try:
                    candidate = matched([row])
                except RuntimeError:
                    continue
                if candidate.get("id") != row["id"]:
                    fail("incomplete", "百家号草稿候选 ID 与页面不一致，查询失败")
                candidates[row["id"]] = candidate
            if len(candidates) > 1:
                diagnostic["candidateIds"] = list(candidates)
                fail("ambiguous", "当前页找到多个匹配的百家号草稿 ID，保存验证失败")
            if candidates or number >= total:
                break
            if number >= MAX_PAGES:
                fail("incomplete", "百家号草稿查询达到 50 页上限，保存验证失败")
            if snapshot["nextDisabled"]:
                fail("incomplete", "百家号草稿仍有后续页但下一页不可用，查询失败")
            number += 1
            snapshot, total, count = await _load(page,
                lambda: page.locator('.cheetah-pagination-next').click(timeout=STEP_TIMEOUT), search=search, number=number, collection=collection)

        if not candidates:
            if not seen or (expected_id is not None and expected_id not in seen):
                fail("not_found", "已完成百家号草稿查询，未找到目标草稿，保存验证失败")
            fail("unmatched", "已完成百家号草稿查询，但记录与目标类型、完整标题或本次保存时间不匹配，保存验证失败")

        candidate = matched(snapshot["rows"])
        identifier = candidate["id"]
        fresh = [row for row in snapshot["rows"] if row["id"] == identifier]
        if len(fresh) != 1 or matched(fresh)["id"] != identifier:
            fail("incomplete", "百家号草稿候选在定位前发生变化，查询失败")
        # Match a whole query parameter, never a prefix of another draft's ID.
        anchors = ",".join(f'.title a[href{op}"{prefix}id={identifier}{suffix}"]'
                           for op, prefix, suffix in (("$=", "?", ""), ("*=", "?", "&"),
                                                       ("$=", "&", ""), ("*=", "&", "&")))
        card = page.locator(ROW).filter(has=page.locator(anchors))
        if await card.count() != 1 or await card.locator('.title a').evaluate(
                "a=>new URL(a.href).searchParams.get('id')", timeout=STEP_TIMEOUT) != identifier:
            fail("incomplete", "百家号草稿候选 ID 无法唯一定位，查询失败")
        diagnostic.update(outcome="matched", candidateId=identifier)
        candidate["record"] = snapshot["records"][identifier]
        return candidate, card, diagnostic

    try:
        return await asyncio.wait_for(run(), timeout=TIME_BUDGET)
    except BaijiahaoDraftListingError:
        raise
    except Exception as error:
        diagnostic["errorType"] = type(error).__name__
        # Do not include exception URLs/response bodies in persisted diagnostics.
        fail("incomplete", "百家号草稿查询失败（请求失败、加载未同步或超时），保存验证失败")
