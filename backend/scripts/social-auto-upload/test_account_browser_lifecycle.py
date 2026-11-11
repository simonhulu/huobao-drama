import asyncio
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

import account_browser
import bridge


class IdleBrowserTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        profile = self.directory / 'profile'
        profile.mkdir()
        (profile / 'DevToolsActivePort').write_text('19999\n/devtools/browser/ABC-123\n')
        self.state = {'pid': 12345, 'accountName': 'history_tencent', 'credentialDigest': 'fixture', 'initialized': True}
        account_browser.write_private(self.directory / 'session.json', self.state)
        self.targets = [{'type': 'page', 'url': 'about:blank'}]
        self.running = True
        self.raise_on_close = False

        async def send(method):
            if method == 'Target.getTargets':
                return {'targetInfos': self.targets}
            self.assertEqual(method, 'Browser.close')
            self.running = False
            if self.raise_on_close:
                raise RuntimeError('Target closed')
            return {}

        self.session = SimpleNamespace(send=AsyncMock(side_effect=send), detach=AsyncMock())
        self.browser = SimpleNamespace(new_browser_cdp_session=AsyncMock(return_value=self.session),
            _huobao_managed_session={**self.state, 'directory': self.directory,
                                    'endpoint': 'http://127.0.0.1:19999', 'browserPath': '/devtools/browser/ABC-123'})

    async def close(self):
        with patch.object(account_browser, 'alive', side_effect=lambda _: self.running), \
             patch.object(account_browser.os, 'waitpid', side_effect=ChildProcessError):
            return await account_browser.close_idle_account_browser(self.browser)

    async def test_idle_browser_exits_and_retains_initialized_profile(self):
        self.assertTrue(await self.close())
        state = json.loads((self.directory / 'session.json').read_text())
        self.assertTrue(state['initialized'])
        self.assertEqual(state['credentialDigest'], 'fixture')
        self.assertGreater(state['closedAt'], 0)
        self.assertTrue((self.directory / 'profile').is_dir())
        self.assertEqual([call.args[0] for call in self.session.send.await_args_list], ['Target.getTargets', 'Browser.close'])

    async def test_named_account_idle_browser_also_exits_after_task_cleanup(self):
        self.state["accountName"] = "sports"
        account_browser.write_private(self.directory / 'session.json', self.state)
        self.browser._huobao_managed_session["accountName"] = "sports"
        self.assertTrue(await self.close())
        self.assertFalse(self.running)

    async def test_unfinished_editor_or_unknown_tab_keeps_browser_alive(self):
        for url in ['https://channels.weixin.qq.com/platform/post/create', 'https://example.com', '']:
            with self.subTest(url=url):
                self.targets = [{'type': 'page', 'url': url}]
                self.session.send.reset_mock()
                self.assertFalse(await self.close())
                self.assertEqual([call.args[0] for call in self.session.send.await_args_list], ['Target.getTargets'])
                self.assertTrue(self.running)

    async def test_visible_unowned_browser_is_never_closed(self):
        del self.browser._huobao_managed_session
        self.assertFalse(await self.close())
        self.browser.new_browser_cdp_session.assert_not_awaited()

    async def test_unknown_target_type_is_retained(self):
        self.targets = [{'type': 'tab', 'url': 'https://channels.weixin.qq.com/platform/post/create'}]
        self.assertFalse(await self.close())
        self.session.send.assert_awaited_once_with('Target.getTargets')

    async def test_blank_tab_container_does_not_keep_an_idle_browser_running(self):
        self.targets.append({'type': 'tab', 'url': 'about:blank'})
        self.assertTrue(await self.close())

    async def test_internal_chrome_ui_and_extension_backgrounds_do_not_prevent_idle_exit(self):
        self.targets.extend([
            {'type': 'browser_ui', 'url': 'chrome://omnibox-popup.top-chrome/'},
            {'type': 'background_page', 'url': 'chrome-extension://fixture/background.html'},
            {'type': 'service_worker', 'url': 'chrome-extension://fixture/service_worker.js'},
        ])
        self.assertTrue(await self.close())

    async def test_replaced_generation_cannot_close_new_browser(self):
        account_browser.write_private(self.directory / 'session.json', {**self.state, 'pid': 99999})
        self.assertFalse(await self.close())
        self.browser.new_browser_cdp_session.assert_not_awaited()

    async def test_probe_failure_never_closes_or_propagates(self):
        self.session.send.side_effect = RuntimeError('temporary CDP failure')
        self.assertFalse(await self.close())
        self.session.send.assert_awaited_once_with('Target.getTargets')
        self.assertTrue(self.running)

    async def test_close_disconnection_is_success_when_process_exited(self):
        self.raise_on_close = True
        self.assertTrue(await self.close())

    async def test_failed_upload_login_check_also_releases_its_idle_browser(self):
        error = bridge.history_sessions.HistorySessionError('login expired', 'login_required')
        with patch.object(bridge, 'connect_account_browser', AsyncMock(return_value=(self.browser, 'endpoint', 'digest'))), \
             patch.object(bridge.history_sessions, 'check_background_login', AsyncMock(side_effect=error)), \
             patch.object(account_browser, 'close_idle_account_browser', AsyncMock(return_value=True)) as close:
            with self.assertRaisesRegex(RuntimeError, 'login expired'):
                await bridge.connect_upload_browser(None, {}, {'target': 'tencent-video', 'accountName': 'history_tencent'})
            close.assert_awaited_once_with(self.browser)


class PersistentLoginTest(unittest.IsolatedAsyncioTestCase):
    async def test_idle_restart_preserves_refreshed_cookies_instead_of_reimporting_old_snapshot(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config = {'root': str(root / 'sau'), 'stateRoot': str(root / 'state')}
            file = account_browser.history_storage_file(config, 'tencent')
            file.parent.mkdir(parents=True)
            account_browser.write_private(file, {'cookies': [{'name': 'login', 'value': 'old-import'}], 'origins': []})
            executable = root / 'chrome'
            executable.touch()
            context = SimpleNamespace(pages=[], cookies=AsyncMock(return_value=[{'name': 'login', 'value': 'refreshed-profile'}]),
                                      add_cookies=AsyncMock(), add_init_script=AsyncMock())
            browser = SimpleNamespace(contexts=[context])
            playwright = SimpleNamespace(chromium=SimpleNamespace(connect_over_cdp=AsyncMock(return_value=browser)))
            launches = []
            running = set()

            def launch(args, **kwargs):
                profile = Path(next(arg.split('=', 1)[1] for arg in args if arg.startswith('--user-data-dir=')))
                (profile / 'DevToolsActivePort').write_text('19999\n/devtools/browser/ABC-123\n')
                pid = 100 + len(launches)
                launches.append(pid)
                running.add(pid)
                return SimpleNamespace(pid=pid)

            with patch.dict('sys.modules', {'conf': SimpleNamespace(LOCAL_CHROME_PATH=str(executable))}), \
                 patch.object(account_browser.subprocess, 'Popen', side_effect=launch), \
                 patch.object(account_browser, 'alive', side_effect=lambda pid: pid in running), \
                 patch.object(account_browser, 'endpoint_matches', return_value=True):
                first = await account_browser.connect_account_browser(playwright, config, 'history_tencent')
                running.clear()  # The browser was idle and exited; the profile remains.
                second = await account_browser.connect_account_browser(playwright, config, 'history_tencent')
            self.assertEqual(first[2], second[2])
            self.assertEqual(len(launches), 2)
            context.add_cookies.assert_awaited_once()
            context.cookies.assert_awaited_once()
            self.assertEqual(sum(c.kwargs.get("script") != account_browser.SILENT_MEDIA_SCRIPT for c in context.add_init_script.await_args_list), 2)


if __name__ == '__main__':
    unittest.main()
