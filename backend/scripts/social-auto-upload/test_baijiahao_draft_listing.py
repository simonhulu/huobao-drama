"""Offline Chromium fixtures for the observed Baijiahao list DOM/API."""
import json
import unittest
from urllib.parse import parse_qs, urlparse
from unittest.mock import patch

from playwright.async_api import async_playwright
import bridge
import baijiahao_draft_listing as listing


TITLE = "关家垴之战：彭德怀坚持进攻，刘伯承为何主张暂缓"
FIRST_ID = "1880027026933416669"
SECOND_ID = "1880033273757903971"


class BaijiahaoFreshRecordTest(unittest.TestCase):
    def test_api_creation_time_is_used_when_display_time_is_omitted_or_rounded(self):
        attempted = bridge.datetime(2026, 10, 25, 21, 21, tzinfo=bridge.ZoneInfo('Asia/Shanghai')).timestamp()
        for displayed in ('刚刚', '2026-10-25 21:21', '2026-10-25 21:20:00'):
            row = {'title': TITLE, 'time': displayed, 'record': {'created_at': '2026-10-25 21:21:01'}}
            with self.subTest(displayed=displayed):
                self.assertTrue(listing._fresh_row(row, TITLE, attempted))
        row['record']['created_at'] = '2026-10-24 21:21:01'
        row['time'] = '2026-10-25 21:22:01'
        self.assertFalse(listing._fresh_row(row, TITLE, attempted))


def record(identifier=FIRST_ID, title=TITLE, time="2026-10-25 21:21:01", kind="news", status="draft"):
    return {"id": identifier, "title": title, "time": time, "type": kind, "status": status}


HTML = r"""<!doctype html><meta charset="utf-8">
<button role="tab" aria-selected="false" onclick="collection='draft';load(1)">草稿</button>
<input placeholder="输入标题关键字" onkeydown="if(event.key==='Enter'){search=this.value;load(1)}">
<button onclick="writes++">保存草稿</button><button onclick="writes++">发布</button>
<div id="loading"></div><main></main><div id="pagination"></div>
<script>
let writes=0;
const params=new URLSearchParams(location.search);
let collection=params.get('collection')||'', search=params.get('search')||'';
document.querySelector('input').value=search;
function render(data){
 document.querySelector('#loading').innerHTML='';
 const main=document.querySelector('main');main.replaceChildren();
 for(const row of data.domRows){
  const card=document.createElement('div');card.className='client_pages_content_v2_components_articleItem';
  card.innerHTML='<div class="title"><a></a></div><span class="time"></span>'+
    '<div class="client_pages_content_v2_components_articleTags"><span>草稿</span></div>'+
    '<span class="icon '+row.type+'"></span><button class="article-action-btn">修改</button>';
  card.querySelector('a').href='https://baijiahao.baidu.com/builder/preview/s?id='+row.id;
  card.querySelector('a').textContent=row.title;card.querySelector('.time').textContent=row.time;
  card.querySelector('[class*="articleTags"] span').textContent=row.status==='draft'?'草稿':'已发布';
  card.querySelector('button').onclick=()=>writes++;main.appendChild(card);
 }
 if(!data.domRows.length)main.innerHTML='<div class="cheetah-empty"><div class="cheetah-empty-description">暂无数据</div></div>';
 const pager=document.querySelector('#pagination');pager.replaceChildren();
 if(data.domRows.length){
  const p=data.data.page, list=document.createElement('ul');list.className='cheetah-pagination';
  for(let i=1;i<=p.totalPage;i++){
   const li=document.createElement('li');li.className='cheetah-pagination-item cheetah-pagination-item-'+i+
    (i===p.currentPage?' cheetah-pagination-item-active':'');li.textContent=i;li.onclick=()=>load(i);list.appendChild(li);
  }
  const next=document.createElement('li');next.className='cheetah-pagination-next';
  next.setAttribute('aria-disabled',String(p.currentPage===p.totalPage));
  next.innerHTML='<button '+(p.currentPage===p.totalPage?'disabled':'')+'>下一页</button>';
  next.onclick=()=>{if(p.currentPage<p.totalPage)load(p.currentPage+1)};list.appendChild(next);pager.appendChild(list);
 }
}
async function load(number){
 document.querySelector('[role=tab]').setAttribute('aria-selected',String(collection==='draft'));
 // Search deliberately keeps old same-title cards visible even after the
 // response, so a text-only wait or spinner-only wait gives a false match.
 if(!search)document.querySelector('#loading').innerHTML='<div class="cheetah-spin-spinning" aria-busy="true">加载</div>';
 const q=new URLSearchParams({currentPage:number,pageSize:10,search,type:'',collection,clearBeforeFetch:'false'});
 history.replaceState({},'',location.pathname+'?'+q);
 try{
  const response=await fetch('/pcui/article/lists?'+q), data=await response.json();
  if(response.ok&&data.errno===0)setTimeout(()=>render(data),data.renderDelay||0);
 }catch{}
}
load(Number(params.get('currentPage')||1));
</script>"""


class BaijiahaoDraftListingTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.pw = await async_playwright().start()
        self.addAsyncCleanup(self.pw.stop)
        self.browser = await self.pw.chromium.launch(channel="chrome", headless=True)
        self.addAsyncCleanup(self.browser.close)
        self.context = await self.browser.new_context()
        self.page = await self.context.new_page()
        self.pages = [[record()]]
        self.initial = None
        self.delay = 0
        self.failure = None
        self.numeric_ids = False
        self.api_extra = {}
        self.grow_on_page_two = False
        self.fail_page_two = False
        self.fail_search = False
        self.requests = []
        self.attempted_at = bridge.datetime(2026, 10, 25, 21, 21, tzinfo=bridge.ZoneInfo("Asia/Shanghai")).timestamp()
        await self.context.route("**/*", self.route)

    async def route(self, route):
        request = route.request
        path = urlparse(request.url).path
        if request.resource_type == "document":
            return await route.fulfill(content_type="text/html; charset=utf-8", body=HTML)
        if path != "/pcui/article/lists":
            return await route.abort()
        self.assertEqual(request.method, "GET")
        q = parse_qs(urlparse(request.url).query, keep_blank_values=True)
        number, search, collection = int(q["currentPage"][0]), q["search"][0], q["collection"][0]
        self.requests.append((collection, search, number))
        if search and self.fail_search:
            return await route.abort('failed')
        if number == 2 and self.fail_page_two:
            return await route.abort("failed")
        if collection == "draft" and self.failure:
            if self.failure == "abort":
                return await route.abort("failed")
            return await route.fulfill(status=503 if self.failure == "http" else 200,
                content_type="application/json", body=json.dumps({"errno": 9, "data": {}}))
        pages = self.pages
        if (not collection or not search) and self.initial is not None:
            pages = [self.initial]
        rows = pages[number - 1] if number <= len(pages) else []
        count = sum(map(len, pages))
        if self.grow_on_page_two and number == 2:
            count += 1
        api_rows = [{"article_id": int(r["id"]) if self.numeric_ids else r["id"],
                     "title": r["title"], "status": r["status"], "type": r["type"],
                     **r.get("api", {}), **self.api_extra} for r in rows]
        await route.fulfill(content_type="application/json", body=json.dumps({"errno": 0,
            "data": {"list": api_rows, "page": {"currentPage": number, "pageSize": 10,
                "totalCount": count, "totalPage": (len(pages) + int(self.grow_on_page_two and number == 2)) if count else 0}},
            "domRows": rows, "renderDelay": self.delay if search else 0}))

    async def locate(self, **kwargs):
        result = await listing.locate_baijiahao_draft(self.page, title=kwargs.pop("title", TITLE),
            attempted_at=self.attempted_at, target=kwargs.pop("target", "baijiahao-article"),
            match=bridge.matching_saved_draft, **kwargs)
        self.assertEqual(await self.page.evaluate("writes"), 0)
        return result

    async def test_second_page_and_numeric_api_ids_keep_exact_dom_identity(self):
        self.pages = [[record(SECOND_ID, title="其他草稿")], [record()]]
        self.numeric_ids = True
        candidate, card, diagnostic = await self.locate()
        self.assertEqual(candidate["id"], FIRST_ID)
        self.assertEqual(await card.locator(".title a").get_attribute("href"),
                         "https://baijiahao.baidu.com/builder/preview/s?id=" + FIRST_ID)
        self.assertEqual((diagnostic["pagesScanned"], diagnostic["rowsScanned"]), (2, 2))

    async def test_delayed_search_does_not_accept_old_same_title_row(self):
        self.initial = [record(SECOND_ID)]
        self.pages = [[record()]]
        self.delay = 250
        candidate, _, _ = await self.locate()
        self.assertEqual(candidate["id"], FIRST_ID)

    async def test_candidate_keeps_exact_api_video_record_without_private_or_unrelated_fields(self):
        self.pages = [[record(kind='video')]]
        self.numeric_ids = True
        self.api_extra = {'created_at': '2026-10-25 21:21:01', 'rmb_duration': 471,
                          'file_name': 'saved-resource', 'app_id': 'test-account',
                          'unrelated': 'must not persist', 'cover_images': 'signed image URLs'}
        candidate, _, _ = await self.locate(target='baijiahao-video')
        self.assertEqual(candidate['record'], {
            'article_id': FIRST_ID, 'title': TITLE, 'status': 'draft', 'type': 'video',
            'created_at': '2026-10-25 21:21:01', 'rmb_duration': 471,
            'file_name': 'saved-resource', 'app_id': 'test-account'})

    async def test_publication_scan_passes_legacy_ugc_preview_ids_without_accepting_them(self):
        legacy = {**record('5035164490468139865', kind='ugc_video', status='publish'),
                  'api': {'article_id': 7410892993064487395, 'nid': 5035164490468139865}}
        self.pages = [[legacy], [record(kind='video', status='publish')]]
        with patch.object(listing, 'STEP_TIMEOUT', 1500):
            candidate, _, diagnostic = await listing.locate_baijiahao_draft(
                self.page, title=TITLE, attempted_at=self.attempted_at, target='baijiahao-video',
                match=bridge.matching_publication, collection='')
        self.assertEqual(candidate['id'], FIRST_ID)
        self.assertEqual(candidate['record']['article_id'], FIRST_ID)
        self.assertEqual(candidate['record']['type'], 'video')
        self.assertEqual(diagnostic['pagesScanned'], 2)
        self.assertEqual(await self.page.evaluate('writes'), 0)

    async def test_legacy_ugc_display_id_keeps_its_distinct_server_article_id(self):
        self.pages = [[{**record('5035164490468139865', kind='ugc_video', status='publish'),
                       'api': {'article_id': 7410892993064487395, 'nid': 5035164490468139865}}]]
        with patch.object(listing, 'STEP_TIMEOUT', 1500):
            snapshot, _, _ = await listing._load(self.page,
                lambda: self.page.goto(listing.CONTENT_URL), search='', number=1, collection='')
        self.assertEqual(snapshot['rows'][0]['id'], '5035164490468139865')
        self.assertEqual(snapshot['records']['5035164490468139865']['article_id'], '7410892993064487395')
        self.assertEqual(snapshot['records']['5035164490468139865']['type'], 'ugc_video')

    async def test_fresh_publication_on_current_list_does_not_depend_on_search_index(self):
        self.pages = [[record(kind='video', status='publish')]]
        self.fail_search = True
        with patch.object(listing, 'STEP_TIMEOUT', 1500):
            candidate, _, diagnostic = await listing.locate_baijiahao_draft(
                self.page, title=TITLE, attempted_at=self.attempted_at, target='baijiahao-video',
                match=bridge.matching_publication, collection='')
        self.assertEqual(candidate['id'], FIRST_ID)
        self.assertEqual(diagnostic['pagesScanned'], 1)
        self.assertEqual(self.requests, [('', '', 1)])
        self.assertEqual(await self.page.evaluate('writes'), 0)

    async def test_real_empty_is_not_found(self):
        self.pages = [[]]
        with self.assertRaises(listing.BaijiahaoDraftListingError) as caught:
            await self.locate()
        self.assertEqual(caught.exception.diagnostic,
                         {"outcome": "not_found", "pagesScanned": 1, "rowsScanned": 0})
        self.assertIn("已完成", str(caught.exception))

    async def test_multiple_matching_ids_on_current_page_are_ambiguous(self):
        self.pages = [[record(), record(SECOND_ID)]]
        with self.assertRaises(listing.BaijiahaoDraftListingError) as caught:
            await self.locate()
        self.assertEqual(caught.exception.diagnostic["outcome"], "ambiguous")
        self.assertEqual(caught.exception.diagnostic["rowsScanned"], 2)

    async def test_expected_id_skips_title_search_after_title_changed(self):
        self.pages = [[record(SECOND_ID)], [record(title="已经改名", time="2026-10-26 08:00")]]
        candidate, _, _ = await self.locate(expected_id=FIRST_ID)
        self.assertEqual(candidate["id"], FIRST_ID)
        self.assertTrue(all(search == "" for _, search, _ in self.requests))

    async def test_first_page_candidate_returns_without_revisiting_or_loading_broken_next_page(self):
        self.pages = [[record()], [record(SECOND_ID, title="其他草稿")]]
        self.fail_page_two = True
        _, card, diagnostic = await self.locate()
        self.assertEqual(await card.locator('.title a').inner_text(), TITLE)
        self.assertEqual(self.requests[-1], ("draft", TITLE[:30], 1))
        self.assertEqual(diagnostic["pagesScanned"], 1)
        self.assertTrue(all(number == 1 for _, _, number in self.requests))

    async def test_duplicate_dom_cards_cannot_return_an_ambiguous_locator(self):
        self.pages = [[record(), record()]]
        with self.assertRaises(listing.BaijiahaoDraftListingError) as caught:
            await self.locate()
        self.assertEqual(caught.exception.diagnostic["rowsScanned"], 1)
        self.assertEqual(caught.exception.diagnostic["outcome"], "incomplete")

    async def test_changed_total_count_and_pages_do_not_block_current_page_candidate(self):
        self.pages = [[record(SECOND_ID, title="其他草稿")], [record()]]
        self.grow_on_page_two = True
        for expected_id in (None, FIRST_ID):
            with self.subTest(expected_id=expected_id):
                candidate, _, diagnostic = await self.locate(expected_id=expected_id)
                self.assertEqual(candidate["id"], FIRST_ID)
                self.assertEqual(diagnostic["pagesScanned"], 2)
                self.assertEqual(diagnostic["rowsScanned"], 2)

    async def test_known_id_on_first_page_ignores_broken_later_pages(self):
        self.pages = [[record(title="已改名", time="2026-10-24 21:21:01")], [record(SECOND_ID)]]
        self.fail_page_two = True
        candidate, _, diagnostic = await self.locate(expected_id=FIRST_ID)
        self.assertEqual(candidate["id"], FIRST_ID)
        self.assertEqual(diagnostic["pagesScanned"], 1)
        self.assertTrue(all(number == 1 and not search for _, search, number in self.requests))

    async def test_video_candidate_on_first_page_ignores_article_and_broken_later_page(self):
        self.pages = [[record(), record(SECOND_ID, kind="video")], [record("123", kind="video")]]
        self.fail_page_two = True
        candidate, _, diagnostic = await self.locate(target="baijiahao-video")
        self.assertEqual(candidate["id"], SECOND_ID)
        self.assertEqual(diagnostic["pagesScanned"], 1)
        self.assertTrue(all(number == 1 for _, _, number in self.requests))

    async def test_same_title_before_save_is_ignored_in_favor_of_fresh_record(self):
        self.attempted_at += 0.6
        self.pages = [[record(SECOND_ID, time="2026-10-25 21:20:59"), record()]]
        candidate, _, diagnostic = await self.locate()
        self.assertEqual(candidate["id"], FIRST_ID)
        self.assertEqual(diagnostic["pagesScanned"], 1)

    async def test_same_title_requires_full_date_and_time_at_or_after_attempt(self):
        self.attempted_at += 0.6
        for time in ("2026-10-25 21:20:59",
                     "2026-10-24 21:21:01", "2026-10-25 21:21", "21:21:01",
                     "2026-10-25 21:23:01"):
            with self.subTest(time=time):
                self.pages = [[record(time=time)]]
                with self.assertRaises(listing.BaijiahaoDraftListingError) as caught:
                    await self.locate()
                self.assertEqual(caught.exception.diagnostic["outcome"], "unmatched")

    async def test_same_save_second_is_not_rejected_due_to_display_precision(self):
        self.attempted_at += 0.6
        self.pages = [[record(time="2026-10-25 21:21:00")]]
        candidate, _, diagnostic = await self.locate()
        self.assertEqual(candidate["id"], FIRST_ID)
        self.assertEqual(diagnostic["outcome"], "matched")

    async def test_exact_title_draft_status_and_content_type_are_required(self):
        for invalid in (record(title=TITLE[:15] + "…"), record(title=TITLE + "续篇"),
                        record(kind="video"), record(status="published")):
            with self.subTest(record=invalid):
                self.pages = [[invalid]]
                with self.assertRaises(listing.BaijiahaoDraftListingError) as caught:
                    await self.locate()
                self.assertEqual(caught.exception.diagnostic["outcome"], "unmatched")

    async def test_full_title_is_matched_when_search_is_shortened(self):
        full = "历史长标题" * 9
        self.pages = [[record(title=full)]]
        candidate, _, _ = await self.locate(title=full)
        self.assertEqual(candidate["id"], FIRST_ID)
        self.assertIn(("draft", full[:30], 1), self.requests)

    async def test_same_title_outside_save_window_is_unmatched(self):
        self.pages = [[record(time="2026-10-24 21:21:01")]]
        with self.assertRaises(listing.BaijiahaoDraftListingError) as caught:
            await self.locate()
        self.assertEqual(caught.exception.diagnostic["outcome"], "unmatched")

    async def test_network_failure_never_becomes_not_found(self):
        for failure in ("abort", "http", "errno"):
            with self.subTest(failure=failure):
                self.failure = failure
                with self.assertRaises(listing.BaijiahaoDraftListingError) as caught:
                    await self.locate()
                self.assertEqual(caught.exception.diagnostic["outcome"], "incomplete")
                self.assertIn("查询失败", str(caught.exception))

    async def test_page_limit_fails_when_no_matching_record_has_been_seen(self):
        self.pages = [[record(SECOND_ID, title="其他草稿")], [record()]]
        with patch.object(listing, "MAX_PAGES", 1), self.assertRaises(listing.BaijiahaoDraftListingError) as caught:
            await self.locate()
        self.assertEqual(caught.exception.diagnostic["outcome"], "incomplete")
        self.assertEqual(caught.exception.diagnostic["pagesScanned"], 1)

    async def test_dom_never_finishes_is_incomplete(self):
        self.initial = [record(SECOND_ID)]
        self.delay = 10000
        # Let Playwright finish its own DOM wait before closing the browser;
        # cancelling an in-flight protocol wait leaves a noisy pending future.
        with patch.object(listing, "STEP_TIMEOUT", 500), self.assertRaises(listing.BaijiahaoDraftListingError) as caught:
            await self.locate()
        self.assertEqual(caught.exception.diagnostic["outcome"], "incomplete")
        self.assertNotIn("https://", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
