"""Keep new Baijiahao article caches private to a job and browser tab."""

import json


_INIT_SCRIPT = r"""
(jobId => {
    const isNewArticle = () => {
        const url = new URL(location.href);
        return url.origin === 'https://baijiahao.baidu.com'
            && url.pathname === '/builder/rc/edit'
            && url.searchParams.get('type') === 'news'
            && !url.searchParams.has('article_id');
    };
    if (!isNewArticle()) return;

    const shared = window.localStorage;
    const session = window.sessionStorage;
    const {getItem, setItem, removeItem} = Storage.prototype;
    const prefix = '__huobao_article_storage__:' + JSON.stringify(jobId) + ':';
    const isolatedKey = (storage, key) =>
        storage === shared && isNewArticle() && /^edit-[a-f0-9]+-news$/.test(key)
            ? prefix + key : null;

    Storage.prototype.getItem = function(key) {
        if (!arguments.length) return getItem.apply(this, arguments);
        const target = isolatedKey(this, key);
        if (target === null) return getItem.apply(this, arguments);

        const cached = getItem.call(session, target);
        if (cached !== null) return JSON.parse(cached);

        // Import settings once. Never allow the previous article's HTML back in.
        let value = null;
        const original = getItem.call(shared, key);
        if (original !== null) {
            try {
                const draft = JSON.parse(original);
                if (draft && typeof draft === 'object' && !Array.isArray(draft)) {
                    const content = draft.content;
                    draft.content = {
                        ...(content && typeof content === 'object' && !Array.isArray(content)
                            ? content : {}),
                        value: '',
                    };
                    value = JSON.stringify(draft);
                }
            } catch (_) {
                // Invalid legacy caches are treated as absent, without repairing them.
            }
        }
        // Encode the Storage string (or null), so deletion survives a reload too.
        setItem.call(session, target, JSON.stringify(value));
        return value;
    };

    Storage.prototype.setItem = function(key, value) {
        if (arguments.length < 2) return setItem.apply(this, arguments);
        const target = isolatedKey(this, key);
        if (target === null) return setItem.apply(this, arguments);
        return setItem.call(session, target, JSON.stringify(String(value)));
    };

    Storage.prototype.removeItem = function(key) {
        if (!arguments.length) return removeItem.apply(this, arguments);
        const target = isolatedKey(this, key);
        if (target === null) return removeItem.apply(this, arguments);
        // A tombstone prevents another read from importing the shared cache again.
        return setItem.call(session, target, 'null');
    };
})(__JOB_ID__);
"""


async def install_article_storage_isolation(page, job_id: str) -> None:
    """Install once per job page, before navigating to the new article editor.

    Runs before editor scripts on navigation/reload; it does not alter an already
    loaded document. Only getItem/setItem/removeItem on matching localStorage
    keys are redirected. Cookies, other keys and existing articles are untouched.
    """
    await page.add_init_script(script=_INIT_SCRIPT.replace('__JOB_ID__', json.dumps(str(job_id))))
