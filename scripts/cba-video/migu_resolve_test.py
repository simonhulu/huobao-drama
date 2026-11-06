import contextlib
import builtins
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import migu_resolve as resolver


LIVE = "https://www.miguvideo.com/p/live/120000594061"
DETAIL = "https://www.miguvideo.com/p/detail/968668508"
REPLAY = "https://www.miguvideo.com/p/detail/968670472"
STREAM = "https://media.example.test/replay.m3u8?token=private-test-token"
PLAYLIST = {
    "code": 200,
    "message": "操作成功",
    "data": {
        "vid": "120000594061",
        "host": "咪咕视频",
        "videoListItemVoList": [
            {"title": "全场集锦", "playUrl": DETAIL, "picSrc": "omitted"},
            {"title": "全场回放（季孟年）", "playUrl": REPLAY, "picSrc": "omitted"},
        ],
    },
}


class MiguResponseTests(unittest.TestCase):
    def test_import_logs_are_private_scoped_and_retained_for_repeated_parsing(self):
        platformdirs = ModuleType("platformdirs")
        original = Mock(return_value="unrelated-app-log-directory")
        platformdirs.user_log_dir = original
        imported = ModuleType("videodl.modules.common.kedou")
        imported.KedouVideoClient = object()
        real_import = builtins.__import__
        directories = []

        def importing(name, *args, **kwargs):
            if name != "videodl.modules.common.kedou":
                return real_import(name, *args, **kwargs)
            directory = Path(platformdirs.user_log_dir(appname="videodl", appauthor="zcjin"))
            directories.append(directory)
            self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o700)
            self.assertEqual(platformdirs.user_log_dir("other", "author"), "unrelated-app-log-directory")
            with (directory / "videodl.log").open("a") as log:
                log.write(STREAM + "\n")
            print(STREAM)
            print(STREAM, file=sys.stderr)
            return imported

        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(resolver, "_videodl_log_directory", None), patch.dict(sys.modules, {"platformdirs": platformdirs}), \
                patch("builtins.__import__", side_effect=importing), contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            self.assertIs(resolver.load_kedou_client(), imported.KedouVideoClient)
            self.assertIs(platformdirs.user_log_dir, original)
            self.assertTrue(directories[0].is_dir())
            self.assertIs(resolver.load_kedou_client(), imported.KedouVideoClient)
            self.assertEqual(directories[0], directories[1])
            self.assertEqual((directories[0] / "videodl.log").read_text(), (STREAM + "\n") * 2)
            self.assertIs(platformdirs.user_log_dir, original)
        self.assertEqual(stdout.getvalue() + stderr.getvalue(), "")
        self.assertEqual(original.call_args_list, [unittest.mock.call("other", "author")] * 2)

    def test_failed_import_restores_platformdirs_and_hides_internal_details(self):
        platformdirs = ModuleType("platformdirs")
        original = Mock()
        platformdirs.user_log_dir = original
        real_import = builtins.__import__

        def importing(name, *args, **kwargs):
            if name == "videodl.modules.common.kedou":
                raise OSError(STREAM)
            return real_import(name, *args, **kwargs)

        with patch.object(resolver, "_videodl_log_directory", None), patch.dict(sys.modules, {"platformdirs": platformdirs}), \
                patch("builtins.__import__", side_effect=importing):
            with self.assertRaises(resolver.ResolutionError) as caught:
                resolver.load_kedou_client()
            self.assertIs(platformdirs.user_log_dir, original)
            self.assertNotIn("private-test-token", str(caught.exception))

    def test_runtime_check_needs_no_urls_or_network(self):
        stdout = io.StringIO()
        with patch.object(resolver, "load_kedou_client") as load, patch.object(resolver, "resolve_with_retry") as parse, \
                contextlib.redirect_stdout(stdout):
            self.assertEqual(resolver.main(["--check-runtime"]), 0)
        load.assert_called_once_with()
        parse.assert_not_called()
        self.assertEqual(json.loads(stdout.getvalue()), {"ok": True, "runtime": "videodl", "temporaryLogs": True})

    def test_import_uses_task_tmpdir_and_cleans_logs_at_process_exit(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = Path(directory)
            temporary = fixture / "task-temp"
            temporary.mkdir()
            (fixture / "platformdirs.py").write_text(
                "def user_log_dir(*args, **kwargs):\n    raise AssertionError('user log directory must not be used')\n")
            for package in ("videodl", "videodl/modules", "videodl/modules/common"):
                target = fixture / package
                target.mkdir(exist_ok=True)
                (target / "__init__.py").write_text("")
            (fixture / "videodl/modules/common/kedou.py").write_text(
                "from pathlib import Path\nfrom platformdirs import user_log_dir\n"
                "class KedouVideoClient:\n"
                "    log_file = Path(user_log_dir(appname='videodl', appauthor='zcjin')) / 'videodl.log'\n"
                "    log_file.write_text('private-test-token')\n")
            script = (
                "import json, os, sys\n"
                f"sys.path.insert(0, {str(Path(resolver.__file__).parent)!r})\n"
                "import migu_resolve as resolver\n"
                "first = resolver.load_kedou_client()\n"
                "second = resolver.load_kedou_client()\n"
                "assert first is second and first.log_file.read_text() == 'private-test-token'\n"
                "print(json.dumps({'path': str(first.log_file.parent), 'mode': first.log_file.parent.stat().st_mode & 0o777}))\n")
            result = subprocess.run([sys.executable, "-c", script], cwd=directory, capture_output=True, text=True,
                                    env={**os.environ, "TMPDIR": str(temporary)}, check=True)
            report = json.loads(result.stdout)
            self.assertEqual(Path(report["path"]).parent.resolve(), temporary.resolve())
            self.assertEqual(report["mode"], 0o700)
            self.assertFalse(Path(report["path"]).exists())
            self.assertNotIn("private-test-token", result.stdout + result.stderr)

    def test_transient_resolution_failure_retries_once(self):
        media = resolver.select_response({}, STREAM, "集锦", DETAIL)
        with patch.object(resolver, "parse_once", side_effect=[resolver.TemporaryResolutionError("暂时失败"), media]) as parse, patch.object(resolver.time, "sleep"):
            self.assertEqual(resolver.resolve_with_retry(DETAIL), media)
        self.assertEqual(parse.call_count, 2)

    def test_retry_is_bounded_and_invalid_selection_is_not_retried(self):
        for error, expected in ((resolver.TemporaryResolutionError("超时"), 2), (resolver.ResolutionError("不属于此赛事"), 1)):
            with patch.object(resolver, "parse_once", side_effect=error) as parse, patch.object(resolver.time, "sleep"), self.assertRaises(resolver.ResolutionError):
                resolver.resolve_with_retry(LIVE, "999999999")
            self.assertEqual(parse.call_count, expected)

    def test_live_playlist_requires_explicit_choice(self):
        result = resolver.select_response(PLAYLIST, "", "", LIVE)
        self.assertEqual(result, {
            "type": "playlist", "pageUrl": LIVE,
            "entries": [
                {"title": "全场集锦", "url": DETAIL},
                {"title": "全场回放（季孟年）", "url": REPLAY},
            ],
        })

    def test_live_playlist_selects_only_requested_member(self):
        result = resolver.select_response(PLAYLIST, "", "", LIVE, "968670472")
        self.assertEqual(result, {
            "type": "detail", "pageUrl": REPLAY, "title": "全场回放（季孟年）",
        })

    def test_unrelated_content_id_is_rejected(self):
        with self.assertRaises(resolver.ResolutionError):
            resolver.select_response(PLAYLIST, "", "", LIVE, "999999999")

    def test_single_video_returns_private_media_value(self):
        result = resolver.select_response(
            {"code": 200, "data": {"videoItemVoList": [{"baseUrl": STREAM}]}},
            STREAM, "全场集锦", DETAIL,
        )
        self.assertEqual(result, {
            "type": "media", "pageUrl": DETAIL,
            "title": "全场集锦", "downloadUrl": STREAM,
        })

    def test_error_record_without_download_url_is_not_success(self):
        for raw in ({}, {"code": 200, "data": {}}, {"code": 500, "message": STREAM}):
            with self.subTest(raw=raw), self.assertRaises(resolver.ResolutionError) as ctx:
                resolver.select_response(raw, "", "", DETAIL)
            self.assertNotIn("private-test-token", str(ctx.exception))

    def test_only_public_migu_pages_are_accepted(self):
        for url in (
            "http://www.miguvideo.com/p/detail/968668508",
            "https://www.miguvideo.com.evil.test/p/detail/968668508",
            "https://user@www.miguvideo.com/p/detail/968668508",
            "https://www.miguvideo.com/p/home",
            DETAIL + "?token=secret",
            DETAIL + "#section",
            "file:///tmp/video.mp4",
        ):
            with self.subTest(url=url), self.assertRaises(resolver.ResolutionError):
                resolver.select_response({}, STREAM, "title", url)

    def test_content_id_is_only_for_live_pages(self):
        with self.assertRaises(resolver.ResolutionError):
            resolver.select_response({}, STREAM, "title", DETAIL, "968668508")

    def test_playlist_cannot_redirect_outside_migu(self):
        raw = {"code": 200, "data": {"videoListItemVoList": [
            {"title": "视频", "playUrl": "https://evil.test/p/detail/968668508"},
        ]}}
        with self.assertRaises(resolver.ResolutionError):
            resolver.select_response(raw, "", "", LIVE)

    def test_non_http_media_is_rejected(self):
        for media in ("file:///tmp/video.mp4", "javascript:alert(1)", "https://user:secret@media.test/video.mp4"):
            with self.subTest(media=media), self.assertRaises(resolver.ResolutionError):
                resolver.select_response({}, media, "title", DETAIL)

    def test_cli_writes_media_privately_without_exposing_query(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "stream.url"
            output.write_text("old")
            output.chmod(0o644)
            stdout, stderr = io.StringIO(), io.StringIO()
            media = resolver.select_response({}, STREAM, "集锦", DETAIL)
            with patch.object(resolver, "parse_once", return_value=media), contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                code = resolver.main(["--url", DETAIL, "--output", str(output)])
            self.assertEqual(code, 0)
            self.assertEqual(output.read_text().strip(), STREAM)
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
            self.assertNotIn("private-test-token", stdout.getvalue() + stderr.getvalue())
            self.assertEqual(json.loads(stdout.getvalue()), {
                "type": "media", "pageUrl": DETAIL, "title": "集锦", "urlFile": str(output),
            })

    def test_cli_playlist_does_not_write_or_select_first_entry(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "stream.url"
            result = resolver.select_response(PLAYLIST, "", "", LIVE)
            with patch.object(resolver, "parse_once", return_value=result) as parse, contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(resolver.main(["--url", LIVE, "--output", str(output)]), 0)
            parse.assert_called_once_with(LIVE, None)
            self.assertFalse(output.exists())

    def test_selected_playlist_title_survives_generic_detail_title(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "stream.url"
            selection = resolver.select_response(PLAYLIST, "", "", LIVE, "968668508")
            media = resolver.select_response({}, STREAM, "KedouVideoClient_2026", DETAIL)
            stdout = io.StringIO()
            with patch.object(resolver, "parse_once", side_effect=[selection, media]), contextlib.redirect_stdout(stdout):
                code = resolver.main(["--url", LIVE, "--content-id", "968668508", "--output", str(output)])
            self.assertEqual(code, 0)
            result = json.loads(stdout.getvalue())
            self.assertEqual(result["selectedTitle"], "全场集锦")
            self.assertEqual(result["title"], "KedouVideoClient_2026")

    def test_parse_once_recovers_playlist_from_parser_error_record(self):
        info = SimpleNamespace(raw_data=PLAYLIST, download_url="", title="", err_msg="KeyError: videoItemVoList")

        def parse(*args, **kwargs):
            print(STREAM)
            print(STREAM, file=sys.stderr)
            return [info]

        client = SimpleNamespace(parsefromurl=Mock(side_effect=parse))
        constructor = Mock(return_value=client)
        modules = {name: ModuleType(name) for name in (
            "videodl", "videodl.modules", "videodl.modules.common", "videodl.modules.common.kedou",
        )}
        modules["platformdirs"] = ModuleType("platformdirs")
        modules["platformdirs"].user_log_dir = Mock()
        modules["videodl.modules.common.kedou"].KedouVideoClient = constructor
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.dict(sys.modules, modules), contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            result = resolver.parse_once(LIVE, "968668508")
        self.assertEqual(result, {"type": "detail", "pageUrl": DETAIL, "title": "全场集锦"})
        constructor.assert_called_once_with(max_retries=1, disable_print=True)
        client.parsefromurl.assert_called_once_with(LIVE, request_overrides={"timeout": 35})
        self.assertEqual(stdout.getvalue() + stderr.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
