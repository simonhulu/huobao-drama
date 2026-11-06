"""Keep new Baijiahao video caches private to a job and browser tab.

Baijiahao's video editor stores an array under an ``edit-<hash>-videoV2``
localStorage key.  That key is shared by every new video editor opened in a
persistent account profile, so a later task can otherwise restore the previous
task's video and copy.  New editors use a tab-local, job-scoped shadow value;
the account's shared cache is never changed.
"""

import json


_INIT_SCRIPT = r"""
(jobId => {
    const isNewVideo = () => {
        const url = new URL(location.href);
        return url.origin === 'https://baijiahao.baidu.com'
            && url.pathname === '/builder/rc/edit'
            && url.searchParams.get('type') === 'videoV2'
            && !url.searchParams.has('article_id');
    };
    if (!isNewVideo()) return;

    const shared = window.localStorage;
    const session = window.sessionStorage;
    const {getItem, setItem, removeItem} = Storage.prototype;
    const prefix = '__huobao_video_storage__:' + JSON.stringify(jobId) + ':';
    const isolatedKey = (storage, key) =>
        storage === shared && isNewVideo() && /^edit-[a-f0-9]+-videoV2$/.test(key)
            ? prefix + key : null;

    Storage.prototype.getItem = function(key) {
        if (!arguments.length) return getItem.apply(this, arguments);
        const target = isolatedKey(this, key);
        if (target === null) return getItem.apply(this, arguments);

        const cached = getItem.call(session, target);
        if (cached !== null) return cached;

        // A fresh video editor must never import the previous shared video.
        // "[]" is the editor's valid empty-cache representation and also acts
        // as a tombstone when the page removes its draft cache.
        setItem.call(session, target, '[]');
        return '[]';
    };

    Storage.prototype.setItem = function(key, value) {
        if (arguments.length < 2) return setItem.apply(this, arguments);
        const target = isolatedKey(this, key);
        if (target === null) return setItem.apply(this, arguments);
        return setItem.call(session, target, String(value));
    };

    Storage.prototype.removeItem = function(key) {
        if (!arguments.length) return removeItem.apply(this, arguments);
        const target = isolatedKey(this, key);
        if (target === null) return removeItem.apply(this, arguments);
        // Keep an empty tombstone so a later read cannot re-import the shared
        // account cache after the editor removes its own value.
        return setItem.call(session, target, '[]');
    };
})(__JOB_ID__);
"""


async def install_video_storage_isolation(page, job_id: str) -> None:
    """Install the video cache hook before a new editor document loads.

    The hook only intercepts exact new-video editor URLs and exact video cache
    keys. Existing video drafts, article editors, credentials, and unrelated
    storage keys continue to use the browser's native storage APIs.
    """

    await page.add_init_script(script=_INIT_SCRIPT.replace('__JOB_ID__', json.dumps(str(job_id))))
