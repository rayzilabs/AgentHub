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
_cache: dict[int | str, tuple[float, dict | None]] = {}


def parse_office_calendar(data: str | bytes) -> dict[dt.date, dict]:
    if isinstance(data, bytes):
        try:
            data = data.decode("utf-8-sig")
        except UnicodeDecodeError:
            data = data.decode("cp950")
    days = {}
    for r in csv.reader(io.StringIO(data)):
        if len(r) < 3 or not r[0].strip().isdigit():  # 也會跳過標題列
            continue
        d = dt.datetime.strptime(r[0].strip(), "%Y%m%d").date()
        days[d] = {"off": r[2].strip() == "2", "note": (r[3] if len(r) > 3 else "").strip()}
    return days


def pick_calendar_url(dataset: dict, year: int) -> str | None:
    """找出該年度辦公日曆表的下載網址；同年有更新版時取最新的，略過 Google 行事曆專用版。"""
    prefix = f"{year - 1911}年中華民國政府行政機關辦公日曆表"
    candidates = [item for item in dataset["result"]["distribution"]
                  if item.get("resourceDescription", "").startswith(prefix) and "Google" not in item["resourceDescription"]]

    def stamp(item):
        m = re.search(r"\((\d+)更新\)", item["resourceDescription"])
        return int(m.group(1)) if m else 0

    best = max(candidates, key=stamp, default=None)
    return best.get("resourceDownloadUrl") if best else None


def _get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read()


def _cached(key, load):
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < CACHE_SECONDS:
        return hit[1]
    value = load()
    _cache[key] = (time.time(), value)
    return value


def fetch_office_calendar(year: int) -> dict[dt.date, dict] | None:
    """從政府資料開放平臺找到該年度 CSV 並下載；人事總處還沒公布就回傳 None。資料集清單與各年度結果都快取一天。"""
    def load():
        url = pick_calendar_url(_cached("dataset", lambda: json.loads(_get(DATASET_API))), year)
        return parse_office_calendar(_get(url)) if url else None
    return _cached(year, load)


def _nth_weekday(year: int, month: int, weekday: int, n: int) -> dt.date:
    first = dt.date(year, month, 1)
    return first + dt.timedelta(days=(weekday - first.weekday()) % 7 + 7 * (n - 1))


def _shopping_events(year: int, days: dict[dt.date, dict]) -> tuple[list[dict], list[str]]:
    events = [(d, name, SOURCE_RULE) for d, name in [
        (dt.date(year, 2, 14), "西洋情人節"),
        (_nth_weekday(year, 5, 6, 2), "母親節"),
        (dt.date(year, 6, 18), "618 購物節"),
        (dt.date(year, 8, 8), "父親節"),
        (dt.date(year, 11, 11), "雙 11"),
        (dt.date(year, 12, 12), "雙 12"),
        (dt.date(year, 12, 25), "聖誕節"),
    ]]
    notes = []
    first_spring = min((d for d, v in days.items() if v["note"] == "春節"), default=None)
    if first_spring:
        events.append((first_spring + dt.timedelta(days=14), "元宵節", SOURCE_DERIVED))
    if year in QIXI:
        events.append((QIXI[year], "七夕情人節", SOURCE_CWA))
        events.append((QIXI[year] + dt.timedelta(days=8), "中元節", SOURCE_CWA))
    else:
        notes.append(f"{year} 年的七夕、中元尚未收錄（氣象署日曆資料表公布後才會補上），不要自行推算。")
    return [{"date": d.isoformat(), "name": n, "source": s} for d, n, s in events], notes


def _long_weekends(days: dict[dt.date, dict], start: dt.date, end: dt.date) -> list[dict]:
    runs = []
    for d in sorted(d for d, v in days.items() if v["off"]):
        if runs and d - runs[-1][-1] == dt.timedelta(days=1):
            runs[-1].append(d)
        else:
            runs.append([d])
    return [{"start": run[0].isoformat(), "end": run[-1].isoformat(), "days": len(run),
             "includes": list(dict.fromkeys(days[d]["note"] for d in run if days[d]["note"]))}
            for run in runs if len(run) >= 3 and run[-1] >= start and run[0] <= end]


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
