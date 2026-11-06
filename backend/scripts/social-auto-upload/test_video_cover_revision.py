"""A cover revision retains the original uploaded video and editor binding."""
import copy
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

import bridge


class PlaywrightContext:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False


class VideoCoverRevisionTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name).resolve()
        paths = {}
        for name in ('video.mp4', 'old-wide.jpg', 'old-tall.jpg', 'poster-v2-wide.jpg', 'poster-v2-tall.jpg'):
            file = root / name
            file.write_bytes(name.encode())
            paths[name] = str(file)
        self.old = {'jobId': 'original-video', 'scriptId': 0, 'target': 'baijiahao-video',
                    'accountName': 'science_example', 'publicationMode': 'publish', 'title': '原视频标题',
                    'description': '原视频标题 #热爆趣创赛#', 'fingerprint': 'old-fingerprint',
                    'videoPath': paths['video.mp4'], 'landscapePath': paths['old-wide.jpg'],
                    'portraitPath': paths['old-tall.jpg']}
        self.new = {**self.old, 'fingerprint': 'new-fingerprint',
                    'landscapePath': paths['poster-v2-wide.jpg'], 'portraitPath': paths['poster-v2-tall.jpg']}
        self.request = {'config': {'stateRoot': str(root / 'state')}, 'payload': self.old,
                        'revisedPayload': self.new, 'updateVideoCovers': True}
        self.file = bridge.job_state_file(self.request)
        self.file.parent.mkdir(parents=True)
        digest = bridge.local_files(self.old)[self.old['videoPath']]
        self.media = {'status': 'uploaded', 'verification': 'blob_sha256', 'media_src': 'blob:original',
                      'video_fingerprint': digest}
        self.metadata = {'layout': 'videoV2', 'title': {'status': 'source_only', 'source_value': self.old['title']},
                         'description': {'status': 'filled', 'value': self.old['description']}}
        self.state = {'phase': 'uploading', 'protocolVersion': 3, 'payloadDigest': bridge.payload_digest(self.old),
                      'files': bridge.local_files(self.old), 'targetId': 'ABC123', 'documentToken': 'original-document',
                      'accountCredentialDigest': 'a' * 64, 'fileSelectionStartedAt': 123,
                      'details': {'media': self.media, 'metadata': self.metadata}}
        bridge.write_state(self.file, self.state)
        self.page = SimpleNamespace(url=bridge.EDITORS['baijiahao-video'])
        self.browser = SimpleNamespace(contexts=[SimpleNamespace(pages=[self.page])])
        self.previews = {}
        self.helpers = SimpleNamespace(verify_upload=AsyncMock(return_value=self.media),
                                       _verify_metadata=AsyncMock(), verify_page=AsyncMock(),
                                       _cover_slots=AsyncMock(side_effect=lambda _: {kind: {'src': self.previews.get(kind)}
                                                                                   for kind in ('landscape', 'portrait')}))
        self.connect = AsyncMock(return_value=self.browser)
        self.document = AsyncMock()
        self.covers = AsyncMock(side_effect=self.prepare_covers)
        self.engine = (MagicMock(side_effect=AssertionError('must not re-upload video')), None,
                       PlaywrightContext, self.helpers, None, None)
        for name, value in [('load_engine', MagicMock(return_value=self.engine)),
                            ('connect_existing_account_browser', self.connect),
                            ('verify_document', self.document), ('page_id', AsyncMock(return_value='ABC123')),
                            ('baijiahao_covers', self.covers), ('verify_baijiahao_fields', AsyncMock(return_value=True))]:
            handle = patch.object(bridge, name, new=value, create=True)
            handle.start()
            self.addCleanup(handle.stop)

    async def prepare_covers(self, page, payload, helpers, verified=None, checkpoint=None):
        self.assertEqual(payload, self.new)
        self.assertTrue(json.loads(self.file.read_text()).get('pendingCoverRevision'))
        files = bridge.local_files(payload)
        proof = {'layout': 'videoV2'}
        for kind, key in [('landscape', 'landscapePath'), ('portrait', 'portraitPath')]:
            digest = files[payload[key]]
            proof[kind] = {'status': 'uploaded', 'fingerprint': digest, 'source_sha256_verified': digest,
                           'verification': 'source_and_preview', 'preview': 'blob:new-' + kind}
            self.previews[kind] = proof[kind]['preview']
            checkpoint(copy.deepcopy(proof))
        return proof

    async def revise(self):
        return await bridge.locked_action(self.request, 'update-video-covers')

    async def test_revision_rebinds_only_covers_and_is_idempotent_after_lost_response(self):
        response = await self.revise()
        after = json.loads(self.file.read_text())
        self.assertEqual(after['phase'], 'staged')
        self.assertEqual(after['payloadDigest'], bridge.payload_digest(self.new))
        self.assertEqual(after['files'], bridge.local_files(self.new))
        self.assertEqual(after['details']['media'], self.media)
        self.assertEqual(after['details']['metadata'], self.metadata)
        for key in ('targetId', 'documentToken', 'fileSelectionStartedAt', 'accountCredentialDigest'):
            self.assertEqual(after[key], self.state[key])
        self.assertFalse(after.get('pendingCoverRevision'))
        self.assertEqual(response['verification'], 'original_video_and_revised_covers')
        self.assertEqual(response['previousPayloadDigest'], bridge.payload_digest(self.old))
        self.assertFalse(response['result']['saved'])
        self.assertFalse(response['result']['published'])
        self.assertEqual(await self.revise(), response)
        self.covers.assert_awaited_once()
        self.connect.assert_awaited_once()

    async def test_wrong_binding_or_publication_attempt_never_connects_or_replaces_covers(self):
        for change in [{'publishAttemptedAt': 0}, {'saveAttemptedAt': 123}, {'phase': 'published'},
                       {'payloadDigest': 'b' * 64}, {'targetId': None}, {'documentToken': None}]:
            with self.subTest(change=change):
                bridge.write_state(self.file, {**self.state, **change})
                with self.assertRaises(RuntimeError):
                    await self.revise()
        bridge.write_state(self.file, self.state)
        for key, value in [('accountName', 'science_other'), ('description', 'changed'), ('videoPath', self.new['landscapePath'])]:
            with self.subTest(key=key):
                self.request['revisedPayload'] = {**self.new, key: value}
                with self.assertRaises(RuntimeError):
                    await self.revise()
        self.connect.assert_not_awaited()
        self.covers.assert_not_awaited()

    async def test_changed_document_or_remote_video_never_replaces_covers(self):
        self.document.side_effect = RuntimeError('changed document')
        with self.assertRaisesRegex(RuntimeError, 'document'):
            await self.revise()
        self.document.side_effect = None
        self.helpers.verify_upload.return_value = {**self.media, 'media_src': 'blob:other'}
        with self.assertRaisesRegex(RuntimeError, '视频'):
            await self.revise()
        self.covers.assert_not_awaited()

    async def test_interrupted_revision_blocks_old_resume_and_reuses_completed_cover_proof(self):
        async def interrupt(page, payload, helpers, verified=None, checkpoint=None):
            proof = await self.prepare_covers(page, payload, helpers, verified, checkpoint)
            raise RuntimeError('interrupted after both covers')
        self.covers.side_effect = interrupt
        with self.assertRaisesRegex(RuntimeError, 'interrupted'):
            await self.revise()
        state = json.loads(self.file.read_text())
        self.assertEqual(state['payloadDigest'], bridge.payload_digest(self.old))
        self.assertEqual(bridge.inspect_checkpoint(self.request)['action'], 'manual')
        with self.assertRaisesRegex(RuntimeError, '封面'):
            await bridge.upload(self.request, 'resume')
        with self.assertRaisesRegex(RuntimeError, '封面'):
            await bridge.finish_failed_attempt(self.request, reset=True)
        self.covers.side_effect = self.prepare_covers
        await self.revise()
        previous = self.covers.await_args.kwargs['verified']
        self.assertEqual(previous['portrait']['verification'], 'source_and_preview')

    async def test_replaced_revision_preview_is_not_rebound_to_the_previously_verified_picture(self):
        async def interrupt(page, payload, helpers, verified=None, checkpoint=None):
            await self.prepare_covers(page, payload, helpers, verified, checkpoint)
            raise RuntimeError('interrupted')
        self.covers.side_effect = interrupt
        with self.assertRaisesRegex(RuntimeError, 'interrupted'):
            await self.revise()
        self.previews['portrait'] = 'blob:someone-elses-cover'
        self.covers.side_effect = self.prepare_covers
        with self.assertRaisesRegex(RuntimeError, '预览发生变化'):
            await self.revise()
        self.assertEqual(self.covers.await_count, 1)
        self.assertEqual(json.loads(self.file.read_text())['payloadDigest'], bridge.payload_digest(self.old))


if __name__ == '__main__':
    unittest.main()
