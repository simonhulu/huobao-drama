"""Exercise account isolation at the real bridge entry point, without browsers."""
import asyncio
import fcntl
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

import bridge


class AccountUploadLockTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = {"stateRoot": str(self.root / "state"), "baijiahao": "http://127.0.0.1:9225",
                       "tencent": "http://127.0.0.1:9222"}

    def request(self, job="cba-first", account="cba_first", target="baijiahao-video", **config):
        payload = {"jobId": job, "target": target}
        if account is not None:
            payload["accountName"] = account
        return {"config": {**self.config, **config}, "payload": payload}

    async def while_uploading(self, first, inspect):
        entered, release = asyncio.Event(), asyncio.Event()

        async def upload(request, action):
            if request is first:
                entered.set()
                await release.wait()
            return {"jobId": request["payload"]["jobId"]}

        with patch.object(bridge, "upload", side_effect=upload) as runner:
            pending = asyncio.create_task(bridge.locked_action(first, "stage"))
            await asyncio.wait_for(entered.wait(), 2)
            try:
                await inspect(runner)
            finally:
                release.set()
                await pending

    async def test_different_accounts_upload_concurrently_across_projects(self):
        first = self.request("history-first", "history_baijiahao")

        async def inspect(runner):
            result = await bridge.locked_action(self.request("cba-second", "cba_first"), "stage")
            self.assertEqual(result["jobId"], "cba-second")
            self.assertEqual(runner.await_count, 2)

        await self.while_uploading(first, inspect)

    async def test_same_account_video_and_article_share_one_lock(self):
        first = self.request("history-video", "history_baijiahao")

        async def inspect(runner):
            other = self.request("another-project", "history_baijiahao", "baijiahao-article")
            with self.assertRaisesRegex(RuntimeError, "正在运行"):
                await bridge.locked_action(other, "stage")
            checkpoint = await bridge.locked_action(other, "checkpoint")
            self.assertEqual(checkpoint["action"], "busy")
            self.assertEqual(runner.await_count, 1)

        await self.while_uploading(first, inspect)

    async def test_different_platform_accounts_do_not_block_each_other(self):
        first = self.request("baijiahao-first", "history_baijiahao")

        async def inspect(runner):
            result = await bridge.locked_action(self.request("tencent-second", "history_tencent", "tencent-video"), "stage")
            self.assertEqual(result["jobId"], "tencent-second")

        await self.while_uploading(first, inspect)

    async def test_legacy_browser_endpoint_is_normalized_and_separate_from_named_accounts(self):
        first = self.request(account=None)

        async def inspect(runner):
            same = self.request("same-browser", None, baijiahao="http://127.0.0.1:9225/")
            self.assertEqual((await bridge.locked_action(same, "checkpoint"))["action"], "busy")
            for other in (self.request("named-browser", "cba_first"),
                          self.request("different-browser", None, baijiahao="http://127.0.0.1:9226")):
                self.assertEqual((await bridge.locked_action(other, "stage"))["jobId"], other["payload"]["jobId"])

        await self.while_uploading(first, inspect)

    async def test_same_job_cannot_be_dispatched_through_a_second_account(self):
        first = self.request()

        async def inspect(runner):
            with self.assertRaisesRegex(RuntimeError, "正在运行"):
                await bridge.locked_action(self.request(account="cba_second"), "stage")
            self.assertEqual(runner.await_count, 1)

        await self.while_uploading(first, inspect)

    async def test_history_named_account_and_its_legacy_browser_cannot_upload_together(self):
        for account, other in (("history_baijiahao", None), (None, "history_baijiahao")):
            with self.subTest(first=account):
                async def inspect(runner):
                    result = await bridge.locked_action(self.request("same-history-login", other), "checkpoint")
                    self.assertEqual(result["action"], "busy")
                    self.assertEqual(runner.await_count, 1)

                await self.while_uploading(self.request(account=account), inspect)

    async def test_failure_and_cancellation_release_account_and_job_locks(self):
        request = self.request()
        with patch.object(bridge, "upload", side_effect=RuntimeError("simulated failure")):
            with self.assertRaisesRegex(RuntimeError, "simulated failure"):
                await bridge.locked_action(request, "stage")
        entered = asyncio.Event()

        async def hang(*_):
            entered.set()
            await asyncio.Event().wait()

        with patch.object(bridge, "upload", side_effect=hang):
            task = asyncio.create_task(bridge.locked_action(request, "stage"))
            await asyncio.wait_for(entered.wait(), 2)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        with patch.object(bridge, "upload", new=AsyncMock(return_value="released")):
            self.assertEqual(await bridge.locked_action(request, "stage"), "released")

    async def test_running_legacy_process_is_respected_until_it_releases_global_lock(self):
        root = Path(self.config["stateRoot"])
        root.mkdir()
        with (root / "runtime.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            for name in ("cba_first", "cba_second"):
                result = await bridge.locked_action(self.request(account=name), "checkpoint")
                self.assertEqual(result["action"], "busy")
        with patch.object(bridge, "upload", new=AsyncMock(return_value="released")):
            self.assertEqual(await bridge.locked_action(self.request(), "stage"), "released")

    async def test_cross_process_account_exclusion_and_process_exit_release(self):
        program = """
import asyncio,json,sys
import bridge
async def hold(request,action):
    print('LOCKED',flush=True)
    await asyncio.Event().wait()
bridge.upload=hold
asyncio.run(bridge.locked_action(json.loads(sys.argv[1]),'stage'))
"""
        child = await asyncio.create_subprocess_exec(sys.executable, "-c", program, json.dumps(self.request()),
                                                     cwd=Path(bridge.__file__).parent,
                                                     stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            self.assertEqual(await asyncio.wait_for(child.stdout.readline(), 3), b"LOCKED\n")
            self.assertEqual((await bridge.locked_action(self.request("same-account"), "checkpoint"))["action"], "busy")
            with patch.object(bridge, "upload", new=AsyncMock(return_value="other-account")):
                self.assertEqual(await bridge.locked_action(self.request("different-account", "cba_second"), "stage"), "other-account")
        finally:
            if child.returncode is None:
                child.terminate()
            await asyncio.wait_for(child.wait(), 3)
        with patch.object(bridge, "upload", new=AsyncMock(return_value="after-exit")):
            self.assertEqual(await bridge.locked_action(self.request(), "stage"), "after-exit")


if __name__ == "__main__":
    unittest.main()
