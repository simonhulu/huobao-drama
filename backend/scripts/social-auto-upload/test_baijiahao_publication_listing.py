"""Authenticated, read-only publication receipts must not need a renderer."""
import asyncio
import copy
from datetime import datetime
import hashlib
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch
from urllib.parse import parse_qs, urlencode, urlparse
from zoneinfo import ZoneInfo

import bridge
import baijiahao_publication_listing as listing


ARTICLE_ID = "1880710335674588146"
TITLE = "完整发表文案"
CREATED = "2026-11-10 10:06:05"
ATTEMPTED = datetime.strptime(CREATED, "%Y-%m-%d %H:%M:%S").replace(
    tzinfo=ZoneInfo("Asia/Shanghai")).timestamp()


def record(**changes):
    return {"article_id": int(ARTICLE_ID), "title": TITLE, "type": "video", "status": "publish",
            "created_at": CREATED, "file_name": "bound-media", "rmb_duration": 42,
            "app_id": "bound-account", "unrelated_secret": "do-not-persist", **changes}


def params(number):
    return {"currentPage": str(number), "pageSize": "10", "collection": "", "search": "",
            "type": "", "clearBeforeFetch": "false"}


def response(items, *, number=1, count=None, pages=None, **changes):
    count = len(items) if count is None else count
    data = {"errno": 0, "data": {"list": items, "page": {"currentPage": number,
        "totalPage": (count + 9) // 10 if pages is None else pages, "totalCount": count}}}
    return SimpleNamespace(status=200,
        url=listing.LIST_URL + "?" + urlencode(params(number)),
        text=AsyncMock(return_value=json.dumps(data)), dispose=AsyncMock(), **changes)


class PublicationApiTest(unittest.IsolatedAsyncioTestCase):
    async def locate(self, request, **kwargs):
        return await listing.locate_baijiahao_publication(request, title=TITLE,
            attempted_at=ATTEMPTED, target="baijiahao-video", match=bridge.matching_publication, **kwargs)

    async def test_exact_64_bit_id_record_and_only_whitelisted_proof(self):
        # Captured account pagination: 111 works, 10 per page, 12 pages.
        items = [record()] + [record(article_id=int(ARTICLE_ID) + index + 1, title="无关作品") for index in range(9)]
        item = response(items, count=111, pages=12)
        request = SimpleNamespace(get=AsyncMock(return_value=item))
        candidate, diagnostic = await self.locate(request)
        self.assertEqual(candidate["id"], ARTICLE_ID)
        self.assertEqual(candidate["record"]["article_id"], ARTICLE_ID)
        self.assertNotIn("unrelated_secret", candidate["record"])
        self.assertEqual(candidate["url"], "https://baijiahao.baidu.com/builder/preview/s?id=" + ARTICLE_ID)
        self.assertEqual(candidate["statusLabels"], ["已发布"])
        self.assertEqual(candidate["source"], "authenticated_list_api")
        self.assertEqual(diagnostic["outcome"], "matched")
        item.dispose.assert_awaited_once()
        args, kwargs = request.get.call_args
        self.assertEqual(parse_qs(urlparse(args[0]).query, keep_blank_values=True),
                         {key: [value] for key, value in params(1).items()})
        self.assertEqual(kwargs, {"timeout": 15000, "max_redirects": 0})

    async def test_review_status_is_explicit(self):
        request = SimpleNamespace(get=AsyncMock(return_value=response([record(status="review")])))
        candidate, _ = await self.locate(request)
        self.assertEqual(candidate["statusLabels"], ["审核中"])

    async def test_unknown_or_nonpublication_status_never_becomes_review(self):
        for status in ("analyze", "draft", "reject", "deleted", "withdraw", "unexpected"):
            with self.subTest(status=status):
                request = SimpleNamespace(get=AsyncMock(return_value=response([record(status=status)])))
                with self.assertRaises(listing.BaijiahaoPublicationApiError) as caught:
                    await self.locate(request)
                self.assertTrue(caught.exception.allow_ui_fallback)

    async def test_second_page_is_read_without_keyword_filter(self):
        unrelated = [record(article_id=int(ARTICLE_ID) + index + 1, title="无关作品") for index in range(10)]
        first, second = response(unrelated, count=11), response([record()], number=2, count=11)
        request = SimpleNamespace(get=AsyncMock(side_effect=[first, second]))
        candidate, diagnostic = await self.locate(request)
        self.assertEqual(candidate["id"], ARTICLE_ID)
        self.assertEqual((diagnostic["pagesScanned"], diagnostic["rowsScanned"]), (2, 11))
        self.assertEqual(parse_qs(urlparse(request.get.call_args.args[0]).query,
                                 keep_blank_values=True)["search"], [""])
        first.dispose.assert_awaited_once()
        second.dispose.assert_awaited_once()

    async def test_known_id_with_wrong_identity_is_hard_failure(self):
        for changes in ({"title": "different"}, {"type": "article"},
                        {"type": "ugc_video", "nid": ARTICLE_ID}):
            with self.subTest(changes=changes):
                request = SimpleNamespace(get=AsyncMock(return_value=response([record(**changes)])))
                with self.assertRaises(listing.BaijiahaoPublicationApiError) as caught:
                    await self.locate(request, expected_id=ARTICLE_ID)
                self.assertFalse(caught.exception.allow_ui_fallback)

    async def test_legacy_nid_cannot_match_another_article(self):
        request = SimpleNamespace(get=AsyncMock(return_value=response([
            record(article_id=int(ARTICLE_ID) + 1, type="ugc_video", nid=ARTICLE_ID)])))
        with self.assertRaises(listing.BaijiahaoPublicationApiError):
            await self.locate(request)

    async def test_multiple_candidates_and_duplicate_ids_are_hard_failures(self):
        for items in ([record(), record(article_id=int(ARTICLE_ID) + 1)], [record(), record()]):
            request = SimpleNamespace(get=AsyncMock(return_value=response(items)))
            with self.assertRaises(listing.BaijiahaoPublicationApiError) as caught:
                await self.locate(request)
            self.assertFalse(caught.exception.allow_ui_fallback)

    async def test_response_validation_rejects_auth_redirects_and_malformed_records(self):
        for mutate in (lambda r: setattr(r, "url", "https://attacker.invalid/pcui/article/lists"),
                       lambda r: setattr(r, "url", r.url + "&currentPage=2"),
                       lambda r: setattr(r, "status", 302),
                       lambda r: setattr(r, "status", 401),
                       lambda r: setattr(r, "text", AsyncMock(return_value='{"errno":false}')),
                       lambda r: setattr(r, "text", AsyncMock(return_value='not-json'))):
            item = response([record()])
            mutate(item)
            request = SimpleNamespace(get=AsyncMock(return_value=item))
            with self.assertRaises(listing.BaijiahaoPublicationApiError) as caught:
                await self.locate(request)
            self.assertFalse(caught.exception.allow_ui_fallback)
            item.dispose.assert_awaited_once()

    async def test_invalid_pagination_and_ids_are_hard_failures(self):
        cases = [response([record()], number=2), response([record()], count=0),
                 response([record()], pages=0), response([record(article_id=True)]),
                 response([record(article_id="1880710335674588146x")])]
        for item in cases:
            with self.subTest(item=item):
                request = SimpleNamespace(get=AsyncMock(return_value=item))
                with self.assertRaises(listing.BaijiahaoPublicationApiError) as caught:
                    await self.locate(request)
                self.assertFalse(caught.exception.allow_ui_fallback)
                item.dispose.assert_awaited_once()

    async def test_repeated_cross_page_id_or_page_limit_cannot_confirm(self):
        unrelated = [record(article_id=int(ARTICLE_ID) + index + 1, title="无关作品") for index in range(10)]
        request = SimpleNamespace(get=AsyncMock(side_effect=[response(unrelated, count=11),
            response([unrelated[0]], number=2, count=11)]))
        with self.assertRaises(listing.BaijiahaoPublicationApiError) as caught:
            await self.locate(request)
        self.assertFalse(caught.exception.allow_ui_fallback)
        request = SimpleNamespace(get=AsyncMock(return_value=response(unrelated, count=11)))
        with patch.object(listing, "MAX_PAGES", 1):
            with self.assertRaises(listing.BaijiahaoPublicationApiError) as caught:
                await self.locate(request)
        self.assertFalse(caught.exception.allow_ui_fallback)
        self.assertEqual(request.get.await_count, 1)

    async def test_total_deadline_is_bounded(self):
        async def stalled(*args, **kwargs):
            await asyncio.Future()
        request = SimpleNamespace(get=AsyncMock(side_effect=stalled))
        with patch.object(listing, "TIME_BUDGET", .01):
            with self.assertRaises(listing.BaijiahaoPublicationApiError) as caught:
                await asyncio.wait_for(self.locate(request), .2)
        self.assertTrue(caught.exception.allow_ui_fallback)

    async def test_full_title_and_fresh_creation_time_are_required_for_unknown_id(self):
        for change in ({"title": "完整发表..."}, {"created_at": "2026-11-10 10:06"},
                       {"created_at": "2026-11-10 10:06:04"}, {"created_at": "2026-11-10 10:08:06"}):
            with self.subTest(change=change):
                request = SimpleNamespace(get=AsyncMock(return_value=response([record(**change)])))
                with self.assertRaises(listing.BaijiahaoPublicationApiError) as caught:
                    await self.locate(request)
                self.assertTrue(caught.exception.allow_ui_fallback)

    async def test_temporary_http_and_transport_failure_allow_conservative_ui(self):
        for status in (408, 429, 500):
            item = response([])
            item.status = status
            with self.assertRaises(listing.BaijiahaoPublicationApiError) as caught:
                await self.locate(SimpleNamespace(get=AsyncMock(return_value=item)))
            self.assertTrue(caught.exception.allow_ui_fallback)
            item.dispose.assert_awaited_once()
        with self.assertRaises(listing.BaijiahaoPublicationApiError) as caught:
            await self.locate(SimpleNamespace(get=AsyncMock(side_effect=OSError("offline"))))
        self.assertTrue(caught.exception.allow_ui_fallback)

    async def test_body_request_and_cleanup_are_bounded(self):
        async def stalled():
            await asyncio.Future()
        for operation in ("get", "text", "dispose"):
            item = response([record()])
            request = SimpleNamespace(get=AsyncMock(return_value=item))
            if operation == "get":
                async def get(*args, **kwargs):
                    await stalled()
                request.get.side_effect = get
            else:
                getattr(item, operation).side_effect = stalled
            with patch.object(listing, "REQUEST_TIMEOUT", .01), patch.object(listing, "DISPOSE_TIMEOUT", .01):
                if operation == "dispose":
                    candidate, _ = await asyncio.wait_for(self.locate(request), .2)
                    self.assertEqual(candidate["id"], ARTICLE_ID)
                else:
                    with self.assertRaises(listing.BaijiahaoPublicationApiError) as caught:
                        await asyncio.wait_for(self.locate(request), .2)
                    self.assertTrue(caught.exception.allow_ui_fallback)
            if operation != "get":
                item.dispose.assert_awaited_once()


class PublicationApiReconcileTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.video = self.root / "original.mp4"
        self.video.write_bytes(b"bound-original-video")
        digest = hashlib.sha256(self.video.read_bytes()).hexdigest()
        self.payload = {"jobId": "publication-api", "target": "baijiahao-video", "publicationMode": "publish",
                        "accountName": "bound-account", "description": TITLE, "title": TITLE,
                        "videoPath": str(self.video)}
        self.state = {"phase": "publish_requested", "publishAttemptedAt": ATTEMPTED,
                      "fileSelectionStartedAt": ATTEMPTED - 20, "publicationRequestCount": 1,
                      "files": {str(self.video): digest}, "details": {
                          "media": {"status": "uploaded", "video_fingerprint": digest},
                          "metadata": {"description": {"value": TITLE}}},
                      "result": {"staged": True, "saved": False, "published": False}}
        self.file = self.root / "checkpoint.json"
        self.http = SimpleNamespace(get=AsyncMock(return_value=response([record()])))
        self.context = SimpleNamespace(request=self.http, new_page=AsyncMock(side_effect=AssertionError("no renderer")))
        self.browser = SimpleNamespace(contexts=[self.context])

    async def test_api_receipt_completes_without_new_page_or_another_post(self):
        with patch.object(bridge, "local_video_duration", return_value=42), patch.object(
                bridge, "locate_baijiahao_draft", new_callable=AsyncMock) as ui:
            result = await bridge.reconcile_publication(self.browser, self.payload, self.state, self.file)
        self.assertTrue(result["published"])
        self.assertTrue(result["submitted"])
        self.assertEqual(result["articleId"], ARTICLE_ID)
        self.assertEqual(self.state["publicationEvidence"]["accountName"], "bound-account")
        self.assertEqual(self.state["publicationEvidence"]["source"], "authenticated_list_api")
        self.assertEqual(self.state["publicationRequestCount"], 1)
        self.context.new_page.assert_not_awaited()
        ui.assert_not_awaited()

    async def test_candidate_failure_never_falls_back_to_ui(self):
        self.state["expectedPublicationId"] = ARTICLE_ID
        changes = ({"rmb_duration": 100}, {"file_name": ""}, {"created_at": "2000-01-01 00:00:00"})
        for change in changes:
            self.http.get.return_value = response([record(**change)])
            with patch.object(bridge, "local_video_duration", return_value=42), patch.object(
                    bridge, "locate_baijiahao_draft", new_callable=AsyncMock) as ui:
                with self.assertRaisesRegex(RuntimeError, "不会重传或再次发表"):
                    await bridge.reconcile_publication(self.browser, self.payload, copy.deepcopy(self.state), self.file)
            self.context.new_page.assert_not_awaited()
            ui.assert_not_awaited()

    async def test_ambiguous_and_known_identity_conflicts_never_create_ui(self):
        cases = ([record(), record(article_id=int(ARTICLE_ID) + 1)], [record(title="different")])
        for items in cases:
            state = copy.deepcopy(self.state)
            if len(items) == 1:
                state["expectedPublicationId"] = ARTICLE_ID
            self.http.get.return_value = response(items)
            with self.assertRaisesRegex(RuntimeError, "不会重传或再次发表"):
                await bridge.reconcile_publication(self.browser, self.payload, state, self.file)
            self.context.new_page.assert_not_awaited()
            self.assertEqual(state["publicationRequestCount"], 1)

    async def test_local_source_and_original_upload_proof_are_still_required(self):
        for change in ("file", "proof", "copy"):
            with self.subTest(change=change):
                state = copy.deepcopy(self.state)
                if change == "file":
                    state["files"][str(self.video)] = "different"
                elif change == "proof":
                    state["details"]["media"]["video_fingerprint"] = "different"
                else:
                    state["details"]["metadata"]["description"]["value"] = "different"
                with self.assertRaisesRegex(RuntimeError, "不会重传或再次发表"):
                    await bridge.reconcile_publication(self.browser, self.payload, state, self.file)
                self.context.new_page.assert_not_awaited()

    async def test_temporary_api_failure_uses_existing_strict_ui_verification(self):
        self.http.get.side_effect = OSError("temporary connection failure")
        page = SimpleNamespace(screenshot=AsyncMock(), close=AsyncMock())
        self.context.new_page = AsyncMock(return_value=page)
        candidate = {"id": ARTICLE_ID, "title": TITLE, "video": True, "draft": False,
                     "statusLabels": ["已发布"], "record": {**record(), "article_id": ARTICLE_ID},
                     "url": "https://baijiahao.baidu.com/builder/preview/s?id=" + ARTICLE_ID}
        with patch.object(bridge, "local_video_duration", return_value=42), patch.object(
                bridge, "locate_baijiahao_draft", new_callable=AsyncMock,
                return_value=(candidate, None, {"outcome": "matched", "pagesScanned": 1, "rowsScanned": 1})) as ui:
            result = await bridge.reconcile_publication(self.browser, self.payload, self.state, self.file)
        self.assertTrue(result["published"])
        ui.assert_awaited_once()
        page.close.assert_awaited_once()
        self.assertEqual(self.state["publicationRequestCount"], 1)


if __name__ == "__main__":
    unittest.main()
