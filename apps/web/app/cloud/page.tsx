import Link from 'next/link';
import { CloudProject } from '@/components/files/cloud-project';
import { requirePageUser } from '@/lib/page-guards';
import { listProjects } from '@/lib/services/projects';
import { adminDb } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export default async function CloudPage() {
  const user = await requirePageUser('/cloud');
  const projects = await listProjects(adminDb(), user.id);
  return (
    <div className="mx-auto max-w-3xl py-10 sm:py-14">
      <h1 className="font-display text-2xl font-bold sm:text-4xl">我的雲端</h1>
      <p className="mb-8 mt-2 text-muted">所有專案的檔案都在這裡；每個專案是一個資料夾。</p>
      {projects.length === 0 ? (
        <div className="panel p-6">
          <p className="font-medium">還沒有專案</p>
          <p className="mt-1 text-muted">
            到<Link href="/projects" className="underline">我的專案</Link>建立第一個專案，它的資料夾就會出現在這裡。
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {projects.map((p) => <CloudProject key={p.id} id={p.id} name={p.name} />)}
        </div>
      )}
    </div>
  );
}
