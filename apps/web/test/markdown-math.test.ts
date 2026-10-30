import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from '@/components/markdown';
import { escapeNonMathDollars } from '@/lib/markdown-math';

// 2026-10-31 正式站 368 則回覆：100 則有 $..$ 數學式、20 則有 $$..$$，40 則有金額的 $（例如 | $225 | $192 ～ $271 |）
describe('escapeNonMathDollars', () => {
  it('含 LaTeX 特徵（\\ ^ _ { }）的 $..$ 保留成數學式', () => {
    for (const s of ['無風險利率 $R_f = 0\\%$。', '$w_i \\ge 0, \\sum w_i = 100\\%$', '上限 $25\\%$', '$\\mu_{ann} = \\bar{r} \\times 252$']) {
      expect(escapeNonMathDollars(s)).toBe(s);
    }
  });

  it('金額的 $ 跳脫成文字', () => {
    expect(escapeNonMathDollars('| $225 | $192 ～ $271 |')).toBe('| \\$225 | \\$192 ～ \\$271 |');
    expect(escapeNonMathDollars('總投資金額：NT$ 1,000 萬元')).toBe('總投資金額：NT\\$ 1,000 萬元');
    expect(escapeNonMathDollars('**58% ($5,800,000)**')).toBe('**58% (\\$5,800,000)**');
  });

  it('同一行有金額也有數學式：只跳脫金額', () => {
    expect(escapeNonMathDollars('價格 $195，公式 $P/E \\times g$')).toBe('價格 \\$195，公式 $P/E \\times g$');
  });

  it('$$ 區塊、已跳脫的 \\$、行內程式碼與程式碼區塊不動', () => {
    const block = '$$\n\\text{CAGR} = (1 + r)^{252/N} - 1\n$$';
    expect(escapeNonMathDollars(block)).toBe(block);
    expect(escapeNonMathDollars('$$\\frac{1}{2}$$ 與 $5')).toBe('$$\\frac{1}{2}$$ 與 \\$5');
    expect(escapeNonMathDollars('已跳脫 \\$5')).toBe('已跳脫 \\$5');
    expect(escapeNonMathDollars('執行 `echo $HOME $PATH`')).toBe('執行 `echo $HOME $PATH`');
    const fence = '```bash\nprice=$5; echo $price\n```';
    expect(escapeNonMathDollars(fence)).toBe(fence);
  });
});

describe('Markdown 數學式', () => {
  const html = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

  it('行內與區塊數學式用 KaTeX 渲染', () => {
    expect(html('夏普比率 $\\frac{E(R_p) - R_f}{\\sigma_p}$')).toContain('class="katex"');
    expect(html('$$\n\\text{CAGR} = (1 + r)^{252/N} - 1\n$$')).toContain('katex-display');
  });

  it('金額照原樣顯示，不會變成數學式', () => {
    const out = html('| 目標價 | 區間 |\n|---|---|\n| $225 | $192 ～ $271 |');
    expect(out).not.toContain('katex');
    expect(out).toContain('$225');
    expect(out).toContain('$192 ～ $271');
  });
});
