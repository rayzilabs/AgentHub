#!/usr/bin/env python3
"""特別休假試算（週年制）：列出各期間天數，算出「契約終止或今天」所在期間的未休日數與折發工資。

用法：
  python3 annual_leave.py --onboard 2024-03-01 --leave 2026-05-15 --taken 4 --monthly-wage 36000
  python3 annual_leave.py --onboard 2024-03-01 --leave 2026-05-15 --taken 4 --daily-wage 1250 --json

--leave：契約終止日；只想查目前的特休就給今天。
--taken：當期已休日數（前幾期應已在年度終結時休完或折發，勞基法第 38 條第 4 項）。
--deferred：上一期協商遞延到當期、到終止時還沒休的天數（第 38 條第 4 項但書；本期請休時先扣遞延天數，施行細則第 24-1 條第 3 項）。
  遞延天數應按原年度終結時的一日工資折發；那時的工資和現在不同時，請分開計算。
一日工資：計月者為終止前最近一個月正常工時工資 ÷ 30（施行細則第 24-1 條第 2 項第 1 款第 2 目）。
曆年制、會計年度制請先照週年制算出各期天數，再依勞雇雙方的約定換算；換算結果不得少於週年制（施行細則第 24 條第 2 項）。
只用標準函式庫。改寫自 law24tw/tw-legal-calc 的 calc/labor.py（MIT），改成只結算當期。
"""
import argparse
import calendar
import json
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal


def add_months(d: date, n: int) -> date:
    y, m = divmod(d.month - 1 + n, 12)
    y += d.year
    m += 1
    return date(y, m, min(d.day, calendar.monthrange(y, m)[1]))


def days_for(months: int) -> int:
    """勞基法第 38 條第 1 項：依期間開始時的年資（月）給假"""
    if months < 12:
        return 3
    if months < 24:
        return 7
    if months < 36:
        return 10
    if months < 60:
        return 14
    if months < 120:
        return 15
    return min(15 + (months - 108) // 12, 30)  # 滿 10 年 16 日，之後每年加 1 日，最多 30 日


def anniversary(onboard: date, months: int) -> date:
    """年資滿 months 個月的那一天（民法第 120、121 條）。次月沒有相當日（例如 8/31 到職滿 6 個月）時，
    期間末日是該月月底，所以隔天才滿期。"""
    d = add_months(onboard, months)
    return d + timedelta(days=1) if d.day < onboard.day else d


def periods(onboard: date, until: date) -> list[dict]:
    """每一期從年資滿 6 個月、1 年、2 年……開始，到下一個週年日前一天為止。"""
    out = []
    months = 6
    start = anniversary(onboard, months)
    while start <= until:
        nxt = 12 if months == 6 else months + 12
        end = anniversary(onboard, nxt)
        out.append({'start': start.isoformat(), 'end': (end - timedelta(days=1)).isoformat(),
                    'service_at_start': '滿 6 個月' if months == 6 else f'滿 {months // 12} 年', 'entitled_days': days_for(months)})
        start, months = end, nxt
    return out


def main() -> None:
    p = argparse.ArgumentParser(description='特別休假試算（週年制）')
    p.add_argument('--onboard', required=True, type=date.fromisoformat)
    p.add_argument('--leave', required=True, type=date.fromisoformat, help='契約終止日，或今天')
    p.add_argument('--taken', type=Decimal, default=Decimal(0), help='當期已休日數（含已休的遞延天數）')
    p.add_argument('--deferred', type=Decimal, default=Decimal(0), help='上一期協商遞延到當期的天數')
    g = p.add_mutually_exclusive_group()
    g.add_argument('--monthly-wage', type=Decimal, help='最近一個月正常工時工資')
    g.add_argument('--daily-wage', type=Decimal, help='一日工資')
    p.add_argument('--json', action='store_true')
    a = p.parse_args()
    if a.leave <= a.onboard:
        raise SystemExit('離職日要晚於到職日')

    ps = periods(a.onboard, a.leave)
    current = ps[-1] if ps else None
    r = {'onboard': a.onboard.isoformat(), 'leave': a.leave.isoformat(), 'periods': ps, 'current_period': current,
         'basis': ['勞基法第 38 條第 1 項、第 4 項', '施行細則第 24 條（期間首日取得全部天數）', '施行細則第 24-1 條（未休日數 × 一日工資）']}
    if current is None:
        r['note'] = '在職未滿 6 個月，還沒有特別休假（勞基法第 38 條第 1 項第 1 款）'
    else:
        available = current['entitled_days'] + a.deferred
        if a.taken > available:
            raise SystemExit(f"當期已休 {a.taken} 日，超過當期可休的 {available} 日（{current['start']} 起 {current['entitled_days']} 日"
                             f"＋遞延 {a.deferred} 日）。--taken 只算 {current['start']} 以後休的天數；前幾期的天數應在各期結束時"
                             '休完或折發，從上一期遞延過來的天數用 --deferred 給。請確認公司採週年制還是曆年制，以及各期實際休了幾天。')
        unused = available - a.taken
        r['unused_days'] = float(unused)
        r['note'] = '特休在期間首日就取得全部天數；契約終止時未休日數全額折發工資，不按在職比例折算。'
        daily = a.daily_wage or (a.monthly_wage / 30 if a.monthly_wage else None)
        if daily is not None:
            r['daily_wage'] = float(daily.quantize(Decimal('0.01')))
            r['unused_wage'] = int((daily * unused).quantize(Decimal(1), rounding=ROUND_HALF_UP))
    if a.json:
        print(json.dumps(r, ensure_ascii=False, indent=1))
        return
    for x in ps:
        print(f"{x['start']}～{x['end']}（{x['service_at_start']}）：{x['entitled_days']} 日")
    print(r['note'])
    if 'unused_days' in r:
        print(f"當期未休 {r['unused_days']} 日" + (f"，折發 {r['unused_wage']:,} 元（一日工資 {r['daily_wage']:,} 元）" if 'unused_wage' in r else ''))


if __name__ == '__main__':
    main()
