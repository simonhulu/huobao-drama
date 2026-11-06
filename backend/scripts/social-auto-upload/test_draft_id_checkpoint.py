import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch
from types import SimpleNamespace

import bridge


class DraftIdCheckpointTest(unittest.IsolatedAsyncioTestCase):
    async def test_found_id_survives_readback_failure_and_is_used_on_retry(self):
        payload = {'target': 'tencent-video', 'title': '原稿短标题', 'description': '原稿简介'}
        state = {'phase': 'save_requested', 'saveAttemptedAt': 123, 'saveClickedAt': 124,
                 'result': {'saved': False, 'published': False}}
        page, row = MagicMock(), MagicMock()
        page.url = 'https://channels.weixin.qq.com/platform/post/create'
        page.screenshot = AsyncMock()
        page.close = AsyncMock()
        page.locator.return_value.wait_for = AsyncMock()
        row.hover = AsyncMock()
        edit = row.locator.return_value.filter.return_value
        edit.count = AsyncMock(return_value=1)
        edit.click = AsyncMock()
        browser = SimpleNamespace(contexts=[SimpleNamespace(new_page=AsyncMock(return_value=page))])
        find = AsyncMock(return_value=({'id': 'export/kept', 'time': '2026年10月25日 21:21'},
                                      row, {'outcome': 'found', 'pagesScanned': [1, 2]}))
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(bridge, 'locate_tencent_draft', find), \
                patch.object(bridge, 'verify_tencent_metadata', AsyncMock(side_effect=[RuntimeError('编辑页加载失败'), None])), \
                patch.object(bridge, 'tencent_save_flags', AsyncMock(return_value={'draftObjectId': 'export/kept'})), \
                patch.object(bridge, 'one_button', side_effect=AssertionError('Must not save again')):
            file = Path(directory) / 'state.json'
            with self.assertRaisesRegex(RuntimeError, '编辑页加载失败'):
                await bridge.reconcile_tencent_draft(browser, payload, state, file, ())
            stored = json.loads(file.read_text())
            self.assertEqual(stored['expectedDraftId'], 'export/kept')
            self.assertFalse(stored['result']['saved'])
            result = await bridge.reconcile_tencent_draft(browser, payload, stored, file, ())
            self.assertTrue(result['saved'])
            self.assertFalse(result['published'])
            self.assertEqual(find.await_args_list[1].kwargs['expected_id'], 'export/kept')
            self.assertEqual(stored['saveClickedAt'], 124)
            self.assertNotIn('error', stored)

    async def test_bound_editor_receipt_is_durable_but_does_not_mark_saved(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'state.json'
            state = {'phase': 'save_requested', 'result': {'saved': False}, 'saveClickedAt': 123}
            flags = {'draftObjectId': 'export/original', 'needCache': False, 'isCaching': False, 'isPosting': False}
            with patch.object(bridge, 'verify_document', AsyncMock()), patch.object(bridge, 'tencent_save_flags', AsyncMock(return_value=flags)):
                value = await bridge.remember_tencent_draft_id(object(), {}, state, file)
            stored = json.loads(file.read_text())
            self.assertEqual(value, 'export/original')
            self.assertEqual(stored['expectedDraftId'], value)
            self.assertFalse(stored['result']['saved'])
            self.assertEqual(stored['saveClickedAt'], 123)

    async def test_unsaved_busy_or_changed_editor_never_produces_receipt(self):
        flags = {'draftObjectId': 'export/original', 'needCache': False, 'isCaching': False, 'isPosting': False}
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'state.json'
            for change in ({'draftObjectId': ''}, {'needCache': True}, {'isCaching': True}, {'isPosting': True}):
                with patch.object(bridge, 'verify_document', AsyncMock()), patch.object(bridge, 'tencent_save_flags', AsyncMock(return_value={**flags, **change})):
                    self.assertIsNone(await bridge.remember_tencent_draft_id(object(), {}, {}, file))
            with patch.object(bridge, 'verify_document', AsyncMock(side_effect=RuntimeError('changed'))):
                self.assertIsNone(await bridge.remember_tencent_draft_id(object(), {}, {}, file))
            self.assertFalse(file.exists())


if __name__ == '__main__':
    unittest.main()
