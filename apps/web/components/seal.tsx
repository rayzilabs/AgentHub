export function Seal({ stance }: { stance: 'agree' | 'reserve' }) {
  const agree = stance === 'agree';
  return (
    <span
      aria-label={agree ? '立場：同意' : '立場：有保留'}
      className={`inline-block -rotate-6 rounded-sm border-2 px-2 py-0.5 font-display text-sm font-bold tracking-widest ${
        agree ? 'border-seal text-seal' : 'border-ochre text-ochre'
      }`}
    >
      {agree ? '同意' : '保留'}
    </span>
  );
}
