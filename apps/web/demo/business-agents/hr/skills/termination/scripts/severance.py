#!/usr/bin/env python3
"""資遣費試算（勞基法第 17 條舊制、勞工退休金條例第 12 條新制、跨制分段計算）。

用法：
  python3 severance.py --onboard 2021-03-01 --leave 2026-09-01 --avg-wage 45000
  python3 severance.py --onboard 2021-03-01 --leave 2026-09-01 --wages 46000,45000,45000,44000,45000,45000 --json
  python3 severance.py --onboard 2003-05-01 --leave 2026-09-01 --avg-wage 50000 --old-system   # 選擇繼續適用舊制者

--leave 是契約終止日（離職日），年資算到這一天為止。
--wages 是事由發生前 6 個月各月工資（由近到遠），會依勞基法第 2 條第 4 款算平均工資。
只用標準函式庫。改寫自 law24tw/tw-legal-calc 的 calc/labor.py（MIT）。
"""
import argparse
import calendar
import json
import sys
from datetime import date
from decimal import ROUND_HALF_UP, Decimal

NEW_SYSTEM_START = date(2005, 7, 1)  # 勞工退休金條例施行日（94 年 7 月 1 日）


def add_months(d: date, n: int) -> date:
    y, m = divmod(d.month - 1 + n, 12)
    y += d.year
    m += 1
    return date(y, m, min(d.day, calendar.monthrange(y, m)[1]))


def ymd_between(a: date, b: date) -> tuple[int, int, int]:
    """a 到 b 的年、月、日（以曆法逐月推進）。"""
    months = (b.year - a.year) * 12 + (b.month - a.month)
    if add_months(a, months) > b:
        months -= 1
    days = (b - add_months(a, months)).days
    return months // 12, months % 12, days


def rnd(x: Decimal) -> int:
    return int(x.quantize(Decimal(1), rounding=ROUND_HALF_UP))


def average_wage(wages: list[float], event: date) -> tuple[Decimal, str]:
    if len(wages) != 6:
        raise SystemExit('--wages 要給 6 個月的工資')
    days = (event - add_months(event, -6)).days
    return (sum(Decimal(str(w)) for w in wages) / Decimal(days) * 30,
            f'6 個月工資總額 ÷ 期間總日數 {days} 日 × 30（勞基法第 2 條第 4 款）')


def old_part(a: date, b: date, w: Decimal) -> dict:
    y, m, d = ymd_between(a, b)
    months = y * 12 + m + (1 if d > 0 else 0)  # 未滿一個月者以一個月計
    return {'from': a.isoformat(), 'to': b.isoformat(), 'service': f'{y} 年 {m} 個月 {d} 日', 'months_counted': months,
            'amount': rnd(w * months / 12),
            'formula': '每滿 1 年給 1 個月平均工資；剩餘月數或未滿 1 年按比例，未滿 1 個月以 1 個月計（勞基法第 17 條）'}


def new_part(a: date, b: date, w: Decimal) -> dict:
    y, m, d = ymd_between(a, b)
    years = Decimal(y) + Decimal(m) / 12 + Decimal(d) / 365  # 勞動部資遣費試算表的算法
    uncapped = w * years / 2
    amount = min(uncapped, w * 6)
    return {'from': a.isoformat(), 'to': b.isoformat(), 'service': f'{y} 年 {m} 個月 {d} 日',
            'service_years': float(years.quantize(Decimal('0.0001'))), 'amount': rnd(amount), 'uncapped': rnd(uncapped),
            'cap_hit': amount < uncapped,
            'formula': '每滿 1 年給 ½ 個月平均工資，未滿 1 年按比例（年＋月/12＋日/365），最高 6 個月（勞工退休金條例第 12 條）'}


def severance(onboard: date, leave: date, w: Decimal, old_system: bool) -> dict:
    if leave <= onboard:
        raise SystemExit('離職日要晚於到職日')
    parts = {}
    if old_system or leave <= NEW_SYSTEM_START:
        parts['舊制'] = old_part(onboard, leave, w)
    elif onboard >= NEW_SYSTEM_START:
        parts['新制'] = new_part(onboard, leave, w)
    else:
        parts['舊制'] = old_part(onboard, NEW_SYSTEM_START, w)
        parts['新制'] = new_part(NEW_SYSTEM_START, leave, w)
    notes = ['資遣費要在契約終止後 30 日內付清（勞工退休金條例第 12 條第 2 項；逾期依第 45-1 條處 30 萬～150 萬元罰鍰）。']
    if '舊制' in parts and '新制' in parts:
        notes.append('94/7/1 前到職、之後選擇新制者：選擇前的年資保留，依舊制計算；之後的年資依新制計算，6 個月上限只適用新制部分。')
    return {'onboard': onboard.isoformat(), 'leave': leave.isoformat(), 'avg_monthly_wage': float(w.quantize(Decimal('0.01'))),
            'parts': parts, 'total': sum(p['amount'] for p in parts.values()), 'notes': notes}


def main() -> None:
    sys.stdout.reconfigure(encoding='utf-8')  # Windows 主控台預設不是 UTF-8
    p = argparse.ArgumentParser(description='資遣費試算')
    p.add_argument('--onboard', required=True, type=date.fromisoformat, help='到職日 YYYY-MM-DD')
    p.add_argument('--leave', required=True, type=date.fromisoformat, help='契約終止日 YYYY-MM-DD')
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument('--avg-wage', type=float, help='月平均工資')
    g.add_argument('--wages', help='事由發生前 6 個月各月工資，逗號分隔')
    p.add_argument('--old-system', action='store_true', help='勞工選擇繼續適用勞基法舊制')
    p.add_argument('--json', action='store_true')
    a = p.parse_args()
    if a.avg_wage is not None:
        w, note = Decimal(str(a.avg_wage)), '直接給定'
    else:
        w, note = average_wage([float(x) for x in a.wages.split(',')], a.leave)
    r = severance(a.onboard, a.leave, w, a.old_system)
    r['avg_wage_note'] = note
    if a.json:
        print(json.dumps(r, ensure_ascii=False, indent=1))
        return
    print(f"平均工資 {r['avg_monthly_wage']:,} 元（{note}）")
    for name, part in r['parts'].items():
        print(f"{name}：{part['from']}～{part['to']}，年資 {part['service']}，{part['amount']:,} 元。{part['formula']}")
    print(f"合計 {r['total']:,} 元")
    for n in r['notes']:
        print(f'・{n}')


if __name__ == '__main__':
    main()
