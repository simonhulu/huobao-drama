"""Media verification must abort stalled browser reads without changing the editor."""
import asyncio
import hashlib
from pathlib import Path
import tempfile
from unittest.mock import AsyncMock, patch
import unittest

from playwright.async_api import async_playwright
from uploader.baijiahao_uploader import stage

import editor_compat
import bridge
from editor_compat import BaijiahaoEditor


class MediaReadDeadlineTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.pw = await async_playwright().start()
        self.addAsyncCleanup(self.pw.stop)
        self.browser = await self.pw.chromium.launch(channel="chrome", headless=True)
        self.addAsyncCleanup(self.browser.close)
        self.page = await self.browser.new_page()
        await self.page.route("https://media-read.test/", lambda route: route.fulfill(body="<html></html>", content_type="text/html"))
        await self.page.goto("https://media-read.test/")
        self.helpers = BaijiahaoEditor(stage)
        self.enterContext(patch.object(editor_compat, "VIDEO_READ_TIMEOUT_SECONDS", 0.08, create=True))
        self.enterContext(patch.object(editor_compat, "COVER_READ_TIMEOUT_SECONDS", 0.08, create=True))
        self.enterContext(patch.object(editor_compat, "MEDIA_READ_GRACE_SECONDS", 0.08, create=True))

    async def stall(self, body=False):
        await self.page.evaluate("""body => {
          window.fetchStarted=false;window.fetchAborted=false;
          window.fetch=(url,{signal}={}) => {
            const pending=()=>new Promise((resolve,reject)=>{
              window.fetchStarted=true;
              signal?.addEventListener('abort',()=>{window.fetchAborted=true;reject(new DOMException('Aborted','AbortError'));},{once:true});
            });
            return body?Promise.resolve({ok:true,arrayBuffer:pending,blob:pending}):pending();
          };
        }""", body)

    async def assert_clean(self):
        self.assertTrue(await self.page.evaluate("window.fetchAborted"), "the browser request must receive abort")
        self.assertEqual(await self.page.evaluate("window.__huobaoSauMediaReads?.size || 0"), 0)

    async def test_blob_digest_matches_the_actual_bytes(self):
        expected = b"verified local video bytes"
        src = await self.page.evaluate("value=>URL.createObjectURL(new Blob([value]))", expected.decode())
        self.assertEqual(await self.helpers._browser_digest(self.page, src), hashlib.sha256(expected).hexdigest())

    async def test_verify_upload_checks_blob_hash_without_delegating_to_the_unbounded_base(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "video.mp4"
            file.write_bytes(b"verified local video bytes")
            src = await self.page.evaluate("()=>URL.createObjectURL(new Blob(['verified local video bytes']))")
            snapshot = {"text": "", "video_v2_ready": True, "videos": [{"src": src, "ready": 4, "duration": 2}]}
            await self.page.evaluate("snapshot=>window.mediaSnapshot=snapshot", snapshot)
            with patch.object(stage, "_READ_MEDIA", "()=>window.mediaSnapshot"), \
                    patch.object(stage, "verify_upload", AsyncMock(side_effect=AssertionError("unbounded base path"))):
                result = await self.helpers.verify_upload(self.page, str(file), timeout=0.01)
                self.assertEqual(result["verification"], "blob_sha256")
                self.assertEqual(result["video_fingerprint"], hashlib.sha256(file.read_bytes()).hexdigest())
                file.write_bytes(b"different local video")
                with self.assertRaisesRegex(RuntimeError, "SHA-256"):
                    await self.helpers.verify_upload(self.page, str(file), timeout=0.01)

    async def uploaded_video(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        file = Path(directory.name) / 'video.mp4'
        file.write_bytes(b'verified local video bytes')
        src = await self.page.evaluate("()=>URL.createObjectURL(new Blob(['verified local video bytes']))")
        await self.page.evaluate("src=>window.mediaSnapshot={text:'',video_v2_ready:true,videos:[{src,ready:4,duration:2}]}", src)
        self.enterContext(patch.object(stage, '_READ_MEDIA', '()=>window.mediaSnapshot'))
        proof = {'status': 'uploaded', 'verification': 'blob_sha256', 'media_src': src,
                 'video_fingerprint': hashlib.sha256(file.read_bytes()).hexdigest()}
        return file, proof

    async def test_unchanged_ready_blob_reuses_the_exact_prior_sha_proof(self):
        file, proof = await self.uploaded_video()
        with patch.object(self.helpers, '_browser_digest', AsyncMock(side_effect=AssertionError('must reuse immutable blob'))) as read:
            result = await self.helpers.verify_upload(self.page, str(file), timeout=0.01, verified_media=proof)
        self.assertEqual(result, proof)
        read.assert_not_awaited()

    async def test_changed_blob_url_requires_a_complete_browser_hash(self):
        file, proof = await self.uploaded_video()
        current = await self.page.evaluate("()=>{const src=URL.createObjectURL(new Blob(['verified local video bytes']));window.mediaSnapshot.videos[0].src=src;return src;}")
        with patch.object(self.helpers, '_browser_digest', AsyncMock(return_value=proof['video_fingerprint'])) as read:
            result = await self.helpers.verify_upload(self.page, str(file), timeout=0.01, verified_media=proof)
        read.assert_awaited_once_with(self.page, current)
        self.assertEqual(result['media_src'], current)

    async def test_changed_local_bytes_cannot_reuse_the_prior_blob_proof(self):
        file, proof = await self.uploaded_video()
        file.write_bytes(b'changed video bytes')
        with patch.object(self.helpers, '_browser_digest', AsyncMock(return_value=proof['video_fingerprint'])) as read:
            with self.assertRaisesRegex(RuntimeError, 'SHA-256'):
                await self.helpers.verify_upload(self.page, str(file), timeout=0.01, verified_media=proof)
        read.assert_awaited_once_with(self.page, proof['media_src'])

    async def test_missing_or_incomplete_blob_proof_still_reads_the_browser_bytes(self):
        file, proof = await self.uploaded_video()
        for prior in (None, {}, {**proof, 'status': 'uploading'}, {**proof, 'verification': 'ready_server_preview'},
                      {**proof, 'video_fingerprint': None}, {**proof, 'media_src': None}):
            with self.subTest(prior=prior), patch.object(self.helpers, '_browser_digest', AsyncMock(return_value=proof['video_fingerprint'])) as read:
                await self.helpers.verify_upload(self.page, str(file), timeout=0.01, verified_media=prior)
                read.assert_awaited_once_with(self.page, proof['media_src'])

    async def test_staged_verification_passes_blob_proof_only_after_document_verification(self):
        file, proof = await self.uploaded_video()
        events = []
        verify_document = AsyncMock(side_effect=lambda *args: events.append('document'))
        verify_upload = AsyncMock(side_effect=lambda *args, **kwargs: events.append('media') or proof)
        state = {'details': {'media': proof, 'metadata': {}, 'covers': {}}}
        with patch.object(bridge, 'verify_document', verify_document), \
                patch.object(self.helpers, 'verify_upload', verify_upload), \
                patch.object(self.helpers, 'verify_page', AsyncMock()), \
                patch.object(bridge, 'verify_baijiahao_fields', AsyncMock()):
            await bridge.verify_staged(self.page, {'target': 'baijiahao-video', 'videoPath': str(file)},
                                       state, (None, None, None, self.helpers, None, None))
            verify_upload.assert_awaited_once_with(self.page, str(file), timeout=5, verified_media=proof)
            self.assertEqual(events, ['document', 'media'])
            verify_upload.reset_mock()
            verify_document.side_effect = RuntimeError('原文档身份已变化')
            with self.assertRaisesRegex(RuntimeError, '身份已变化'):
                await bridge.verify_staged(self.page, {'target': 'baijiahao-video', 'videoPath': str(file)},
                                           state, (None, None, None, self.helpers, None, None))
            verify_upload.assert_not_awaited()

    async def test_stalled_video_fetch_is_aborted_at_the_read_deadline(self):
        await self.stall()
        with self.assertRaisesRegex(TimeoutError, "原视频.*检查点"):
            await asyncio.wait_for(self.helpers._browser_digest(self.page, "blob:stalled"), 0.6)
        await self.assert_clean()

    async def test_stalled_video_body_is_aborted_at_the_read_deadline(self):
        await self.stall(body=True)
        with self.assertRaisesRegex(TimeoutError, "原视频.*检查点"):
            await asyncio.wait_for(self.helpers._browser_digest(self.page, "blob:stalled"), 0.6)
        await self.assert_clean()

    async def test_native_fetch_aborts_a_stalled_http_response_body(self):
        disconnected = asyncio.Event()
        writers = set()

        async def serve(reader, writer):
            writers.add(writer)
            try:
                request = await reader.readuntil(b'\r\n\r\n')
                if request.startswith(b'GET / HTTP'):
                    writer.write(b'HTTP/1.1 200 OK\r\nContent-Length: 13\r\nConnection: close\r\n\r\n<html></html>')
                    await writer.drain()
                elif request.startswith(b'GET /video HTTP'):
                    writer.write(b'HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\nx')
                    await writer.drain()
                    await reader.read()
                    disconnected.set()
                else:
                    writer.write(b'HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n')
                    await writer.drain()
            finally:
                writer.close()
                writers.discard(writer)

        server = await asyncio.start_server(serve, '127.0.0.1', 0)
        port = server.sockets[0].getsockname()[1]
        try:
            await self.page.goto(f'http://127.0.0.1:{port}/')
            with self.assertRaisesRegex(TimeoutError, '原视频.*检查点'):
                await self.helpers._browser_digest(self.page, f'http://127.0.0.1:{port}/video')
            await asyncio.wait_for(disconnected.wait(), 1)
            self.assertEqual(await self.page.evaluate('window.__huobaoSauMediaReads.size'), 0)
        finally:
            for writer in list(writers):
                writer.close()
            server.close()
            await server.wait_closed()

    async def test_stalled_cover_body_is_aborted_at_the_read_deadline(self):
        await self.stall(body=True)
        with self.assertRaisesRegex(TimeoutError, "封面.*检查点"):
            await asyncio.wait_for(self.helpers._cover_pixels(self.page, "blob:stalled"), 0.6)
        await self.assert_clean()

    async def test_stalled_file_reader_is_aborted_at_the_read_deadline(self):
        await self.page.evaluate("""()=>{
          window.fetchAborted=false;window.readerAborted=false;
          window.fetch=(url,{signal})=>{
            signal.addEventListener('abort',()=>window.fetchAborted=true);
            return Promise.resolve({ok:true,blob:async()=>new Blob(['cover'])});
          };
          window.FileReader=class {
            readyState=0;
            readAsDataURL(){this.readyState=1;}
            abort(){window.readerAborted=true;this.readyState=2;this.onabort?.();}
          };
        }""")
        with self.assertRaisesRegex(TimeoutError, "封面.*检查点"):
            await asyncio.wait_for(self.helpers._cover_pixels(self.page, "blob:stalled"), 0.6)
        await self.assert_clean()
        self.assertTrue(await self.page.evaluate("window.readerAborted"))

    async def test_cancelling_a_cover_read_aborts_and_removes_the_browser_operation(self):
        await self.stall(body=True)
        task = asyncio.create_task(self.helpers._cover_pixels(self.page, "blob:stalled"))
        await self.page.wait_for_function("window.fetchStarted")
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        await self.assert_clean()

    async def test_python_deadline_still_bounds_an_unresponsive_browser_evaluate(self):
        class UnresponsivePage:
            calls = 0

            async def evaluate(self, *args):
                self.calls += 1
                if self.calls == 1:
                    await asyncio.Future()

        page = UnresponsivePage()
        with self.assertRaisesRegex(TimeoutError, "封面.*检查点"):
            await asyncio.wait_for(self.helpers._cover_pixels(page, "blob:stalled"), 0.6)
        self.assertEqual(page.calls, 2, "the outer deadline must attempt browser-side cleanup")

    async def test_final_cover_check_still_rejects_changed_pixels_at_the_same_url(self):
        source = await self.page.evaluate("""()=>{
          const canvas=document.createElement('canvas');canvas.width=128;canvas.height=72;
          canvas.getContext('2d').fillStyle='red';canvas.getContext('2d').fillRect(0,0,128,72);
          return canvas.toDataURL();
        }""")
        pixels = await self.helpers._cover_pixels(self.page, source)
        covers = {kind: {"status": "uploaded", "fingerprint": kind, "source_sha256_verified": kind,
                         "preview": source, "pixels_sha256": hashlib.sha256(pixels.tobytes()).hexdigest()}
                  for kind in ("landscape", "portrait")}
        self.helpers._cover_slots = AsyncMock(return_value={kind: {"src": source} for kind in covers})
        with patch.object(stage, "_READ_DIALOGS", "()=>[]"), patch.object(stage, "_verify_metadata", AsyncMock()):
            await self.helpers.verify_page(self.page, {}, covers)
            replacement = await self.page.evaluate("""()=>{
              const canvas=document.createElement('canvas');canvas.width=128;canvas.height=72;
              return canvas.toDataURL();
            }""")
            await self.page.evaluate("replacement=>{const original=window.fetch;window.fetch=()=>original(replacement)}", replacement)
            with self.assertRaisesRegex(RuntimeError, "封面.*不一致"):
                await self.helpers.verify_page(self.page, {}, covers)


if __name__ == "__main__":
    unittest.main()
