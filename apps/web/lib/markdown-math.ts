/** 成對的 $..$ 裡出現這些字元才算數學式；其他的 $ 多半是金額（$225、NT$ 1,000） */
const MATH_HINT = /[\\^_{}]/;

/**
 * remark-math 會把任兩個 $ 之間當成數學式，金額會被吃掉（| $192 ～ $271 |）。
 * 渲染前把不像數學式的 $ 跳脫成文字；$$ 區塊、已跳脫的 \$、行內程式碼與程式碼區塊不動。
 */
export function escapeNonMathDollars(md: string): string {
  let inFence = false;
  return md.split('\n').map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return line;
    }
    return inFence ? line : escapeLine(line);
  }).join('\n');
}

/** 下一個沒被跳脫、也不屬於 $$ 的 $ */
function closingDollar(line: string, from: number): number {
  for (let i = from; i < line.length; i++) {
    if (line[i] === '\\') i++;
    else if (line[i] === '$') return line[i + 1] === '$' ? -1 : i;
  }
  return -1;
}

function escapeLine(line: string): string {
  let out = '';
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === '`') {
      const run = /^`+/.exec(line.slice(i))![0];
      const end = line.indexOf(run, i + run.length);
      const stop = end === -1 ? i + run.length : end + run.length;
      out += line.slice(i, stop);
      i = stop;
    } else if (c === '\\') {
      out += line.slice(i, i + 2);
      i += 2;
    } else if (c === '$' && line[i + 1] === '$') {
      // $$ 區塊：同一行有結尾就整段照抄，否則是跨行區塊的開頭或結尾，剩下的也照抄
      const end = line.indexOf('$$', i + 2);
      const stop = end === -1 ? line.length : end + 2;
      out += line.slice(i, stop);
      i = stop;
    } else if (c === '$') {
      const end = closingDollar(line, i + 1);
      const inner = end === -1 ? '' : line.slice(i + 1, end);
      if (inner && MATH_HINT.test(inner) && !/^\s|\s$/.test(inner)) {
        out += line.slice(i, end + 1);
        i = end + 1;
      } else {
        out += '\\$';
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}
