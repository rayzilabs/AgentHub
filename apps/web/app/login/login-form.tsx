'use client';

import { useActionState, useState } from 'react';
import { signIn, signUp, type LoginState } from './actions';

export function LoginForm({ next }: { next: string }) {
  const [signInState, signInAction, signingIn] = useActionState<LoginState, FormData>(signIn, {});
  const [signUpState, signUpAction, signingUp] = useActionState<LoginState, FormData>(signUp, {});
  // 兩個按鈕各有自己的結果，只顯示最後按下的那個，避免舊的錯誤殘留
  const [lastAction, setLastAction] = useState<'signIn' | 'signUp' | null>(null);
  const busy = signingIn || signingUp;
  const error = busy ? undefined : lastAction === 'signIn' ? signInState.error : lastAction === 'signUp' ? signUpState.error : undefined;

  return (
    <form className="space-y-4">
      <input type="hidden" name="next" value={next} />
      <label className="block">
        <span className="text-sm text-muted">Email</span>
        <input name="email" type="email" required autoComplete="email"
          className="mt-1 w-full rounded border border-line bg-surface px-3 py-2" />
      </label>
      <label className="block">
        <span className="text-sm text-muted">密碼（至少 8 個字元）</span>
        <input name="password" type="password" required minLength={8} autoComplete="current-password"
          className="mt-1 w-full rounded border border-line bg-surface px-3 py-2" />
      </label>
      {error && <p role="alert" className="text-sm text-seal">{error}</p>}
      <div className="flex gap-3">
        <button formAction={signInAction} onClick={() => setLastAction('signIn')} disabled={busy} className="rounded bg-brand px-4 py-2 text-white disabled:opacity-60">
          登入
        </button>
        <button formAction={signUpAction} onClick={() => setLastAction('signUp')} disabled={busy} className="rounded border border-line px-4 py-2 disabled:opacity-60">
          建立帳號
        </button>
      </div>
    </form>
  );
}
