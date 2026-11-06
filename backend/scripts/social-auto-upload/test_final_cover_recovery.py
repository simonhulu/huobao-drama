"""Late crop dialogs can be confirmed only against the already proven cover files."""

import copy
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

import bridge


class FinalCoverRecoveryTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.page = object()
        self.payload = {"landscapePath": "wide", "portraitPath": "tall"}
        self.metadata = {"description": {"value": "bound copy"}}
        self.covers = {kind: {"status": "uploaded", "fingerprint": digest,
                             "source_sha256_verified": digest, "preview": kind}
                       for kind, digest in (("landscape", "wide-sha"), ("portrait", "tall-sha"))}
        self.error = "百家号封面弹窗尚未确认，未保存"
        self.helpers = SimpleNamespace(
            verify_page=AsyncMock(side_effect=[RuntimeError(self.error), None]),
            _file_digest=lambda path: {"wide": "wide-sha", "tall": "tall-sha"}[path],
            _verify_metadata=AsyncMock(),
        )
        self.dialogs = AsyncMock(return_value=[{"text": "竖版封面预览"}])
        self.confirm = AsyncMock(return_value=self.covers)
        for name, value in (("baijiahao_cover_dialogs", self.dialogs), ("baijiahao_covers", self.confirm)):
            patcher = patch.object(bridge, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    async def verify(self, checkpoint=None):
        return await bridge.verify_baijiahao_page_after_covers(
            self.page, self.payload, self.helpers, self.metadata, self.covers, checkpoint)

    async def test_late_crop_is_confirmed_with_existing_proofs_before_reverification(self):
        checkpoint = object()
        result = await self.verify(checkpoint)
        self.assertEqual(result, self.covers)
        self.confirm.assert_awaited_once_with(self.page, self.payload, self.helpers,
            verified=self.covers, checkpoint=checkpoint, confirm_only=True)
        self.helpers._verify_metadata.assert_awaited_once_with(self.page, self.metadata)
        self.assertEqual(self.helpers.verify_page.await_count, 2)

    async def test_recovery_returns_new_cover_proofs(self):
        updated = copy.deepcopy(self.covers)
        updated["portrait"]["preview"] = "new server preview"
        self.confirm.return_value = updated
        self.assertEqual(await self.verify(), updated)
        self.helpers.verify_page.assert_awaited_with(self.page, self.metadata, updated)

    async def test_repeated_modal_recovery_is_bounded(self):
        self.helpers.verify_page.side_effect = RuntimeError(self.error)
        with self.assertRaisesRegex(RuntimeError, "封面弹窗尚未确认"):
            await self.verify()
        self.assertEqual(self.confirm.await_count, 2)
        self.assertEqual(self.helpers.verify_page.await_count, 3)

    async def test_unknown_topmost_dialog_is_never_confirmed(self):
        self.dialogs.side_effect = RuntimeError("封面窗口被账号安全验证遮挡")
        with self.assertRaisesRegex(RuntimeError, "账号安全验证"):
            await self.verify()
        self.confirm.assert_not_awaited()

    async def test_changed_or_incomplete_source_proof_is_never_confirmed(self):
        for key, value in (("fingerprint", "different"), ("source_sha256_verified", None), ("status", "pending")):
            with self.subTest(key=key):
                self.helpers.verify_page.side_effect = RuntimeError(self.error)
                previous = self.covers["landscape"][key]
                self.covers["landscape"][key] = value
                with self.assertRaisesRegex(RuntimeError, "完整源图上传证明"):
                    await self.verify()
                self.covers["landscape"][key] = previous
        self.confirm.assert_not_awaited()

    async def test_wrong_crop_source_is_not_reselected(self):
        self.confirm.side_effect = RuntimeError("当前裁剪源图与本任务封面不一致，不能确认")
        with self.assertRaisesRegex(RuntimeError, "源图与本任务封面不一致"):
            await self.verify()
        self.assertTrue(self.confirm.call_args.kwargs["confirm_only"])
        self.assertEqual(self.helpers.verify_page.await_count, 1)

    async def test_unrelated_verification_error_is_not_retried(self):
        self.helpers.verify_page.side_effect = RuntimeError("文案已变化")
        with self.assertRaisesRegex(RuntimeError, "文案已变化"):
            await self.verify()
        self.confirm.assert_not_awaited()
        self.dialogs.assert_not_awaited()

    async def test_dialog_that_closed_during_check_needs_no_confirmation(self):
        self.dialogs.return_value = []
        await self.verify()
        self.confirm.assert_not_awaited()
        self.assertEqual(self.helpers.verify_page.await_count, 2)


if __name__ == "__main__":
    unittest.main()
