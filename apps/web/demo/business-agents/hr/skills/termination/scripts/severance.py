#!/usr/bin/env python3
"""資遣費試算（勞基法第 17 條舊制、勞工退休金條例第 12 條新制、跨制分段計算），並列出預告期間與各項期限。

用法：
  python3 severance.py --onboard 2021-03-01 --leave 2026-09-01 --avg-wage 45000
  python3 severance.py --onboard 2021-03-01 --leave 2026-09-01 --wages 46000,45000,45000,44000,45000,45000 --json
  python3 severance.py --onboard 2000-01-01 --leave 2026-09-01 --avg-wage 50000 --switch-date 2008-01-01   # 晚幾年才改選新制
  python3 severance.py --onboard 2003-05-01 --leave 2026-09-01 --avg-wage 50000 --old-system   # 一直適用舊制

--leave 是契約終止日（離職日），年資算到這一天為止。
--wages 是終止日前 6 個月各月的工資（由近到遠，含每月固定的津貼獎金、加班費）。
  依勞基法施行細則第 2 條，下列期間的日數與工資都不計入：普通傷病假、產假減半、職災醫療中、
  生理假或產假或家庭照顧假或安胎致減少工資、留職停薪、雇主因不可抗力不能繼續事業。
  有這些期間、工作未滿 6 個月，或按日、時、件計酬（有六成下限）時，不要用 --wages：
  請用勞動部資遣費試算系統 https://calcr2.mol.gov.tw/SeverancePay 算出平均工資，再用 --avg-wage 輸入。
只用標準函式庫。改寫自 law24tw/tw-legal-calc 的 calc/labor.py（MIT），公式依勞動部〈資遣費給付標準〉的官方算例。
"""
import argparse
import calendar
import json
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal

NEW_SYSTEM_START = date(2005, 7, 1)  # 勞工退休金條例施行日（94 年 7 月 1 日）


def add_months(d: date, n: int) -> date:
    y, m = divmod(d.month - 1 + n, 12)
    y += d.year
    m += 1
    return date(y, m, min(d.day, calendar.monthrange(y, m)[1]))


def months_days_between(a: date, b: date) -> tuple[int, int]:
    """a 到 b 經過的整月數與剩餘天數（以曆法逐月推進）。"""
    months = (b.year - a.year) * 12 + (b.month - a.month)
    if add_months(a, months) > b:
        months -= 1
    return months, (b - add_months(a, months)).days


def rnd(x: Decimal) -> int:
    return int(x.quantize(Decimal(1), rounding=ROUND_HALF_UP))


def average_wage(wages: list[Decimal]) -> tuple[Decimal, str]:
    if len(wages) != 6:
        raise SystemExit('--wages 要給終止日前 6 個月各月的工資。工作未滿 6 個月或有不計入的期間時，'
                         '請用勞動部資遣費試算系統 https://calcr2.mol.gov.tw/SeverancePay 算出平均工資，改用 --avg-wage。')
    return (sum(wages) / 6,
            '前 6 個月工資總額 ÷ 6（勞基法第 2 條第 4 款；日平均工資 × 計算期間每月平均日數，勞委會 83 年 4 月 9 日函釋）')


def span(a: date, b: date) -> tuple[int, int, dict]:
    months, days = months_days_between(a, b)
    y, m = divmod(months, 12)
    return months, days, {'from': a.isoformat(), 'to': b.isoformat(), 'service': f'{y} 年 {m} 個月 {days} 日'}


def old_part(a: date, b: date, w: Decimal) -> dict:
    months, days, out = span(a, b)
    counted = months + (1 if days > 0 else 0)  # 未滿一個月者以一個月計
    return {**out, 'months_counted': counted, 'amount': rnd(w * counted / 12),
            'formula': '平均工資 ×〔年 +（月 + 未滿 1 個月以 1 個月計）÷ 12〕（勞基法第 17 條）'}


def new_part(a: date, b: date, w: Decimal) -> dict:
    months, days, out = span(a, b)
    years = (Decimal(months) + Decimal(days) / 30) / 12  # 勞動部算例：畸零日數 ÷ 30 換算成月
    uncapped = w * years / 2
    return {**out, 'service_years': float(years.quantize(Decimal('0.0001'))), 'amount': rnd(min(uncapped, w * 6)),
            'uncapped': rnd(uncapped),
            'formula': '平均工資 × ½ ×〔年 +（月 + 日 ÷ 30）÷ 12〕，最高 6 個月（勞工退休金條例第 12 條）'}


def notice_days(onboard: date, leave: date) -> int:
    """勞基法第 16 條第 1 項：依繼續工作的期間預告"""
    months, _ = months_days_between(onboard, leave)
    if months < 3:
        return 0
    if months < 12:
        return 10
    if months < 36:
        return 20
    return 30


def deadlines(onboard: date, leave: date) -> dict:
    n = notice_days(onboard, leave)
    return {
        'notice_days': n,
        'notify_by': (leave - timedelta(days=n)).isoformat(),
        'report_by': (leave - timedelta(days=10)).isoformat(),
        'pay_by': (leave + timedelta(days=30)).isoformat(),
        'note': '都是曆日，不是工作日。notify_by：最晚在這天預告（勞基法第 16 條；未預告要給預告期間工資）；'
                'report_by：資遣通報最晚這天送出（就業服務法第 33 條，離職 10 日前）；'
                'pay_by：資遣費最晚這天付清（終止後 30 日內）。給付期限的末日遇星期日、紀念日或其他休息日，順延到次日（民法第 122 條）。',
    }


def severance(onboard: date, leave: date, w: Decimal, old_system: bool, switch: date) -> dict:
    if leave <= onboard:
        raise SystemExit('離職日要晚於到職日')
    if old_system and onboard >= NEW_SYSTEM_START:
        raise SystemExit('94/7/1（2005-07-01）以後到職的勞工一律適用勞退新制，不能選擇舊制，請拿掉 --old-system。')
    if switch < NEW_SYSTEM_START:
        raise SystemExit('--switch-date 不能早於勞退新制施行日 2005-07-01')
    if old_system or leave <= switch:
        parts = {'舊制': old_part(onboard, leave, w)}
    elif onboard >= switch:
        parts = {'新制': new_part(onboard, leave, w)}
    else:
        parts = {'舊制': old_part(onboard, switch, w), '新制': new_part(switch, leave, w)}
    notes = []
    if '新制' in parts:
        notes.append('新制資遣費要在終止後 30 日內付清（勞工退休金條例第 12 條第 2 項；逾期依第 45-1 條處 30 萬～150 萬元罰鍰）。')
    if '舊制' in parts:
        notes.append('舊制資遣費要在終止後 30 日內發給（勞基法第 17 條第 2 項；逾期依第 78 條處 30 萬～150 萬元罰鍰）。')
        notes.append('有舊制年資的勞工若已符合自請退休條件（勞基法第 53 條：工作 15 年以上且年滿 55 歲、工作 25 年以上、'
                     '工作 10 年以上且年滿 60 歲），被資遣時可能要改發退休金，請先向勞工局或律師確認。')
    if len(parts) == 2:
        notes.append(f'改選新制（{switch.isoformat()}）前的年資保留，依舊制計算；之後的年資依新制計算，6 個月上限只適用新制部分。'
                     '改選日期以向勞保局申報適用新制的日期為準（勞工退休金條例第 9、11 條）。')
    return {'onboard': onboard.isoformat(), 'leave': leave.isoformat(), 'avg_monthly_wage': float(w.quantize(Decimal('0.01'))),
            'parts': parts, 'total': sum(p['amount'] for p in parts.values()), 'deadlines': deadlines(onboard, leave), 'notes': notes}


def main() -> None:
    p = argparse.ArgumentParser(description='資遣費試算')
    p.add_argument('--onboard', required=True, type=date.fromisoformat, help='到職日 YYYY-MM-DD')
    p.add_argument('--leave', required=True, type=date.fromisoformat, help='契約終止日 YYYY-MM-DD')
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument('--avg-wage', type=Decimal, help='月平均工資')
    g.add_argument('--wages', type=lambda s: [Decimal(x) for x in s.split(',')], help='終止日前 6 個月各月工資，逗號分隔')
    p.add_argument('--switch-date', type=date.fromisoformat, default=NEW_SYSTEM_START,
                   help='94/7/1 前到職者改適用新制的日期（預設 2005-07-01）')
    p.add_argument('--old-system', action='store_true', help='勞工一直適用勞基法舊制')
    p.add_argument('--json', action='store_true')
    a = p.parse_args()
    w, note = (a.avg_wage, '直接給定') if a.avg_wage is not None else average_wage(a.wages)
    r = severance(a.onboard, a.leave, w, a.old_system, a.switch_date)
    r['avg_wage_note'] = note
    if a.json:
        print(json.dumps(r, ensure_ascii=False, indent=1))
        return
    print(f"平均工資 {r['avg_monthly_wage']:,} 元（{note}）")
    for name, part in r['parts'].items():
        print(f"{name}：{part['from']}～{part['to']}，年資 {part['service']}，{part['amount']:,} 元。{part['formula']}")
    print(f"合計 {r['total']:,} 元")
    d = r['deadlines']
    print(f"預告 {d['notice_days']} 日（最晚 {d['notify_by']} 通知）；資遣通報最晚 {d['report_by']}；資遣費最晚 {d['pay_by']} 付清。{d['note']}")
    for n in r['notes']:
        print(f'・{n}')


if __name__ == '__main__':
    main()
