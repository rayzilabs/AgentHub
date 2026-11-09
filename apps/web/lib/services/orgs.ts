import { HttpError } from '@/lib/http';
import type { OrgInput, OrgPatch } from '@/lib/schemas';
import type { Db } from '@/lib/supabase/admin';

export type OrgRole = 'admin' | 'member';
export type OrgRow = { id: string; name: string; require_template_approval: boolean; created_at: string };
export type MyOrg = OrgRow & { role: OrgRole };
export type OrgMember = { user_id: string; email: string; role: OrgRole; joined_at: string };
export type OrgInvitation = {
  id: string;
  email: string;
  status: 'invited' | 'accepted';
  needs_approval: boolean;
  invited_by_email: string;
  expires_at: string;
  expired: boolean;
};
/** invitations：管理員看全部，一般成員只看自己發的。 */
export type OrgDetail = { org: OrgRow; role: OrgRole; members: OrgMember[]; invitations: OrgInvitation[] };
export type MyInvitation = { id: string; org_id: string; org_name: string; invited_by_email: string; expires_at: string };

const ORG_COLUMNS = 'id, name, require_template_approval, created_at';
const MEMBER_COLUMNS = 'user_id, email, role, joined_at';
const INVITATION_COLUMNS = 'id, org_id, email, invited_by, needs_approval, status, accepted_user_id, expires_at';
const ORG_NOT_FOUND = '找不到這個組織';
const INVITATION_NOT_FOUND = '找不到這份邀請';
const ADMIN_ONLY = '只有管理員可以這樣做';
const LAST_ADMIN = '組織至少要有一位管理員，請先指定另一位管理員';

type InvitationRow = {
  id: string; org_id: string; email: string; invited_by: string; needs_approval: boolean;
  status: 'invited' | 'accepted'; accepted_user_id: string | null; expires_at: string;
};

const normalizeEmail = (email: string) => email.trim().toLowerCase();
const isExpired = (inv: Pick<InvitationRow, 'status' | 'expires_at'>) => inv.status === 'invited' && new Date(inv.expires_at) < new Date();

export async function createOrg(db: Db, user: { id: string; email: string }, input: OrgInput): Promise<OrgRow> {
  const { data, error } = await db.from('organizations')
    .insert({ name: input.name, require_template_approval: input.require_template_approval ?? false, created_by: user.id })
    .select(ORG_COLUMNS).single();
  if (error) throw error;
  const { error: memberError } = await db.from('org_members').insert({ org_id: data.id, user_id: user.id, role: 'admin', email: normalizeEmail(user.email) });
  if (memberError) {
    await db.from('organizations').delete().eq('id', data.id);
    throw memberError;
  }
  return data as OrgRow;
}

export async function listMyOrgs(db: Db, userId: string): Promise<MyOrg[]> {
  const { data, error } = await db.from('org_members').select(`role, org:organizations(${ORG_COLUMNS})`).eq('user_id', userId);
  if (error) throw error;
  return (data as unknown as { role: OrgRole; org: OrgRow }[])
    .map((r) => ({ ...r.org, role: r.role }))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export async function getMembership(db: Db, userId: string, orgId: string): Promise<OrgRole | null> {
  const { data, error } = await db.from('org_members').select('role').eq('org_id', orgId).eq('user_id', userId).maybeSingle();
  if (error) throw error;
  return (data?.role as OrgRole | undefined) ?? null;
}

export async function requireMember(db: Db, userId: string, orgId: string): Promise<OrgRole> {
  const role = await getMembership(db, userId, orgId);
  if (!role) throw new HttpError(404, ORG_NOT_FOUND);
  return role;
}

export async function requireAdmin(db: Db, userId: string, orgId: string): Promise<void> {
  if ((await requireMember(db, userId, orgId)) !== 'admin') throw new HttpError(403, ADMIN_ONLY);
}

async function listMembers(db: Db, orgId: string): Promise<OrgMember[]> {
  const { data, error } = await db.from('org_members').select(MEMBER_COLUMNS).eq('org_id', orgId).order('joined_at');
  if (error) throw error;
  return data as OrgMember[];
}

function toInvitation(row: InvitationRow, emailByUser: Map<string, string>): OrgInvitation {
  return {
    id: row.id,
    email: row.email,
    status: row.status,
    needs_approval: row.needs_approval,
    invited_by_email: emailByUser.get(row.invited_by) ?? '',
    expires_at: row.expires_at,
    expired: isExpired(row),
  };
}

export async function getOrgDetail(db: Db, userId: string, orgId: string): Promise<OrgDetail> {
  const role = await requireMember(db, userId, orgId);
  const { data: org, error } = await db.from('organizations').select(ORG_COLUMNS).eq('id', orgId).single();
  if (error) throw error;
  const members = await listMembers(db, orgId);
  let query = db.from('org_invitations').select(INVITATION_COLUMNS).eq('org_id', orgId).order('created_at');
  if (role !== 'admin') query = query.eq('invited_by', userId);
  const { data: rows, error: invError } = await query;
  if (invError) throw invError;
  const emailByUser = new Map(members.map((m) => [m.user_id, m.email]));
  return { org: org as OrgRow, role, members, invitations: (rows as InvitationRow[]).map((r) => toInvitation(r, emailByUser)) };
}

export async function updateOrg(db: Db, userId: string, orgId: string, patch: OrgPatch): Promise<OrgRow> {
  await requireAdmin(db, userId, orgId);
  const { data, error } = await db.from('organizations').update(patch).eq('id', orgId).select(ORG_COLUMNS).single();
  if (error) throw error;
  return data as OrgRow;
}

export async function invite(db: Db, userId: string, orgId: string, rawEmail: string): Promise<OrgInvitation> {
  const role = await requireMember(db, userId, orgId);
  const email = normalizeEmail(rawEmail);

  const { data: existingMember, error: memberError } = await db.from('org_members').select('user_id').eq('org_id', orgId).eq('email', email).maybeSingle();
  if (memberError) throw memberError;
  if (existingMember) throw new HttpError(409, '這個人已經是成員');

  const { data: existing, error: existingError } = await db.from('org_invitations').select(INVITATION_COLUMNS).eq('org_id', orgId).eq('email', email).maybeSingle();
  if (existingError) throw existingError;
  if (existing) {
    if (!isExpired(existing as InvitationRow)) throw new HttpError(409, '已經邀請過這個 email');
    const { error } = await db.from('org_invitations').delete().eq('id', existing.id);
    if (error) throw error;
  }

  const { data, error } = await db.from('org_invitations')
    .insert({ org_id: orgId, email, invited_by: userId, needs_approval: role !== 'admin' })
    .select(INVITATION_COLUMNS).single();
  if (error) {
    // 同時送出兩次邀請時，後到的撞到 unique(org_id, email)
    if (error.code === '23505') throw new HttpError(409, '已經邀請過這個 email');
    throw error;
  }
  const members = await listMembers(db, orgId);
  return toInvitation(data as InvitationRow, new Map(members.map((m) => [m.user_id, m.email])));
}

async function getInvitationInOrg(db: Db, orgId: string, invitationId: string): Promise<InvitationRow> {
  const { data, error } = await db.from('org_invitations').select(INVITATION_COLUMNS).eq('id', invitationId).eq('org_id', orgId).maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, INVITATION_NOT_FOUND);
  return data as InvitationRow;
}

export async function revokeInvitation(db: Db, userId: string, orgId: string, invitationId: string): Promise<void> {
  const role = await requireMember(db, userId, orgId);
  const inv = await getInvitationInOrg(db, orgId, invitationId);
  if (inv.invited_by !== userId && role !== 'admin') throw new HttpError(403, ADMIN_ONLY);
  const { error } = await db.from('org_invitations').delete().eq('id', invitationId);
  if (error) throw error;
}

/** 核准／拒絕只處理對方已接受、等待管理員決定的邀請。 */
async function getAcceptedInvitation(db: Db, userId: string, orgId: string, invitationId: string): Promise<InvitationRow & { accepted_user_id: string }> {
  await requireAdmin(db, userId, orgId);
  const inv = await getInvitationInOrg(db, orgId, invitationId);
  if (inv.status !== 'accepted' || !inv.accepted_user_id) throw new HttpError(404, INVITATION_NOT_FOUND);
  return inv as InvitationRow & { accepted_user_id: string };
}

export async function approveInvitation(db: Db, userId: string, orgId: string, invitationId: string): Promise<OrgMember> {
  const inv = await getAcceptedInvitation(db, userId, orgId, invitationId);
  const member = await addMember(db, orgId, inv.accepted_user_id, inv.email);
  const { error } = await db.from('org_invitations').delete().eq('id', invitationId);
  if (error) throw error;
  return member;
}

export async function rejectInvitation(db: Db, userId: string, orgId: string, invitationId: string): Promise<void> {
  await getAcceptedInvitation(db, userId, orgId, invitationId);
  const { error } = await db.from('org_invitations').delete().eq('id', invitationId);
  if (error) throw error;
}

async function addMember(db: Db, orgId: string, userId: string, email: string): Promise<OrgMember> {
  const { data, error } = await db.from('org_members')
    .upsert({ org_id: orgId, user_id: userId, role: 'member', email }, { onConflict: 'org_id,user_id', ignoreDuplicates: true })
    .select(MEMBER_COLUMNS);
  if (error) throw error;
  if (data.length) return data[0] as OrgMember;
  // 已經是成員（ignoreDuplicates 不回傳列）
  const { data: current, error: currentError } = await db.from('org_members').select(MEMBER_COLUMNS).eq('org_id', orgId).eq('user_id', userId).single();
  if (currentError) throw currentError;
  return current as OrgMember;
}

export async function listMyInvitations(db: Db, email: string): Promise<MyInvitation[]> {
  const { data, error } = await db.from('org_invitations')
    .select('id, org_id, invited_by, expires_at, org:organizations(name)')
    .eq('email', normalizeEmail(email)).eq('status', 'invited').gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false });
  if (error) throw error;
  const rows = data as unknown as { id: string; org_id: string; invited_by: string; expires_at: string; org: { name: string } }[];
  if (!rows.length) return [];

  const { data: inviters, error: inviterError } = await db.from('org_members').select('org_id, user_id, email').in('org_id', rows.map((r) => r.org_id));
  if (inviterError) throw inviterError;
  const emailOf = (orgId: string, userId: string) => inviters.find((m) => m.org_id === orgId && m.user_id === userId)?.email ?? '';
  return rows.map((r) => ({ id: r.id, org_id: r.org_id, org_name: r.org.name, invited_by_email: emailOf(r.org_id, r.invited_by), expires_at: r.expires_at }));
}

/** 只有收件的 email 看得到這份邀請；不是給自己的一律當作不存在。 */
async function getOwnInvitation(db: Db, user: { email: string }, invitationId: string): Promise<InvitationRow> {
  const { data, error } = await db.from('org_invitations').select(INVITATION_COLUMNS).eq('id', invitationId).maybeSingle();
  if (error) throw error;
  if (!data || data.email !== normalizeEmail(user.email)) throw new HttpError(404, INVITATION_NOT_FOUND);
  return data as InvitationRow;
}

export async function acceptInvitation(db: Db, user: { id: string; email: string }, invitationId: string): Promise<{ joined: boolean }> {
  const inv = await getOwnInvitation(db, user, invitationId);
  if (inv.status !== 'invited') throw new HttpError(404, INVITATION_NOT_FOUND);
  if (isExpired(inv)) throw new HttpError(410, '邀請已過期，請對方重新邀請');

  if (!inv.needs_approval) {
    await addMember(db, inv.org_id, user.id, inv.email);
    const { error } = await db.from('org_invitations').delete().eq('id', invitationId);
    if (error) throw error;
    return { joined: true };
  }
  const { error } = await db.from('org_invitations').update({ status: 'accepted', accepted_user_id: user.id }).eq('id', invitationId);
  if (error) throw error;
  return { joined: false };
}

export async function declineInvitation(db: Db, user: { id: string; email: string }, invitationId: string): Promise<void> {
  const inv = await getOwnInvitation(db, user, invitationId);
  const { error } = await db.from('org_invitations').delete().eq('id', inv.id);
  if (error) throw error;
}

async function assertNotLastAdmin(db: Db, orgId: string, targetUserId: string): Promise<void> {
  const { count, error } = await db.from('org_members').select('user_id', { count: 'exact', head: true })
    .eq('org_id', orgId).eq('role', 'admin').neq('user_id', targetUserId);
  if (error) throw error;
  if (!count) throw new HttpError(409, LAST_ADMIN);
}

async function getMember(db: Db, orgId: string, userId: string): Promise<OrgMember> {
  const { data, error } = await db.from('org_members').select(MEMBER_COLUMNS).eq('org_id', orgId).eq('user_id', userId).maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, '找不到這位成員');
  return data as OrgMember;
}

export async function setMemberRole(db: Db, userId: string, orgId: string, targetUserId: string, role: OrgRole): Promise<OrgMember> {
  await requireAdmin(db, userId, orgId);
  const target = await getMember(db, orgId, targetUserId);
  if (target.role === 'admin' && role === 'member') await assertNotLastAdmin(db, orgId, targetUserId);
  const { data, error } = await db.from('org_members').update({ role }).eq('org_id', orgId).eq('user_id', targetUserId).select(MEMBER_COLUMNS).single();
  if (error) throw error;
  return data as OrgMember;
}

export async function removeMember(db: Db, userId: string, orgId: string, targetUserId: string): Promise<void> {
  if (userId === targetUserId) await requireMember(db, userId, orgId);
  else await requireAdmin(db, userId, orgId);
  const target = await getMember(db, orgId, targetUserId);
  if (target.role === 'admin') await assertNotLastAdmin(db, orgId, targetUserId);
  const { error } = await db.from('org_members').delete().eq('org_id', orgId).eq('user_id', targetUserId);
  if (error) throw error;
}
