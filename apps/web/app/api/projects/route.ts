import { after } from 'next/server';
import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { readJson, route } from '@/lib/http';
import { createProject, listProjects } from '@/lib/services/projects';
import { provisionProject } from '@/lib/sprites';
import { adminDb } from '@/lib/supabase/admin';

export const maxDuration = 300;

export const GET = route(async (req: Request) => {
  const user = await requireUser(req);
  return listProjects(adminDb(), user.id);
});

export const POST = route(async (req: Request) => {
  const user = await requireUser(req);
  const { name } = await readJson(req, z.object({ name: z.string().trim().min(1, '請填寫專案名稱').max(60) }));
  const project = await createProject(adminDb(), user.id, name);
  after(() => provisionProject(adminDb(), project.id));
  return project;
});
