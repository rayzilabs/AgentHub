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
        <span className="label">Email</span>
        <input name="email" type="email" required autoComplete="email"
          className="field" />
      </label>
      <label className="block">
        <span className="label">密碼（至少 8 個字元）</span>
        <input name="password" type="password" required minLength={8} autoComplete="current-password"
          className="field" />
      </label>
      {error && <p role="alert" className="notice notice-error">{error}</p>}
      <div className="flex gap-3 pt-2">
        <button formAction={signInAction} onClick={() => setLastAction('signIn')} disabled={busy} className="btn btn-primary flex-1">
          登入
        </button>
        <button formAction={signUpAction} onClick={() => setLastAction('signUp')} disabled={busy} className="btn btn-secondary flex-1">
          建立帳號
        </button>
      </div>
    </form>
  );
}
