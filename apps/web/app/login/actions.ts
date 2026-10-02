'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { adminDb } from '@/lib/supabase/admin';
import { createSessionClient } from '@/lib/supabase/server';

export type LoginState = { error?: string };

const Credentials = z.object({
  email: z.email('請輸入有效的 Email'),
  password: z.string().min(8, '密碼至少 8 個字元'),
});

function safeNext(value: FormDataEntryValue | null): string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : '/projects';
}

function parse(formData: FormData) {
  return Credentials.safeParse({ email: formData.get('email'), password: formData.get('password') });
}

export async function signIn(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = parse(formData);
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const supabase = await createSessionClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) return { error: 'Email 或密碼不正確' };
  redirect(safeNext(formData.get('next')));
}

export async function signUp(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = parse(formData);
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const { error: createError } = await adminDb().auth.admin.createUser({ ...parsed.data, email_confirm: true });
  if (createError) {
    return {
      error: /already|registered|exists/i.test(createError.message)
        ? '這個 Email 已經註冊過，請直接登入'
        : `無法建立帳號：${createError.message}`,
    };
  }
  const supabase = await createSessionClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) return { error: '帳號已建立，但登入失敗，請再試一次' };
  redirect(safeNext(formData.get('next')));
}

export async function signOut() {
  const supabase = await createSessionClient();
  await supabase.auth.signOut();
  redirect('/');
}
