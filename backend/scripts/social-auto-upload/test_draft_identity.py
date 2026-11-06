"""Draft identity survives presentation changes without accepting another post."""
import unittest
import bridge


class DraftIdentityTest(unittest.TestCase):
    def setUp(self):
        self.attempt = bridge.datetime(2026, 10, 25, 21, 21, tzinfo=bridge.ZoneInfo('Asia/Shanghai')).timestamp()
        self.bai = {'title': '张学良带走菜单的故事', 'draft': True, 'video': True,
                    'time': '2026-10-25 21:21:01',
                    'url': 'https://baijiahao.baidu.com/builder/preview/s?id=123456'}

    def test_known_baijiahao_id_survives_truncated_title_and_later_update_time(self):
        row = {**self.bai, 'title': '张学良带走…', 'time': '2026-10-26 08:00'}
        self.assertEqual(bridge.matching_saved_draft([row], self.bai['title'], self.attempt,
                         expected_id='123456')['id'], '123456')
        with self.assertRaises(RuntimeError):
            bridge.matching_saved_draft([row], self.bai['title'], self.attempt, expected_id='654321')

    def test_known_id_never_accepts_published_or_wrong_content_type(self):
        for change in ({'draft': False}, {'video': False}):
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                bridge.matching_saved_draft([{**self.bai, **change}], self.bai['title'], self.attempt,
                                           expected_id='123456')

    def test_visible_truncation_is_only_a_candidate_and_keeps_unique_time_requirement(self):
        row = {**self.bai, 'title': '张学良带走菜单…'}
        self.assertEqual(bridge.matching_saved_draft([row], self.bai['title'], self.attempt)['id'], '123456')
        with self.assertRaises(RuntimeError):
            bridge.matching_saved_draft([{**row, 'time': '2026-10-24 21:21:01'}], self.bai['title'], self.attempt)
        with self.assertRaises(RuntimeError):
            bridge.matching_saved_draft([row, {**row, 'url': row['url'].replace('123456', '654321')}], self.bai['title'], self.attempt)

    def test_baijiahao_deduplicates_the_same_id_but_not_two_different_drafts(self):
        result = bridge.matching_saved_draft([self.bai, self.bai], self.bai['title'], self.attempt)
        self.assertEqual(result['id'], '123456')

    def test_known_tencent_id_is_used_instead_of_list_text_and_time(self):
        row = {'id': 'export/ours', 'title': '截断文案…', 'time': '今天 22:30'}
        result = bridge.matching_tencent_draft([{'id': 'export/other', **{k:v for k,v in row.items() if k!='id'}}, row],
                                             '完整原项目文案', self.attempt, expected_id='export/ours')
        self.assertEqual(result['index'], 1)
        with self.assertRaises(RuntimeError):
            bridge.matching_tencent_draft([row], '完整原项目文案', self.attempt, expected_id='export/missing')

    def test_formatting_and_platform_timestamps_do_not_hide_unique_candidates(self):
        row = {**self.bai, 'title': '\u200b张学良\u00a0 带走菜单的故事\n', 'time': '2026-10-25 21:21'}
        self.assertEqual(bridge.matching_saved_draft([row], '张学良 带走菜单的故事', self.attempt)['id'], '123456')
        result = bridge.matching_tencent_draft([{'title': '原项目简介', 'time': '2026-10-25 21:21:03'}], '原项目简介', self.attempt)
        self.assertEqual(result['index'], 0)


if __name__ == '__main__':
    unittest.main()
