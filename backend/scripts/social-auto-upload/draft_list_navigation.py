"""Read-only Channels draft pagination. The caller owns and closes the probe page.

Only list navigation buttons are clicked. No editor, save, or publish action is
performed. Matchers use bridge's id/title/timestamp/time record contract.
"""
import asyncio
import re
import time
import unicodedata
from urllib.parse import urlsplit


MAX_PAGES = 50
TOTAL_TIMEOUT = 120
PAGE_TIMEOUT = 12


class DraftListNavigationError(RuntimeError):
    def __init__(self, message, diagnostic):
        self.diagnostic = dict(diagnostic)
        pages = diagnostic['pagesScanned']
        scope = ','.join(map(str, pages)) or '无'
        super().__init__(f"{message}；已扫描页 [{scope}]，共 {diagnostic['rowsScanned']} 条，"
                         f"结果 {diagnostic['outcome']}（最多 {MAX_PAGES} 页/{TOTAL_TIMEOUT} 秒）；不会重新保存")


_READ_ROW = r"""e => {
  const p = e.__vue__?.$props?.post || e.__vue__?.post;
  const title = e.querySelector('.post-title');
  const description = typeof p?.desc?.description === 'string'
    ? p.desc.description : (title?.getAttribute('title') || title?.textContent || '').trim();
  const timestamp = p?.createTime;
  return {
    id: p?.objectId || e.getAttribute('data-object-id') || e.getAttribute('data-id') || null,
    title: description, description,
    shortTitle: p?.desc?.shortTitle?.[0]?.shortTitle || '',
    ...(typeof timestamp === 'number' && Number.isFinite(timestamp)
      ? {timestamp, createTime: timestamp} : {}),
    time: (e.querySelector('.post-time')?.textContent ||
      e.textContent.match(/\d{4}年\d{1,2}月\d{1,2}日 \d{2}:\d{2}(?::\d{2})?/)?.[0] || '').trim()
  };
}"""

_SNAPSHOT = r"""body => {
  const readRow = READ_ROW;
  const all = [];
  function walk(root) {
    for (const e of root.querySelectorAll('*')) {
      all.push(e);
      if (e.shadowRoot) walk(e.shadowRoot);
    }
  }
  walk(body);
  const visible = e => !!e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
  const find = selector => all.filter(e => e.matches(selector) && visible(e));
  const wrappers = find('.draft-list-wrapper');
  const wrapper = wrappers[0];
  const parent = wrapper?.closest('.post-list') || find('.post-list')[0];
  const vm = parent?.__vue__;
  const store = wrapper?.__vue__?.draftStore;
  const elements = find('.post-draft-item').filter(e => !wrapper || wrapper.contains(e));
  const rows = elements.map(readRow);
  const integer = value => Number.isInteger(value) && value >= 0 ? value : null;
  const total = integer(store?.total);
  const size = integer(store?.pageSize) || 20;
  const current = (wrapper || parent)?.querySelector('.weui-desktop-pagination__num_current');
  const number = integer(store?.curPage) || Number(current?.textContent.trim()) || 1;
  const version = integer(store?.updateListVersion);
  const loading = vm?.isPageReady === false || vm?.listLoading === true ||
    find('[aria-busy="true"], .loading, .list-loading, .loading-icon, .weui-desktop-loading')
      .some(e => !parent || parent.contains(e));
  const explicitEmpty = find('.post-list-body, .empty, .empty-state, .no-data')
    .some(e => /^(?:暂无草稿|没有草稿)[。！!\s]*$/.test(e.textContent.trim()));
  // A store's initial total=0 is NOT proof of an empty response.
  const empty = !rows.length && explicitEmpty;
  const countReady = total === null || rows.length === Math.min(size, Math.max(0, total - (number-1)*size));
  const modelReady = !store || (Array.isArray(store.list) && store.list.length === rows.length &&
    rows.every((r, i) => r.id === store.list[i]?.objectId));
  const buttons = find('.draft-list-wrapper .weui-desktop-pagination__nav > a');
  const enabled = e => !e.matches('[disabled], [aria-disabled="true"], .disabled, .weui-desktop-btn_disabled');
  return {rows, number, total, size, version, wrapped: !!wrapper,
    next: buttons.some(e => e.textContent.trim() === '下一页' && enabled(e)),
    prev: buttons.some(e => e.textContent.trim() === '上一页' && enabled(e)),
    ready: wrappers.length <= 1 && !loading && countReady && modelReady && (!!rows.length || empty),
    empty, loading};
}""".replace('READ_ROW', _READ_ROW)


def _text_candidate(actual, expected):
    def normalize(value):
        return re.sub(r'\s+', ' ', re.sub(r'[\u200b-\u200f\ufeff]', '',
                      unicodedata.normalize('NFC', str(value or '')))).strip()
    actual, expected = normalize(actual), normalize(expected)
    prefix = re.sub(r'(?:…+|\.{3})$', '', actual).rstrip()
    return actual == expected or (prefix != actual and len(prefix) >= 6 and expected.startswith(prefix))


def _fingerprint(snapshot):
    return tuple((r.get('id'), r['title'], r.get('timestamp'), r['time']) for r in snapshot['rows'])


async def locate_tencent_draft(page, *, open_list, match, description, attempted_at, expected_id=None):
    """Return (candidate, current-row Locator, diagnostic), or a diagnostic error.

    A known ID permits an early exact hit. Without it, every page must be read
    before accepting a unique text/time candidate. Unknown readiness, incomplete
    coverage, and limits are always ``incomplete``, never ``not_found``.
    """
    started = time.monotonic()
    diagnostic = {'outcome': 'incomplete', 'pagesScanned': [], 'rowsScanned': 0,
                  'matchingDescriptionCount': 0, 'candidateTimes': [],
                  'totalCount': None, 'complete': False}
    records = []
    network = {'pending': set(), 'serial': 0, 'success': None, 'error': None}
    requests, response_tasks = {}, set()

    def is_list_request(request):
        return urlsplit(request.url).path.endswith('/post/get_draft_list')

    def on_request(request):
        if is_list_request(request):
            network['serial'] += 1
            requests[request] = network['serial']
            network['pending'].add(request)
            network.update(success=None, error=None)

    def on_failed(request):
        if request in requests:
            network['pending'].discard(request)
            if requests[request] == network['serial']:
                network['error'] = '视频号草稿列表请求失败（网络连接失败）'

    async def receive(response):
        request = response.request
        try:
            if not 200 <= response.status < 300:
                raise ValueError(f'HTTP {response.status}')
            body = await response.json()
            data = body.get('data') or {}
            if body.get('errCode') != 0:
                code = body.get('errCode')
                raise ValueError(f'错误码 {code}' if type(code) is int else '接口返回失败')
            if not isinstance(data.get('list'), list) or type(data.get('totalCount')) is not int:
                raise ValueError('响应结构不完整')
            paging = request.post_data_json or {}
            success = {'number': paging.get('currentPage'), 'total': data['totalCount'],
                       'count': len(data['list']), 'serial': requests[request]}
            if requests[request] == network['serial']:
                network['success'] = success
        except Exception as error:
            if requests[request] == network['serial']:
                reason = str(error) if type(error) is ValueError else '无法读取列表响应'
                network['error'] = f'视频号草稿列表请求失败（{reason}）'
        finally:
            network['pending'].discard(request)

    def on_response(response):
        if response.request in requests:
            task = asyncio.create_task(receive(response))
            response_tasks.add(task)
            task.add_done_callback(response_tasks.discard)

    def fail(outcome, message):
        diagnostic.update(outcome=outcome, elapsedSeconds=round(time.monotonic() - started, 2))
        raise DraftListNavigationError(message, diagnostic)

    def refresh_diagnostic():
        descriptions = [r for r in records if _text_candidate(r['title'], description)]
        diagnostic.update(matchingDescriptionCount=len(descriptions),
                          candidateTimes=[r.get('timestamp', r['time']) for r in descriptions])

    async def snapshot():
        # Wujie mounts a second body inside its shadow root.
        return await page.locator('body').first.evaluate(_SNAPSHOT)

    async def ready(previous=None, wanted=None):
        deadline = time.monotonic() + PAGE_TIMEOUT
        stable = None
        while time.monotonic() < deadline:
            if network['error']:
                fail('incomplete', network['error'])
            state = await snapshot()
            response = network['success']
            response_ready = response is not None and response['number'] == state['number']
            state['responseVersion'] = response['serial'] if response_ready else 0
            if response_ready:
                if state['total'] is None:
                    state['total'] = response['total']
                if response['total'] == 0 and response['count'] == 0 and not state['rows']:
                    state['ready'] = not state['loading']
                    state['empty'] = True
                state['ready'] = state['ready'] and state['total'] == response['total'] and len(state['rows']) == response['count']
            changed = previous is None or _fingerprint(state) != _fingerprint(previous) or (
                state['version'] is not None and previous['version'] is not None and
                state['version'] > previous['version']) or (
                previous is not None and state['responseVersion'] > previous.get('responseVersion', 0))
            key = (state['number'], state['total'], state['version'], _fingerprint(state))
            if state['ready'] and not network['pending'] and changed and (wanted is None or state['number'] == wanted):
                if stable == key:
                    return state
                stable = key
            else:
                stable = None
            await asyncio.sleep(0.1)
        fail('incomplete', '草稿列表仍在加载或翻页结果未确认')

    async def turn(state, direction):
        label = '下一页' if direction == 1 else '上一页'
        available = state['next'] if direction == 1 else state['prev']
        if not available:
            fail('incomplete', f'第 {state["number"]} 页缺少可用的{label}入口')
        button = page.locator('.draft-list-wrapper:visible .weui-desktop-pagination__nav > a:visible').filter(
            has_text=re.compile(r'^\s*' + label + r'\s*$'))
        if await button.count() != 1:
            fail('incomplete', '草稿分页入口不唯一')
        await button.click(timeout=5000)
        return await ready(state, state['number'] + direction)

    async def bind(record, state):
        while state['number'] != record['_page']:
            state = await turn(state, 1 if state['number'] < record['_page'] else -1)
        # Re-read after all matching/navigation: a saved index may now refer to
        # another draft. Also verify the Locator's actual element before return.
        for _ in range(3):
            state = await ready()
            if state['number'] != record['_page']:
                fail('incomplete', '返回候选前草稿页码发生变化')
            current = [i for i, row in enumerate(state['rows']) if (
                row.get('id') == record['id'] if record.get('id') else
                (row['title'], row.get('timestamp'), row['time']) ==
                (record['title'], record.get('timestamp'), record['time']))]
            if len(current) != 1:
                fail('incomplete', '返回候选前草稿身份消失或不唯一')
            index = current[0]
            row = state['rows'][index]
            try:
                candidate = match([row], description, attempted_at, expected_id=expected_id)
            except RuntimeError as error:
                if hasattr(error, 'issue'):
                    raise
                fail('incomplete', '返回候选前草稿内容发生变化')
            selector = '.draft-list-wrapper:visible .post-draft-item:visible' if state['wrapped'] else '.post-draft-item:visible'
            locator = page.locator(selector).nth(index)
            if await locator.evaluate(_READ_ROW, timeout=3000) != row:
                continue
            candidate = {**candidate, 'index': index}
            diagnostic.update(outcome='found', matchedPage=state['number'],
                              elapsedSeconds=round(time.monotonic() - started, 2))
            return candidate, locator, diagnostic
        fail('incomplete', '草稿列表持续变化，无法稳定定位候选卡片')

    listeners = [('request', on_request), ('requestfailed', on_failed), ('response', on_response)]
    for event, handler in listeners:
        page.on(event, handler)
    try:
        async with asyncio.timeout(TOTAL_TIMEOUT):
            await open_list(page)
            state = await ready()
            if not 1 <= state['number'] <= MAX_PAGES:
                fail('incomplete', '初始草稿页码超出扫描范围')
            while state['number'] > 1:
                state = await turn(state, -1)
            diagnostic['totalCount'] = state['total']
            while True:
                number = state['number']
                if number != len(diagnostic['pagesScanned']) + 1:
                    fail('incomplete', '草稿分页不连续')
                if state['total'] != diagnostic['totalCount']:
                    fail('incomplete', '扫描期间草稿总数发生变化')
                diagnostic['pagesScanned'].append(number)
                diagnostic['rowsScanned'] += len(state['rows'])
                records.extend({**row, '_page': number} for row in state['rows'])
                refresh_diagnostic()
                if expected_id is not None:
                    hits = [r for r in records if r.get('id') == expected_id]
                    if hits:
                        return await bind(hits[0], state)
                more = state['next'] or (state['total'] is not None and number * state['size'] < state['total'])
                if not more:
                    # Repeated IDs across pages can hide a skipped row when the
                    # queue inserts/deletes while scanning. Never call that empty.
                    identities = {r['id'] for r in records if r.get('id')}
                    covered = len(identities) + sum(not r.get('id') for r in records)
                    if state['total'] is not None and covered != state['total']:
                        fail('incomplete', '分页记录未覆盖草稿总数')
                    diagnostic['complete'] = True
                    break
                if number >= MAX_PAGES:
                    fail('incomplete', '达到草稿扫描页数上限')
                state = await turn(state, 1)

            eligible = []
            seen = set()
            for i, row in enumerate(records):
                try:
                    match([row], description, attempted_at, expected_id=expected_id)
                except RuntimeError as error:
                    if hasattr(error, 'issue'):
                        raise
                    continue
                identity = row.get('id') or ('row', i)
                if identity not in seen:
                    eligible.append(row)
                    seen.add(identity)
            if len(eligible) > 1:
                fail('ambiguous', '完整扫描发现多个匹配草稿')
            if not eligible:
                if diagnostic['matchingDescriptionCount']:
                    fail('unmatched', '找到相同文案，但时间或草稿 ID 不匹配')
                fail('not_found', '完整扫描没有找到本任务文案')
            # Let the injected matcher validate uniqueness across the full scan.
            match(records, description, attempted_at, expected_id=expected_id)
            return await bind(eligible[0], state)
    except DraftListNavigationError:
        raise
    except TimeoutError:
        fail('incomplete', '草稿查询达到总时间预算或页面操作超时')
    except Exception as error:
        if hasattr(error, 'issue'):
            raise
        # Do not leak URLs, credentials, or raw browser/network errors to state.
        fail('incomplete', f'草稿查询未完成（{type(error).__name__}）')
    finally:
        for event, handler in listeners:
            page.remove_listener(event, handler)
        for task in response_tasks:
            task.cancel()
        if response_tasks:
            await asyncio.gather(*response_tasks, return_exceptions=True)
