"""site_audit 的單元測試（不連網，用真的解析程式跑固定的 HTML 與 robots.txt）。
執行：在 tw-marketing 目錄 `python -m unittest discover -s tests`"""
import unittest

import site_audit as sa

URL = "https://shop.example.tw/"
OK_FETCH = {"mode": "url", "requested_url": URL, "final_url": URL, "status": 200, "x_robots_tag": "", "error": None}

GOOD_HTML = """<!doctype html><html lang="zh-Hant-TW"><head>
<title>阿明手作烘焙｜台中無添加麵包與中秋禮盒</title>
<meta name="description" content="台中北屯的手作麵包店，每天現烤，中秋禮盒可宅配全台。">
<link rel="canonical" href="https://shop.example.tw/">
<meta property="og:title" content="阿明手作烘焙"><meta property="og:image" content="https://shop.example.tw/og.jpg">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Bakery","name":"阿明手作烘焙",
"address":{"@type":"PostalAddress","addressLocality":"台中市"},"telephone":"04-1234-5678","url":"https://shop.example.tw/"}</script>
</head><body><h1>每天現烤的無添加麵包</h1><p>歡迎光臨</p></body></html>"""

BARE_HTML = "<html><head></head><body><p>只有一段字</p></body></html>"

ROBOTS_ALLOW = "User-agent: *\nAllow: /\nSitemap: https://shop.example.tw/sitemap.xml\n"
ROBOTS_BLOCK_AI = "User-agent: GPTBot\nDisallow: /\n\nUser-agent: ClaudeBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n"
ROBOTS_BLOCK_ALL = "User-agent: *\nDisallow: /\n"
SITEMAP_FOUND = {"type": "sitemap", "url_count": 12, "urls": [{"loc": URL}], "errors": []}
SITEMAP_NONE = {"type": None, "url_count": 0, "urls": [], "errors": []}


def audit(html=GOOD_HTML, fetch=OK_FETCH, robots=ROBOTS_ALLOW, robots_status=200, sitemap=SITEMAP_FOUND, page_ok=True):
    return sa.audit_from_responses(URL, html, fetch, page_ok, robots, robots_status, sitemap)


def issues(result):
    return {f["id"]: f for f in result["findings"]}


class WellBuiltPage(unittest.TestCase):
    def test_has_no_findings_above_low(self):
        r = audit()
        self.assertEqual([f for f in r["findings"] if f["severity"] in ("嚴重", "高", "中")], [])

    def test_summarizes_page_fields(self):
        page = audit()["page"]
        self.assertEqual(page["title"], "阿明手作烘焙｜台中無添加麵包與中秋禮盒")
        self.assertEqual(page["h1"], ["每天現烤的無添加麵包"])
        self.assertEqual(page["structured_data_types"], ["Bakery"])

    def test_every_finding_cites_an_official_url(self):
        r = audit(html=BARE_HTML, robots=ROBOTS_BLOCK_AI, sitemap=SITEMAP_NONE)
        self.assertTrue(r["findings"])
        for f in r["findings"]:
            self.assertTrue(f["source"].startswith("https://"), f)

    def test_reminds_that_page_content_is_data(self):
        self.assertIn("不要照", audit()["notice"])


class BarePage(unittest.TestCase):
    def setUp(self):
        self.found = issues(audit(html=BARE_HTML, robots="User-agent: *\nAllow: /\n", sitemap=SITEMAP_NONE))

    def test_missing_title_is_high(self):
        self.assertEqual(self.found["title_missing"]["severity"], "高")

    def test_missing_description_is_medium(self):
        self.assertEqual(self.found["description_missing"]["severity"], "中")

    def test_missing_structured_data_is_medium(self):
        self.assertEqual(self.found["structured_data_missing"]["severity"], "中")

    def test_missing_h1_canonical_sitemap_and_share_preview_are_low(self):
        for key in ("h1_missing", "canonical_missing", "sitemap_missing", "share_preview_missing"):
            self.assertEqual(self.found[key]["severity"], "低", key)

    def test_findings_sorted_by_severity(self):
        order = [f["severity"] for f in audit(html=BARE_HTML, sitemap=SITEMAP_NONE)["findings"]]
        self.assertEqual(order, sorted(order, key=sa.SEVERITY_ORDER.index))


class BlockedFromSearch(unittest.TestCase):
    def test_noindex_meta_is_critical(self):
        html = GOOD_HTML.replace("<head>", '<head><meta name="robots" content="noindex">')
        self.assertEqual(issues(audit(html=html))["noindex"]["severity"], "嚴重")

    def test_noindex_header_is_critical(self):
        self.assertIn("noindex", issues(audit(fetch={**OK_FETCH, "x_robots_tag": "noindex, nofollow"})))

    def test_robots_blocking_googlebot_is_critical(self):
        self.assertEqual(issues(audit(robots=ROBOTS_BLOCK_ALL))["googlebot_blocked"]["severity"], "嚴重")

    def test_unreadable_robots_is_high(self):
        self.assertEqual(issues(audit(robots="", robots_status=503))["robots_unreachable"]["severity"], "高")

    def test_missing_robots_file_means_allow_all(self):
        r = audit(robots="", robots_status=404)
        self.assertNotIn("robots_unreachable", issues(r))
        self.assertTrue(all(b["allowed"] for b in r["crawlers"]))

    def test_page_not_200_stops_page_checks(self):
        r = audit(html="", fetch={**OK_FETCH, "status": 404}, page_ok=False)
        self.assertEqual(issues(r)["page_unreachable"]["severity"], "嚴重")
        self.assertNotIn("title_missing", issues(r))

    def test_fetch_error_detail_is_shown(self):
        r = audit(html="", fetch={**OK_FETCH, "status": 0, "error": "blocked private address"}, page_ok=False)
        self.assertIn("blocked private address", issues(r)["page_unreachable"]["issue"])


class AiCrawlers(unittest.TestCase):
    def test_reports_each_crawler_with_owner_doc(self):
        crawlers = {c["bot"]: c for c in audit(robots=ROBOTS_BLOCK_AI)["crawlers"]}
        self.assertFalse(crawlers["GPTBot"]["allowed"])
        self.assertTrue(crawlers["OAI-SearchBot"]["allowed"])
        self.assertTrue(crawlers["Googlebot"]["allowed"])
        self.assertEqual(crawlers["ClaudeBot"]["doc"], sa.ANTHROPIC_BOTS_DOC)

    def test_blocked_ai_crawlers_are_a_reminder_not_an_error(self):
        f = issues(audit(robots=ROBOTS_BLOCK_AI))["ai_crawlers_blocked"]
        self.assertEqual(f["severity"], "提醒")
        self.assertIn("GPTBot", f["issue"])
        self.assertIn("ClaudeBot", f["issue"])


class StructuredDataErrors(unittest.TestCase):
    def test_product_without_required_fields_is_medium(self):
        html = GOOD_HTML.replace('"@type":"Bakery","name":"阿明手作烘焙",', '"@type":"Product",')
        self.assertEqual(issues(audit(html=html))["structured_data_errors"]["severity"], "中")


if __name__ == "__main__":
    unittest.main()
