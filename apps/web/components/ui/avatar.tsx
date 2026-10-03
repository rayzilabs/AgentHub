/** 主管的頭像色：中性灰，和顧問的識別色區隔 */
export const MANAGER_COLOR = '#48484a';

/** 顧問頭像：識別色圓形加上名字的第一個字 */
export function Avatar({ name, color, size = 'md' }: { name: string; color: string; size?: 'sm' | 'md' }) {
  return (
    <span aria-hidden className={`avatar ${size === 'sm' ? 'h-6 w-6 text-sm' : 'h-8 w-8 text-sm'}`}
      style={{ '--agent': color } as React.CSSProperties}>
      {Array.from(name.trim())[0] ?? '?'}
    </span>
  );
}
