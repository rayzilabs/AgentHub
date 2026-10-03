import { LoginForm } from './login-form';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <div className="mx-auto mt-12 max-w-sm sm:mt-20">
      <h1 className="text-center font-display text-2xl font-bold">登入 AgentHub</h1>
      <p className="mb-8 mt-2 text-center text-muted">還沒有帳號？填好 Email 和密碼後按「建立帳號」。</p>
      <div className="panel p-6 shadow-float">
        <LoginForm next={next ?? '/projects'} />
      </div>
    </div>
  );
}
