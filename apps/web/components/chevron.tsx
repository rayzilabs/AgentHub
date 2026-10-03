/** 列表右側的箭頭，表示整列可以點進去 */
export function Chevron({ className = '' }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 8 14" className={`h-3.5 w-2 shrink-0 text-muted/70 ${className}`} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 1l6 6-6 6" />
    </svg>
  );
}
