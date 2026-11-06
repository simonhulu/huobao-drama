import base64
from pathlib import Path
import tempfile
import unittest

from accounts import account_file, qr_data


class AccountPathTests(unittest.TestCase):
    def test_named_account_path_matches_sau_and_rejects_traversal(self):
        with tempfile.TemporaryDirectory() as root:
            for prefix in ('cba', 'science', 'mystery'):
                name = prefix + '_' + 'a' * 32
                self.assertEqual(account_file(root, name), Path(root).resolve() / 'cookies' / f'baijiahao_{name}.json')
            for invalid in ('../escape', '', 'cba_/a', 'cba_' + 'a' * 33):
                with self.assertRaises(ValueError):
                    account_file(root, invalid)

    def test_cookies_and_storage_symlinks_are_rejected(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as outside:
            directory = Path(root) / 'cookies'
            directory.symlink_to(outside, target_is_directory=True)
            with self.assertRaises(ValueError):
                account_file(root, 'cba_' + 'a' * 32)
            directory.unlink(); directory.mkdir()
            target = directory / ('baijiahao_cba_' + 'a' * 32 + '.json')
            target.symlink_to(Path(outside) / 'secret.json')
            with self.assertRaises(ValueError):
                account_file(root, 'cba_' + 'a' * 32)

    def test_qr_reads_only_this_accounts_png(self):
        with tempfile.TemporaryDirectory() as root:
            target = account_file(root, 'cba_' + 'a' * 32)
            image = target.with_name(target.stem + '_login_qrcode.png')
            png = b'\x89PNG\r\n\x1a\nfixture'
            image.write_bytes(png)
            result = qr_data({'image_path': str(image)}, target)
            self.assertEqual(base64.b64decode(result.split(',')[1]), png)
            with self.assertRaises(ValueError):
                qr_data({'image_path': str(target)}, target)
            image.write_text('credential-like-text')
            with self.assertRaises(ValueError):
                qr_data({'image_path': str(image)}, target)


if __name__ == '__main__':
    unittest.main()
