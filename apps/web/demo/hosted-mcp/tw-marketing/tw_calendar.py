"""台灣行銷檔期：國定假日與連假（人事總處辦公日曆表）＋商業檔期與農曆檔期。"""
import csv
import datetime as dt
import io
import json
import re
import time
import urllib.request
from pathlib import Path

DATASET_API = "https://data.gov.tw/api/v2/rest/dataset/14718"
SOURCE_DGPA = "行政院人事行政總處《政府行政機關辦公日曆表》（政府資料開放平臺資料集 14718）"
SOURCE_RULE = "固定日期或規則"
SOURCE_DERIVED = "依人事總處辦公日曆表的春節初一推算（農曆正月十五）"
SOURCE_CWA = "中央氣象署《日曆資料表》（https://www.cwa.gov.tw/Data/astronomy/<西元年>cal.pdf）"
NOTE_ANNIVERSARY = "百貨公司週年慶多在 10–11 月，各家日期不同，請查各百貨官網公告。"

# 七夕（農曆七月初七）。每年從氣象署日曆資料表補一筆；中元＝七夕＋8 天（同一個農曆月）
QIXI = {int(k): dt.date.fromisoformat(v) for k, v in
        json.loads((Path(__file__).parent / "data" / "qixi.json").read_text("utf-8"))["dates"].items()}

WEEKDAYS = "一二三四五六日"
USER_AGENT = "AgentHub-tw-marketing/1.0"
CACHE_SECONDS = 24 * 3600
_cache: dict[int, tuple[float, dict | None]] = {}


def parse_office_calendar(data: str | bytes) -> dict[dt.date, dict]:
    if isinstance(data, bytes):
        try:
            data = data.decode("utf-8-sig")
        except UnicodeDecodeError:
            data = data.decode("cp950")
    rows = csv.reader(io.StringIO(data.lstrip("﻿")))
    next(rows)
    days = {}
    for r in rows:
        if len(r) < 3 or not r[0].strip().isdigit():
            continue
        d = dt.datetime.strptime(r[0].strip(), "%Y%m%d").date()
        days[d] = {"off": r[2].strip() == "2", "note": (r[3] if len(r) > 3 else "").strip()}
    return days


def pick_calendar_url(dataset: dict, year: int) -> str | None:
    """找出該年度辦公日曆表的下載網址；同年有更新版時取最新的，略過 Google 行事曆專用版。"""
    prefix = f"{year - 1911}年中華民國政府行政機關辦公日曆表"
    best, best_stamp = None, -1
    for item in dataset["result"]["distribution"]:
        title = item.get("resourceDescription", "")
        if not title.startswith(prefix) or "Google" in title:
            continue
        m = re.search(r"\((\d+)更新\)", title)
        stamp = int(m.group(1)) if m else 0
        if stamp > best_stamp:
            best, best_stamp = item.get("resourceDownloadUrl"), stamp
    return best


def _get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read()


def fetch_office_calendar(year: int) -> dict[dt.date, dict] | None:
    """從政府資料開放平臺找到該年度 CSV 並下載；人事總處還沒公布就回傳 None。結果快取一天。"""
    hit = _cache.get(year)
    if hit and time.time() - hit[0] < CACHE_SECONDS:
        return hit[1]
    url = pick_calendar_url(json.loads(_get(DATASET_API)), year)
    days = parse_office_calendar(_get(url)) if url else None
    _cache[year] = (time.time(), days)
    return days


def _nth_weekday(year: int, month: int, weekday: int, n: int) -> dt.date:
    first = dt.date(year, month, 1)
    return first + dt.timedelta(days=(weekday - first.weekday()) % 7 + 7 * (n - 1))


def _shopping_events(year: int, days: dict[dt.date, dict]) -> tuple[list[dict], list[str]]:
    events = [
        (dt.date(year, 2, 14), "西洋情人節", SOURCE_RULE),
        (_nth_weekday(year, 5, 6, 2), "母親節", SOURCE_RULE),
        (dt.date(year, 6, 18), "618 購物節", SOURCE_RULE),
        (dt.date(year, 8, 8), "父親節", SOURCE_RULE),
        (dt.date(year, 11, 11), "雙 11", SOURCE_RULE),
        (dt.date(year, 12, 12), "雙 12", SOURCE_RULE),
        (dt.date(year, 12, 25), "聖誕節", SOURCE_RULE),
    ]
    notes = []
    spring = sorted(d for d, v in days.items() if v["note"] == "春節")
    if spring:
        events.append((spring[0] + dt.timedelta(days=14), "元宵節", SOURCE_DERIVED))
    if year in QIXI:
        events.append((QIXI[year], "七夕情人節", SOURCE_CWA))
        events.append((QIXI[year] + dt.timedelta(days=8), "中元節", SOURCE_CWA))
    else:
        notes.append(f"{year} 年的七夕、中元尚未收錄（氣象署日曆資料表公布後才會補上），不要自行推算。")
    return [{"date": d.isoformat(), "name": n, "source": s} for d, n, s in events], notes


def _long_weekends(days: dict[dt.date, dict], start: dt.date, end: dt.date) -> list[dict]:
    runs, current = [], []
    for d in sorted(days):
        if days[d]["off"] and (not current or d - current[-1] == dt.timedelta(days=1)):
            current.append(d)
            continue
        if len(current) >= 3:
            runs.append(current)
        current = [d] if days[d]["off"] else []
    if len(current) >= 3:
        runs.append(current)
    out = []
    for run in runs:
        if run[-1] < start or run[0] > end:
            continue
        names = list(dict.fromkeys(days[d]["note"] for d in run if days[d]["note"]))
        out.append({"start": run[0].isoformat(), "end": run[-1].isoformat(), "days": len(run), "includes": names})
    return out


def calendar_for(start: str, end: str, fetch=fetch_office_calendar) -> dict:
    try:
        s, e = dt.date.fromisoformat(start), dt.date.fromisoformat(end)
    except ValueError:
        raise ValueError(f"日期格式要是 YYYY-MM-DD，收到 {start!r}、{end!r}") from None
    if e < s:
        raise ValueError("結束日不能早於開始日")
    if (e - s).days > 731:
        raise ValueError("一次最多查兩年，請分段查詢")
    office, outages = {}, []
    for y in range(s.year, e.year + 1):
        try:
            office[y] = fetch(y)
        except OSError as err:
            office[y] = None
            outages.append(f"{y} 年辦公日曆表暫時取不到（{err}），國定假日與連假請稍後再查或看人事總處網站。")
    result = build_calendar(s, e, office)
    result["notes"] += outages
    return result


def build_calendar(start: dt.date, end: dt.date, office_days: dict[int, dict | None]) -> dict:
    """office_days：{西元年: parse_office_calendar 的結果，或 None 表示人事總處還沒公布}"""
    holidays, makeup, events, notes, missing = [], [], [], [NOTE_ANNIVERSARY], []
    merged: dict[dt.date, dict] = {}
    for year in range(start.year, end.year + 1):
        days = office_days.get(year)
        if not days:
            missing.append(year)
            days = {}
        merged.update(days)
        year_events, year_notes = _shopping_events(year, days)
        events += year_events
        notes += year_notes
    for d in sorted(merged):
        if not start <= d <= end:
            continue
        v = merged[d]
        if v["off"] and v["note"]:
            holidays.append({"date": d.isoformat(), "weekday": WEEKDAYS[d.weekday()], "name": v["note"]})
        elif not v["off"] and d.weekday() >= 5:
            makeup.append({"date": d.isoformat(), "weekday": WEEKDAYS[d.weekday()], "note": v["note"]})
    in_range = [e for e in events if start.isoformat() <= e["date"] <= end.isoformat()]
    return {
        "range": {"start": start.isoformat(), "end": end.isoformat()},
        "holidays": holidays,
        "makeup_workdays": makeup,
        "long_weekends": _long_weekends(merged, start, end),
        "shopping_events": sorted(in_range, key=lambda e: e["date"]),
        "missing_years": missing,
        "notes": notes,
        "sources": {"holidays": SOURCE_DGPA, "shopping_events": [SOURCE_RULE, SOURCE_DERIVED, SOURCE_CWA]},
    }
