"""tw_calendar 的單元測試（不連網）。執行：在 tw-marketing 目錄 `python -m unittest discover -s tests`"""
import datetime as dt
import unittest

import tw_calendar as cal

D = dt.date

# 取自人事總處 116 年辦公日曆表的真實列（加上一天虛構的補班，驗證通則）
CSV_116 = """﻿西元日期,星期,是否放假,備註
20270101,五,2,開國紀念日
20270102,六,2,
20270103,日,2,
20270104,一,0,
20270204,四,2,小年夜
20270205,五,2,農曆除夕
20270206,六,2,春節
20270207,日,2,春節
20270208,一,2,春節
20270209,二,2,補假
20270210,三,2,補假
20270211,四,0,
20270213,六,0,補行上班
20270508,六,2,
20270509,日,2,
"""

DATASET = {
    "result": {
        "distribution": [
            {"resourceDescription": "114年中華民國政府行政機關辦公日曆表", "resourceDownloadUrl": "https://dgpa/114-old.csv"},
            {"resourceDescription": "114年中華民國政府行政機關辦公日曆表_Google行事曆專用", "resourceDownloadUrl": "https://dgpa/114-google.csv"},
            {"resourceDescription": "114年中華民國政府行政機關辦公日曆表(1141020更新)", "resourceDownloadUrl": "https://dgpa/114-new.csv"},
            {"resourceDescription": "116年中華民國政府行政機關辦公日曆表", "resourceDownloadUrl": "https://dgpa/116.csv"},
        ]
    }
}


class ParseOfficeCalendar(unittest.TestCase):
    def test_reads_date_off_flag_and_note(self):
        days = cal.parse_office_calendar(CSV_116)
        self.assertEqual(days[D(2027, 1, 1)], {"off": True, "note": "開國紀念日"})
        self.assertEqual(days[D(2027, 1, 4)], {"off": False, "note": ""})

    def test_accepts_big5_bytes(self):
        days = cal.parse_office_calendar("西元日期,星期,是否放假,備註\n20270101,五,2,開國紀念日\n".encode("cp950"))
        self.assertEqual(days[D(2027, 1, 1)]["note"], "開國紀念日")


class PickCalendarUrl(unittest.TestCase):
    def test_prefers_latest_update_and_skips_google_version(self):
        self.assertEqual(cal.pick_calendar_url(DATASET, 2025), "https://dgpa/114-new.csv")

    def test_finds_year_by_roc_year(self):
        self.assertEqual(cal.pick_calendar_url(DATASET, 2027), "https://dgpa/116.csv")

    def test_returns_none_when_not_published(self):
        self.assertIsNone(cal.pick_calendar_url(DATASET, 2030))


class BuildCalendar(unittest.TestCase):
    def setUp(self):
        self.days = cal.parse_office_calendar(CSV_116)
        self.result = cal.build_calendar(D(2027, 1, 1), D(2027, 12, 31), {2027: self.days})

    def test_lists_named_holidays_but_not_plain_weekends(self):
        names = [(h["date"], h["name"]) for h in self.result["holidays"]]
        self.assertIn(("2027-01-01", "開國紀念日"), names)
        self.assertIn(("2027-02-09", "補假"), names)
        self.assertNotIn("2027-01-02", [h["date"] for h in self.result["holidays"]])

    def test_weekend_marked_as_workday_is_makeup_workday(self):
        self.assertEqual(self.result["makeup_workdays"], [{"date": "2027-02-13", "weekday": "六", "note": "補行上班"}])

    def test_long_weekends_are_runs_of_three_or_more_days_off(self):
        self.assertEqual(self.result["long_weekends"][:2], [
            {"start": "2027-01-01", "end": "2027-01-03", "days": 3, "includes": ["開國紀念日"]},
            {"start": "2027-02-04", "end": "2027-02-10", "days": 7, "includes": ["小年夜", "農曆除夕", "春節", "補假"]},
        ])

    def test_lantern_festival_is_fourteen_days_after_first_day_of_spring_festival(self):
        self.assertIn({"date": "2027-02-20", "name": "元宵節", "source": cal.SOURCE_DERIVED},
                      self.result["shopping_events"])

    def test_mothers_day_is_second_sunday_of_may(self):
        self.assertIn({"date": "2027-05-09", "name": "母親節", "source": cal.SOURCE_RULE}, self.result["shopping_events"])

    def test_qixi_and_ghost_festival_come_from_cwa_table(self):
        events = {e["name"]: e for e in self.result["shopping_events"]}
        self.assertEqual(events["七夕情人節"]["date"], "2027-08-08")
        self.assertEqual(events["中元節"]["date"], "2027-08-16")
        self.assertEqual(events["七夕情人節"]["source"], cal.SOURCE_CWA)

    def test_fixed_date_shopping_events(self):
        dates = {e["name"]: e["date"] for e in self.result["shopping_events"]}
        self.assertEqual(dates["618 購物節"], "2027-06-18")
        self.assertEqual(dates["父親節"], "2027-08-08")
        self.assertEqual(dates["雙 11"], "2027-11-11")
        self.assertEqual(dates["雙 12"], "2027-12-12")

    def test_events_are_limited_to_requested_range(self):
        r = cal.build_calendar(D(2027, 2, 1), D(2027, 2, 28), {2027: self.days})
        self.assertEqual({e["name"] for e in r["shopping_events"]}, {"西洋情人節", "元宵節"})
        self.assertTrue(all("2027-02" in h["date"] for h in r["holidays"]))

    def test_years_without_office_calendar_are_reported(self):
        r = cal.build_calendar(D(2027, 12, 1), D(2028, 1, 31), {2027: self.days})
        self.assertEqual(r["missing_years"], [2028])

    def test_qixi_outside_table_is_reported_not_guessed(self):
        r = cal.build_calendar(D(2035, 8, 1), D(2035, 8, 31), {2035: {}})
        self.assertNotIn("七夕情人節", {e["name"] for e in r["shopping_events"]})
        self.assertTrue(any("2035" in n and "七夕" in n for n in r["notes"]))


class CalendarFor(unittest.TestCase):
    def test_rejects_bad_date_format(self):
        with self.assertRaisesRegex(ValueError, "YYYY-MM-DD"):
            cal.calendar_for("2027/01/01", "2027-12-31", fetch=lambda y: {})

    def test_rejects_end_before_start(self):
        with self.assertRaisesRegex(ValueError, "結束日"):
            cal.calendar_for("2027-12-31", "2027-01-01", fetch=lambda y: {})

    def test_rejects_ranges_longer_than_two_years(self):
        with self.assertRaisesRegex(ValueError, "兩年"):
            cal.calendar_for("2026-01-01", "2028-06-30", fetch=lambda y: {})

    def test_fetches_each_year_once_plus_neighbours_for_long_weekends(self):
        asked = []
        cal.calendar_for("2026-11-01", "2027-02-28", fetch=lambda y: asked.append(y) or {})
        self.assertEqual(asked, [2025, 2026, 2027, 2028])

    def test_source_outage_is_unavailable_not_unpublished(self):
        def down(year):
            raise OSError("timed out")
        r = cal.calendar_for("2027-01-01", "2027-03-31", fetch=down)
        self.assertEqual(r["unavailable_years"], [2027])
        self.assertEqual(r["missing_years"], [])
        self.assertTrue(any("暫時取不到" in n for n in r["notes"]))

    def test_long_weekend_crossing_new_year_is_complete(self):
        years = {
            2027: {D(2027, 12, 30): {"off": False, "note": ""}, D(2027, 12, 31): {"off": True, "note": "補假"}},
            2028: {D(2028, 1, 1): {"off": True, "note": "開國紀念日"}, D(2028, 1, 2): {"off": True, "note": ""},
                   D(2028, 1, 3): {"off": False, "note": ""}},
        }
        r = cal.calendar_for("2027-12-01", "2027-12-31", fetch=lambda y: years.get(y, {}))
        self.assertEqual(r["long_weekends"], [
            {"start": "2027-12-31", "end": "2028-01-02", "days": 3, "includes": ["補假", "開國紀念日"]}])

    def test_unpublished_next_year_at_the_edge_is_noted(self):
        years = {2027: {D(2027, 12, 31): {"off": True, "note": "補假"}}}
        r = cal.calendar_for("2027-12-01", "2027-12-31", fetch=lambda y: years.get(y))
        self.assertEqual(r["missing_years"], [])
        self.assertTrue(any("2028" in n and "連假" in n for n in r["notes"]))


if __name__ == "__main__":
    unittest.main()
