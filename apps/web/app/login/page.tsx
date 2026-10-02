import { LoginForm } from './login-form';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <div className="mx-auto mt-12 max-w-sm">
      <h1 className="font-display text-[28px]">登入 AgentHub</h1>
      <p className="mb-6 mt-1 text-muted">還沒有帳號？填好 Email 和密碼後按「建立帳號」。</p>
      <LoginForm next={next ?? '/projects'} />
    </div>
  );
}
