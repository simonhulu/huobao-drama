"""Read-only draft lookup against an isolated, real headless browser."""
import asyncio
import json
import unittest
from unittest.mock import patch

from playwright.async_api import async_playwright

import bridge
import draft_list_navigation as navigation


ATTEMPT = 1792938525
DESCRIPTION = "原项目完整简介需要跨页准确查找"


def post(identifier, description="其他项目简介", timestamp=ATTEMPT):
    return {"objectId": identifier, "createTime": timestamp,
            "desc": {"description": description, "shortTitle": [{"shortTitle": "项目短标题"}]}}


FIXTURE = r"""cfg => {
  window.actions = {edit: 0, save: 0, publish: 0, pages: []};
  const shadow = document.querySelector('main').attachShadow({mode: 'open'});
  const root = document.createElement('body'); // Real Wujie also exposes two bodies.
  shadow.append(root);
  root.innerHTML = `<div class="post-list"><div class="loading">加载中</div>
    <div class="draft-list-wrapper"><div class="post-list-body"></div>
    <div class="post-list-footer"></div></div></div>
    <button onclick="actions.save++">保存草稿</button>
    <button onclick="actions.publish++">发表</button>`;
  const parent = root.querySelector('.post-list');
  const wrapper = root.querySelector('.draft-list-wrapper');
  const body = root.querySelector('.post-list-body');
  const footer = root.querySelector('.post-list-footer');
  const loading = root.querySelector('.loading');
  const store = {list: [], total: 0, curPage: 1, pageSize: 20, updateListVersion: 0};
  parent.__vue__ = {isPageReady: false, listLoading: true, totalNum: 0};
  if (!cfg.domOnly) wrapper.__vue__ = {draftStore: store};
  const visits = {};
  function show(n) {
    actions.pages.push(n);
    store.curPage = n; // Page number changes before the asynchronous rows arrive.
    parent.__vue__.listLoading = true;
    loading.style.display = '';
    setTimeout(() => {
      if (cfg.stuck) return;
      visits[n] = (visits[n] || 0) + 1;
      let rows = cfg.records.slice((n - 1) * 20, n * 20);
      if (cfg.reorderOnReturn && visits[n] > 1) rows = [...rows].reverse();
      store.list = rows;
      store.total = cfg.records.length;
      store.updateListVersion++;
      body.replaceChildren();
      for (const p of rows) {
        const row = document.createElement('div');
        row.className = 'post-draft-item';
        row.innerHTML = `<div class="post-title"></div><div class="post-time"></div>
          <button class="opr-item" onclick="actions.edit++">编辑</button>`;
        row.querySelector('.post-title').textContent = p.desc.description;
        row.querySelector('.post-time').textContent = '2026年10月25日 22:28';
        if (!cfg.domOnly) row.__vue__ = {$props: {post: p, type: 'page', collectionName: ''}};
        body.append(row);
      }
      footer.replaceChildren();
      if (cfg.records.length > 20) {
        footer.innerHTML = `<div class="weui-desktop-pagination">
          <span class="weui-desktop-pagination__nav">
          <label class="weui-desktop-pagination__num_current">${n}</label></span></div>`;
        const nav = footer.querySelector('span');
        for (const [text, target] of [['上一页', n-1], ['下一页', n+1]]) {
          if (target < 1 || target > Math.ceil(cfg.records.length / 20)) continue;
          const a = document.createElement('a');
          a.href = 'javascript:;'; a.textContent = text;
          a.onclick = () => show(target); nav.append(a);
        }
      }
      if (!rows.length && cfg.domOnly) body.textContent = '暂无草稿';
      parent.__vue__.isPageReady = true;
      parent.__vue__.listLoading = false;
      loading.style.display = 'none';
    }, cfg.delay || 0);
  }
  show(1);
}"""


class TencentDraftLookupTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.pw = await async_playwright().start()
        self.addAsyncCleanup(self.pw.stop)
        self.browser = await self.pw.chromium.launch(channel="chrome", headless=True)
        self.addAsyncCleanup(self.browser.close)
        self.page = await self.browser.new_page()
        # No fixture test can reach a production page.
        await self.page.route("**/*", lambda route: route.abort())

    def opener(self, records, **options):
        async def open_list(page):
            await page.set_content('<main></main>')
            await page.evaluate(FIXTURE, {"records": records, **options})
            return page.locator('.post-draft-item')
        return open_list

    async def locate(self, records, *, expected_id=None, **options):
        return await navigation.locate_tencent_draft(
            self.page, open_list=self.opener(records, **options),
            match=bridge.matching_tencent_draft, description=DESCRIPTION,
            attempted_at=ATTEMPT, expected_id=expected_id)

    async def assert_read_only(self):
        actions = await self.page.evaluate('window.actions')
        self.assertEqual([actions[k] for k in ('edit', 'save', 'publish')], [0, 0, 0])
        self.assertFalse(self.page.is_closed())

    async def test_session_issue_is_preserved_without_closing_the_probe_page(self):
        for issue in ('login_required', 'verification_required'):
            error = bridge.history_sessions.HistorySessionError('请完成账号验证', issue)

            async def open_list(page):
                raise error

            with self.subTest(issue=issue), self.assertRaises(type(error)) as caught:
                await navigation.locate_tencent_draft(
                    self.page, open_list=open_list, match=bridge.matching_tencent_draft,
                    description=DESCRIPTION, attempted_at=ATTEMPT)
            self.assertIs(caught.exception, error)
            self.assertEqual(caught.exception.issue, issue)
            self.assertFalse(self.page.is_closed())

    async def test_known_id_on_second_page_uses_vue_identity_and_seconds(self):
        records = [post(f'export/other-{i}') for i in range(20)]
        records.append(post('export/ours', '列表文字已变化', ATTEMPT - 86400))
        candidate, row, diagnostic = await self.locate(records, expected_id='export/ours')
        self.assertEqual(candidate['id'], 'export/ours')
        self.assertEqual(candidate['index'], 0)
        self.assertEqual(await row.evaluate('e => e.__vue__.$props.post.objectId'), 'export/ours')
        self.assertEqual(diagnostic['pagesScanned'], [1, 2])
        self.assertEqual(await self.page.locator('body').count(), 2)
        await self.assert_read_only()

    async def test_same_description_on_two_pages_is_ambiguous(self):
        records = [post('export/one', DESCRIPTION)] + [post(f'export/other-{i}') for i in range(19)]
        records.append(post('export/two', DESCRIPTION))
        with self.assertRaises(navigation.DraftListNavigationError) as caught:
            await self.locate(records)
        d = caught.exception.diagnostic
        self.assertEqual(d['outcome'], 'ambiguous')
        self.assertEqual(d['pagesScanned'], [1, 2])
        self.assertEqual(d['matchingDescriptionCount'], 2)
        self.assertEqual(d['candidateTimes'], [ATTEMPT, ATTEMPT])
        self.assertTrue(d['complete'])
        await self.assert_read_only()

    async def test_missing_target_requires_complete_scan(self):
        with self.assertRaises(navigation.DraftListNavigationError) as caught:
            await self.locate([post(f'export/other-{i}') for i in range(21)])
        d = caught.exception.diagnostic
        self.assertEqual(d['outcome'], 'not_found')
        self.assertEqual(d['pagesScanned'], [1, 2])
        self.assertEqual(d['matchingDescriptionCount'], 0)
        self.assertEqual(d['candidateTimes'], [])
        self.assertTrue(d['complete'])
        await self.assert_read_only()

    async def test_same_description_with_wrong_time_or_id_is_unmatched(self):
        for options, timestamp in [({}, ATTEMPT - 86400), ({'expected_id': 'export/missing'}, ATTEMPT)]:
            with self.subTest(options=options), self.assertRaises(navigation.DraftListNavigationError) as caught:
                await self.locate([post('export/other', DESCRIPTION, timestamp)], **options)
            self.assertEqual(caught.exception.diagnostic['outcome'], 'unmatched')
            self.assertEqual(caught.exception.diagnostic['matchingDescriptionCount'], 1)

    async def test_async_zero_rows_and_stale_rows_during_pagination_are_not_absence(self):
        records = [post(f'export/other-{i}') for i in range(20)] + [post('export/ours', DESCRIPTION)]
        candidate, row, diagnostic = await self.locate(records, delay=300)
        self.assertEqual(candidate['id'], 'export/ours')
        self.assertEqual(await row.locator('.post-title').inner_text(), DESCRIPTION)
        self.assertTrue(diagnostic['complete'])
        self.assertEqual(diagnostic['pagesScanned'], [1, 2])
        await self.assert_read_only()

    async def test_revisiting_candidate_rebinds_id_after_row_order_changes(self):
        records = [post('export/ours', DESCRIPTION)] + [post(f'export/other-{i}') for i in range(20)]
        candidate, row, diagnostic = await self.locate(records, reorderOnReturn=True)
        self.assertEqual(candidate['index'], 19)
        self.assertEqual(await row.evaluate('e => e.__vue__.$props.post.objectId'), 'export/ours')
        self.assertEqual(await self.page.evaluate('actions.pages'), [1, 2, 1])
        self.assertTrue(diagnostic['complete'])
        await self.assert_read_only()

    async def test_dom_only_fixture_accepts_unique_truncated_text_after_full_scan(self):
        records = [post('ignored', DESCRIPTION[:9] + '…')] + [post(f'other-{i}') for i in range(20)]
        candidate, row, diagnostic = await self.locate(records, domOnly=True)
        self.assertNotIn('id', candidate)
        self.assertEqual(await row.locator('.post-title').inner_text(), DESCRIPTION[:9] + '…')
        self.assertEqual(diagnostic['pagesScanned'], [1, 2])
        self.assertTrue(diagnostic['complete'])

    async def test_loading_and_page_limit_report_incomplete(self):
        with patch.object(navigation, 'PAGE_TIMEOUT', 0.4):
            with self.assertRaises(navigation.DraftListNavigationError) as caught:
                await self.locate([], stuck=True)
        self.assertEqual(caught.exception.diagnostic['outcome'], 'incomplete')
        self.assertFalse(caught.exception.diagnostic['complete'])
        self.assertEqual(caught.exception.diagnostic['pagesScanned'], [])
        with patch.object(navigation, 'MAX_PAGES', 1):
            with self.assertRaises(navigation.DraftListNavigationError) as caught:
                await self.locate([post(f'other-{i}') for i in range(21)])
        self.assertEqual(caught.exception.diagnostic['outcome'], 'incomplete')
        self.assertEqual(caught.exception.diagnostic['pagesScanned'], [1])
        self.assertIn('已扫描页 [1]', str(caught.exception))

    async def test_uninitialized_zero_store_requires_successful_response(self):
        with patch.object(navigation, 'PAGE_TIMEOUT', 0.4):
            with self.assertRaises(navigation.DraftListNavigationError) as caught:
                await self.locate([])
        self.assertEqual(caught.exception.diagnostic['outcome'], 'incomplete')

    async def test_network_success_empty_and_request_failure_have_distinct_outcomes(self):
        endpoint = 'https://draft-fixture.test/micro/content/cgi-bin/mmfinderassistant-bin/post/get_draft_list'
        for status, body, outcome in [
            (201, {'errCode': 0, 'data': {'list': [], 'totalCount': 0}}, 'not_found'),
            (503, {}, 'incomplete'),
            (201, {'errCode': 17}, 'incomplete'),
        ]:
            with self.subTest(status=status, body=body):
                async def respond(route):
                    await asyncio.sleep(0.2)
                    await route.fulfill(status=status, content_type='application/json',
                                        headers={'Access-Control-Allow-Origin': '*'}, body=json.dumps(body))
                await self.page.route(endpoint, respond)

                async def open_list(page):
                    await self.opener([])(page)
                    await page.evaluate('url => { void fetch(url, {method: "POST", body: JSON.stringify({currentPage: 1, pageSize: 20})}).catch(() => {}); }', endpoint)
                    return page.locator('.post-draft-item')

                with self.assertRaises(navigation.DraftListNavigationError) as caught:
                    await navigation.locate_tencent_draft(
                        self.page, open_list=open_list, match=bridge.matching_tencent_draft,
                        description=DESCRIPTION, attempted_at=ATTEMPT)
                self.assertEqual(caught.exception.diagnostic['outcome'], outcome)
                if outcome == 'incomplete':
                    self.assertIn('请求失败', str(caught.exception))
                else:
                    self.assertTrue(caught.exception.diagnostic['complete'])
                await self.page.unroute(endpoint, respond)
        await self.assert_read_only()


if __name__ == '__main__':
    unittest.main()
