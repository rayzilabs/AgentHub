import type { CreatorDeletedAction } from '@/lib/services/orgs';

const OPTIONS: { value: CreatorDeletedAction; label: string }[] = [
  { value: 'transfer', label: '轉給管理員（最早加入的管理員）' },
  { value: 'delete', label: '跟著刪除' },
];

export function CreatorDeletedField({ value, onChange }: { value: CreatorDeletedAction; onChange: (value: CreatorDeletedAction) => void }) {
  return (
    <fieldset>
      <legend className="text-sm text-muted">做顧問的人刪除帳號時</legend>
      <div className="mt-1.5 flex flex-wrap gap-x-5 gap-y-2">
        {OPTIONS.map((o) => (
          <label key={o.value} className="flex items-center gap-2 text-sm text-muted">
            <input type="radio" name="creator_deleted_action" value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
            {o.label}
          </label>
        ))}
      </div>
      <p className="hint">沒有其他管理員時一律刪除。</p>
    </fieldset>
  );
}
