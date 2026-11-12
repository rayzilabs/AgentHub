#!/usr/bin/env python3
"""遲延利息試算（本金 × 給付基數 × 年息）。

改寫自 law24tw/tw-legal-calc 的 calc/dates.py 與 calc/money.py（interest_penalty），MIT License：
https://github.com/law24tw/tw-legal-calc
Copyright (c) law24tw contributors。AgentHub 改為單檔命令列工具，只保留利息試算。

規則：起算日與終止日都算入；足年部分算足年數（111.3.10～112.3.9 為 1 年），
不足一年的殘日 ÷ 該殘期所在年度的總日數。年息沒給時用民法第 203 條法定週年利率 5%。

用法：
  python3 interest.py --principal 100000 --start 1150101 --end 1151112 [--rate 5]
日期可用民國 YYYMMDD（1150101）或西元 YYYY-MM-DD／YYYYMMDD。輸出 JSON。
"""
import argparse
import json
import sys
from datetime import date, timedelta
from decimal import Decimal, ROUND_HALF_UP


class CalcError(ValueError):
    pass


def to_date(v):
    s = str(v).strip().replace('/', '').replace('-', '').replace('.', '')
    if not s.isdigit():
        raise CalcError(f'日期格式不合：{v}（需 民國YYYMMDD 或 西元YYYYMMDD）')
    if len(s) == 7:
        y, m, d = int(s[:3]) + 1911, int(s[3:5]), int(s[5:7])
    elif len(s) == 6:
        y, m, d = int(s[:2]) + 1911, int(s[2:4]), int(s[4:6])
    elif len(s) == 8:
        y, m, d = int(s[:4]), int(s[4:6]), int(s[6:8])
    else:
        raise CalcError(f'日期長度不合：{v}')
    try:
        return date(y, m, d)
    except ValueError as e:
        raise CalcError(f'日期不存在：{v}（{e}）')


def roc(d):
    return f'{d.year - 1911}.{d.month}.{d.day}'


def add_years(d, n):
    try:
        return d.replace(year=d.year + n)
    except ValueError:  # 2/29
        return d.replace(year=d.year + n, day=28)


def year_basis(start, end):
    """回傳（足年數、殘日、該年度總日數、給付基數）；起迄都算入。"""
    if end < start:
        raise CalcError('終止日早於起算日')
    n = 0
    while add_years(start, n + 1) - timedelta(days=1) <= end:
        n += 1
    rem_start = add_years(start, n)
    rem = max((end - rem_start).days + 1, 0)
    denom = (add_years(rem_start, 1) - rem_start).days
    basis = Decimal(n) + (Decimal(rem) / Decimal(denom) if rem else Decimal(0))
    return n, rem, denom, basis


def interest(principal, start, end, rate=5):
    s, e = to_date(start), to_date(end)
    n, rem, denom, basis = year_basis(s, e)
    r = Decimal(str(rate))
    r = r / 100 if r > 1 else r  # 5 與 0.05 同義
    amount = Decimal(str(principal)) * basis * r
    return {
        'principal': float(Decimal(str(principal))),
        'rate': float(r),
        'start': roc(s),
        'end': roc(e),
        'basis_years': {'full': n, 'remainder_days': rem, 'denominator': denom, 'value': float(basis)},
        'formula': '本金 × 給付基數（年）× 年息；起迄日都算入，不足一年按殘日 ÷ 該年度總日數',
        'amount': float(amount.quantize(Decimal(1), rounding=ROUND_HALF_UP)),
        'legal_basis': '民法第 233 條（遲延利息）、第 203 條（法定週年利率 5%）；約定利率較高者從約定',
    }


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
    p = argparse.ArgumentParser(description='遲延利息試算')
    p.add_argument('--principal', required=True, type=float)
    p.add_argument('--start', required=True)
    p.add_argument('--end', required=True)
    p.add_argument('--rate', type=float, default=5)
    a = p.parse_args()
    try:
        print(json.dumps(interest(a.principal, a.start, a.end, a.rate), ensure_ascii=False))
    except CalcError as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
