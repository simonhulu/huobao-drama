"""Saved video recovery stays read-only and verifies the original media."""
import hashlib
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

import bridge
from playwright.async_api import async_playwright


class SavedVideoRecoveryTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.video = Path(self.tmp.name).resolve() / "original.mp4"
        self.video.write_bytes(b"original-video-fixture")
        self.digest = hashlib.sha256(self.video.read_bytes()).hexdigest()
        self.payload = {"target": "baijiahao-video", "videoPath": str(self.video),
                        "title": "浙江88比80青岛", "description": "浙江88比80青岛",
                        "accountName": "sports"}
        self.state = {"files": {str(self.video): self.digest}, "details": {
            "metadata": {"layout": "videoV2", "title": {"status": "source_only", "source_value": self.payload["title"]},
                         "description": {"status": "filled", "value": self.payload["description"]}},
            "media": {"status": "uploaded", "video_fingerprint": self.digest, "verification": "blob_sha256"}}}
        self.pw = await async_playwright().start()
        self.addAsyncCleanup(self.pw.stop)
        self.browser = await self.pw.chromium.launch(channel="chrome", headless=True)
        self.addAsyncCleanup(self.browser.close)
        self.context = await self.browser.new_context()
        self.addAsyncCleanup(self.context.close)
        self.page = await self.context.new_page()
        self.helpers = SimpleNamespace(_verify_metadata=AsyncMock(side_effect=RuntimeError("legacy wrapper absent")))

    async def editor(self, description=None, duration=290.466, with_video=True):
        text = self.payload["description"] if description is None else description
        await self.page.set_content(f'''<form><label>作品描述</label><div class="new-editor">
          <div contenteditable="true" data-placeholder="添加作品描述">{text}</div></div>
          <button onclick="window.saved++">存草稿</button><button onclick="window.published++">发布</button></form>
          <script>window.saved=0;window.published=0</script>''')
        if with_video:
            await self.page.evaluate("""duration => {
              const v=document.createElement('video');v.src='https://media.example.test/transcoded.mp4';
              v.style.cssText='width:320px;height:180px';document.body.appendChild(v);
              Object.defineProperty(v,'duration',{value:duration});
              Object.defineProperty(v,'readyState',{value:1});
            }""", duration)

    async def verify(self):
        with patch.object(bridge, "local_video_duration", return_value=290.466):
            return await bridge.verify_saved_video(self.page, self.payload, self.state, self.helpers, timeout=0.15)

    def saved_record(self, **changes):
        self.state.update(phase='save_requested', saveAttemptedAt=1792975588.01, saveClickedAt=1792975588.05,
                          expectedDraftId='1880071170846129949', result={'saved': False, 'published': False,
                          'targetId': 'owned-original', 'accountName': 'sports'})
        return {'id': '1880071170846129949', 'time': '2026-10-26 08:46:28', 'record': {
            'article_id': '1880071170846129949', 'status': 'draft', 'type': 'video',
            'title': self.payload['description'], 'created_at': '2026-10-26 08:46:28',
            'rmb_duration': 290, 'file_name': 'server-video-resource', 'app_id': 'fixture-account',
            # The observed API has this flag even for drafts. status is authoritative.
            'is_published': 1, **changes}}

    async def test_persisted_platform_video_record_does_not_require_editor_loading(self):
        candidate = self.saved_record()
        async def locate(page, **kwargs):
            await page.set_content('<main>已保存的草稿</main>')
            return candidate, page.locator('main'), {'outcome': 'matched'}
        file = Path(self.tmp.name) / 'state.json'
        with patch.object(bridge, 'locate_baijiahao_draft', new=locate), \
                patch.object(bridge, 'local_video_duration', return_value=290.466), \
                patch.object(bridge, 'verify_saved_video', new=AsyncMock(side_effect=AssertionError('must not open editor'))) as editor:
            result = await bridge.reconcile_saved_draft(self.browser, self.payload, self.state, file,
                                                        (None, None, None, self.helpers))
        self.assertTrue(result['saved'])
        self.assertFalse(result['published'])
        self.assertIn('article_id=' + candidate['id'], result['draftUrl'])
        self.assertEqual(json.loads(file.read_text())['saveEvidence']['verification'], 'platform_video_draft_record')
        editor.assert_not_awaited()
        self.assertEqual(self.page.context.pages, [self.page], 'temporary listing was closed without opening an editor')

    async def test_wrong_or_unbound_platform_record_cannot_confirm_save(self):
        for changes in ({'status': 'publish'}, {'type': 'news'}, {'title': '其他视频'},
                        {'article_id': '999'}, {'created_at': '2026-10-25 08:46:28'}, {'rmb_duration': 12}):
            with self.subTest(changes=changes):
                candidate = self.saved_record(**changes)
                with patch.object(bridge, 'local_video_duration', return_value=290.466), self.assertRaises(RuntimeError):
                    await bridge.verify_baijiahao_video_record(self.payload, self.state, candidate)
        candidate = self.saved_record()
        self.state.pop('saveClickedAt')
        with self.assertRaises(RuntimeError):
            await bridge.verify_baijiahao_video_record(self.payload, self.state, candidate)

    async def test_optional_topic_suffix_is_used_for_saved_list_and_readback_matching(self):
        source = self.payload['description'] + ' #热爆趣创赛#'
        actual = self.payload['description'] + ' #平台返回的第一个话题#'
        self.payload.update(description=source, tags=['#热爆趣创赛#'])
        self.state['details']['metadata'].update(topicAttempt={
            'sourceDescription': source, 'baseDescription': self.payload['title'], 'description': actual,
            'selectedLabels': ['#平台返回的第一个话题#'], 'status': 'selected'})
        self.state['details']['metadata']['description']['value'] = actual
        candidate = self.saved_record(title=actual)
        async def locate(page, **kwargs):
            self.assertEqual(kwargs['title'], actual)
            await page.set_content('<main>已保存的草稿</main>')
            return candidate, page.locator('main'), {'outcome': 'matched'}
        file = Path(self.tmp.name) / 'state.json'
        with patch.object(bridge, 'locate_baijiahao_draft', new=locate), \
                patch.object(bridge, 'local_video_duration', return_value=290.466):
            result = await bridge.reconcile_saved_draft(self.browser, self.payload, self.state, file,
                                                        (None, None, None, self.helpers))
        self.assertTrue(result['saved'])
        await self.editor(description=actual)
        self.assertEqual((await self.verify())['title'], actual)

    async def test_incomplete_server_record_uses_existing_readback_fallback(self):
        candidate = self.saved_record()
        candidate['record'].pop('rmb_duration')
        self.assertIsNone(await bridge.verify_baijiahao_video_record(self.payload, self.state, candidate))
        candidate.pop('record')
        self.assertIsNone(await bridge.verify_baijiahao_video_record(self.payload, self.state, candidate))

    async def test_saved_editor_without_old_css_class_is_verified_without_save_or_publish(self):
        await self.editor()
        result = await self.verify()
        self.assertEqual(result["videoSha256"], self.digest)
        self.assertEqual(result["accountName"], "sports")
        self.assertEqual(result["videoDuration"], 290.466)
        self.assertEqual(await self.page.evaluate("[window.saved,window.published]"), [0, 0])

    async def test_blank_saved_editor_gets_one_read_only_reload(self):
        loads = []
        async def respond(route):
            loads.append(route.request.url)
            body = '<meta charset="utf-8"><main>百家号</main>'
            if len(loads) > 1:
                body += f'''<div contenteditable="true" data-placeholder="作品描述">{self.payload['description']}</div>
                  <video src="https://media.example.test/transcoded.mp4" style="width:320px;height:180px"></video>
                  <button onclick="window.saved++">存草稿</button>
                  <script>window.saved=0;const v=document.querySelector('video');
                    Object.defineProperty(v,'duration',{{value:290.466}});
                    Object.defineProperty(v,'readyState',{{value:1}});</script>'''
            await route.fulfill(body=body, content_type='text/html')
        await self.page.route('https://saved-video-fixture.test/editor', respond)
        await self.page.goto('https://saved-video-fixture.test/editor')
        with patch.object(bridge, "local_video_duration", return_value=290.466):
            result = await bridge.verify_saved_video(self.page, self.payload, self.state, self.helpers, timeout=1)
        self.assertEqual(len(loads), 2)
        self.assertEqual(result['videoSha256'], self.digest)
        self.assertEqual(await self.page.evaluate('window.saved'), 0)

    async def test_same_title_cannot_confirm_missing_or_different_video(self):
        for options in ({"with_video": False}, {"duration": 12.0}):
            with self.subTest(options=options):
                await self.editor(**options)
                with self.assertRaises(RuntimeError):
                    await self.verify()

    async def test_changed_copy_or_local_source_is_not_accepted(self):
        await self.editor(description="另一场比赛")
        with self.assertRaises(RuntimeError):
            await self.verify()
        await self.editor()
        self.video.write_bytes(b"replaced-video")
        with self.assertRaisesRegex(RuntimeError, "素材.*变化"):
            await self.verify()


if __name__ == "__main__":
    unittest.main()
