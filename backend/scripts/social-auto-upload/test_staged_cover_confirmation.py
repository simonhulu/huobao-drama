"""A delayed crop modal may be finished only for the original staged poster."""
import copy
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

import bridge


class StagedCoverConfirmationTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.file = Path(temporary.name) / 'state.json'
        self.payload = {'target': 'baijiahao-video', 'publicationMode': 'publish',
                        'videoPath': 'video', 'landscapePath': 'wide', 'portraitPath': 'tall'}
        self.proofs = {kind: {'status': 'uploaded', 'fingerprint': digest,
                             'source_sha256_verified': digest, 'verification': 'source_and_preview',
                             'preview': kind}
                       for kind, digest in [('landscape', 'wide-sha'), ('portrait', 'tall-sha')]}
        self.media = {'media_src': 'blob:original-video', 'video_fingerprint': 'video-sha',
                      'verification': 'blob_sha256'}
        self.state = {'phase': 'staged', 'details': {'media': self.media, 'metadata': {},
                                                  'covers': copy.deepcopy(self.proofs)}}
        self.dialog = {'index': 0, 'text': '横版封面预览 (16:9)', 'source': 'blob:bound-poster',
                       'source_count': 1, 'preview_count': 1,
                       'preview': {'src': 'blob:crop', 'width': 1280, 'height': 720}}
        self.page = SimpleNamespace(evaluate=AsyncMock(return_value=[self.dialog]),
            locator=MagicMock(return_value=SimpleNamespace(evaluate_all=AsyncMock(return_value=[0]))))
        self.helpers = SimpleNamespace(_READ_DIALOGS='dialogs',
            _file_digest=lambda path: {'video': 'video-sha', 'wide': 'wide-sha', 'tall': 'tall-sha'}[path],
            _browser_digest=AsyncMock(return_value='wide-sha'),
            verify_upload=AsyncMock(return_value=self.media), _verify_metadata=AsyncMock(),
            _cover_slots=AsyncMock(return_value={kind: {'src': kind} for kind in self.proofs}),
            verify_page=AsyncMock())
        self.engine = (None, None, None, self.helpers, None, None)
        self.verify_document = AsyncMock()
        patcher = patch.object(bridge, 'verify_document', self.verify_document)
        patcher.start()
        self.addCleanup(patcher.stop)

    async def test_matching_crop_finishes_without_selecting_any_file_and_persists_proofs(self):
        async def confirm(page, payload, helpers, *, verified, checkpoint, confirm_only):
            self.assertTrue(confirm_only)
            self.assertEqual(verified, self.proofs)
            covers = {**copy.deepcopy(verified), 'landscape': {**verified['landscape'], 'preview': 'confirmed-wide'}}
            checkpoint(covers)
            return covers
        with patch.object(bridge, 'baijiahao_covers', AsyncMock(side_effect=confirm)) as covers:
            await bridge.finish_staged_baijiahao_cover(self.page, self.payload, self.state, self.file, self.engine)
        covers.assert_awaited_once()
        self.verify_document.assert_awaited_once()
        self.assertEqual(json.loads(self.file.read_text())['details']['covers']['landscape']['preview'], 'confirmed-wide')
        self.assertNotIn('saveAttemptedAt', self.state)
        self.assertNotIn('publishAttemptedAt', self.state)

    async def test_unknown_or_wrong_source_crop_never_confirms(self):
        for text, digest in [('其他窗口', 'wide-sha'), ('横版封面预览 (16:9)', 'different-sha')]:
            with self.subTest(text=text, digest=digest):
                self.dialog['text'] = text
                self.helpers._browser_digest.return_value = digest
                with patch.object(bridge, 'baijiahao_covers', AsyncMock()) as covers:
                    with self.assertRaises(RuntimeError):
                        await bridge.finish_staged_baijiahao_cover(self.page, self.payload, self.state, self.file, self.engine)
                    covers.assert_not_awaited()

    async def test_read_only_preflight_never_confirms_a_crop(self):
        self.state['files'] = {}
        with patch.object(bridge, 'local_files', return_value={}), \
                patch.object(bridge, 'verify_staged', AsyncMock(side_effect=RuntimeError('pending crop'))), \
                patch.object(bridge, 'finish_staged_baijiahao_cover', AsyncMock()) as finish:
            with self.assertRaisesRegex(RuntimeError, 'pending crop'):
                await bridge.publication_preflight(self.page, self.payload, self.state, self.engine)
            finish.assert_not_awaited()

    async def test_confirm_only_cannot_select_a_missing_cover(self):
        page = MagicMock()
        page.evaluate = AsyncMock(return_value=[])
        with self.assertRaisesRegex(RuntimeError, '重新选择'):
            await bridge.baijiahao_covers(page, self.payload, self.helpers, confirm_only=True)
        page.locator.assert_not_called()


if __name__ == '__main__':
    unittest.main()
