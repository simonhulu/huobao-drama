"""Account-scoped exclusion shared by uploads and login synchronization."""
from contextlib import contextmanager
import fcntl
import hashlib
import os
from pathlib import Path
from urllib.parse import urlparse

from account_browser import validate_account_name


class UploadLockBusy(RuntimeError):
    pass


def account_lock_key(platform, name):
    if platform not in ("baijiahao", "tencent"):
        raise ValueError("上传平台无效")
    return f"account:{platform}:{validate_account_name(name)}"


def browser_lock_key(endpoint):
    url = urlparse(endpoint)
    if (url.scheme != "http" or url.hostname != "127.0.0.1" or not url.port
            or url.path not in ("", "/") or url.username or url.password or url.query or url.fragment):
        raise ValueError("平台浏览器仅支持本机 127.0.0.1 CDP 连接")
    return f"browser:http://127.0.0.1:{url.port}"


@contextmanager
def upload_locks(config, resources):
    root = Path(config["stateRoot"]).resolve()
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory = root / "locks"
    if directory.is_symlink():
        raise ValueError("上传锁目录无效")
    directory.mkdir(exist_ok=True, mode=0o700)
    locks = []
    try:
        # Old bridge processes still hold runtime.lock exclusively. Shared
        # holders coexist once those processes finish, allowing other accounts.
        paths = [(root / "runtime.lock", fcntl.LOCK_SH,
                  "旧版上传或账号同步正在运行，等待原步骤结束后继续；本次未操作平台")]
        for resource in sorted(set(resources)):
            digest = hashlib.sha256(resource.encode()).hexdigest()
            message = ("原上传任务正在运行，稍后继续核对；本次未操作平台" if resource.startswith("job:")
                       else "该账号的另一项上传或账号同步正在运行，稍后继续；本次未操作平台")
            paths.append((directory / f"{digest}.lock", fcntl.LOCK_EX, message))
        for file, mode, message in paths:
            fd = os.open(file, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            lock = os.fdopen(fd, "a")
            locks.append(lock)
            os.fchmod(lock.fileno(), 0o600)
            try:
                fcntl.flock(lock, mode | fcntl.LOCK_NB)
            except BlockingIOError:
                raise UploadLockBusy(message) from None
        yield
    finally:
        for lock in reversed(locks):
            lock.close()
