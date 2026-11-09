import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpError } from '@/lib/http';
import {
  acceptInvitation, approveInvitation, createOrg, getMembership, getOrgDetail, invite, listMyInvitations,
  listMyOrgs, removeMember, revokeInvitation, setMemberRole, updateOrg,
} from '@/lib/services/orgs';
import { createTemplate, publishTemplate } from '@/lib/services/templates';
import { seedUser, testDb } from './helpers';

const db = testDb();
type U = { id: string; email: string };

async function rejects(p: Promise<unknown>, status: number, message: string) {
  const e = await p.then(() => null, (err) => err);
  expect(e).toBeInstanceOf(HttpError);
  expect(e.status).toBe(status);
  expect(e.message).toBe(message);
}

async function invited(orgId: string, who: U, inviterId: string) {
  await invite(db, inviterId, orgId, who.email);
  return (await listMyInvitations(db, who.email)).find((i) => i.org_id === orgId)!;
}

/** 管理員邀請、對方接受後直接加入 */
async function join(orgId: string, who: U, adminId: string) {
  await acceptInvitation(db, who, (await invited(orgId, who, adminId)).id);
}

async function publishedOrgTemplate(orgId: string, creatorId: string) {
  const t = await createTemplate(db, creatorId, {
    name: '組織顧問', description: '內部', category: '金融', system_prompt: '內部方法', mcp_servers: [], org_id: orgId,
  });
  return publishTemplate(db, creatorId, t.id);
}

async function deleteAccount(userId: string) {
  const { error } = await db.auth.admin.deleteUser(userId);
  if (error) throw error;
}

async function templateRow(id: string) {
  const { data, error } = await db.from('agent_templates').select('creator_id, status').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

describe('組織', () => {
  let admin: U, member: U, outsider: U, x: U, y: U;
  let orgId: string;

  beforeAll(async () => {
    [admin, member, outsider, x, y] = await Promise.all([seedUser(db), seedUser(db), seedUser(db), seedUser(db), seedUser(db)]);
    orgId = (await createOrg(db, admin, { name: '測試組織' })).id;
    // 把 member 加進去：管理員邀請、對方接受
    const inv = await invited(orgId, member, admin.id);
    await acceptInvitation(db, member, inv.id);
  });

  afterAll(async () => {
    await db.from('organizations').delete().eq('id', orgId);
  });

  it('建立組織的人是管理員', async () => {
    const mine = await listMyOrgs(db, admin.id);
    const org = mine.find((o) => o.id === orgId)!;
    expect(org.role).toBe('admin');
    expect(org.require_template_approval).toBe(false);
    await rejects(getOrgDetail(db, outsider.id, orgId), 404, '找不到這個組織');
  });

  it('成員邀請要管理員核准、管理員邀請直接加入', async () => {
    const inv = await invited(orgId, x, member.id);
    expect(await acceptInvitation(db, x, inv.id)).toEqual({ joined: false });
    expect(await getMembership(db, x.id, orgId)).toBeNull();
    await approveInvitation(db, admin.id, orgId, inv.id);
    expect(await getMembership(db, x.id, orgId)).toBe('member');

    const inv2 = await invited(orgId, y, admin.id);
    expect(await acceptInvitation(db, y, inv2.id)).toEqual({ joined: true });
    expect(await getMembership(db, y.id, orgId)).toBe('member');
  });

  it('管理員被移出後，他發出的邀請要改由管理員核准', async () => {
    const [b, z] = await Promise.all([seedUser(db), seedUser(db)]);
    await acceptInvitation(db, b, (await invited(orgId, b, admin.id)).id);
    await setMemberRole(db, admin.id, orgId, b.id, 'admin');
    const inv = await invited(orgId, z, b.id);
    await removeMember(db, admin.id, orgId, b.id);
    expect(await acceptInvitation(db, z, inv.id)).toEqual({ joined: false });
    expect(await getMembership(db, z.id, orgId)).toBeNull();
    await approveInvitation(db, admin.id, orgId, inv.id);
    expect(await getMembership(db, z.id, orgId)).toBe('member');
  });

  it('邀請 email 不分大小寫與前後空白', async () => {
    const z = await seedUser(db);
    await invite(db, admin.id, orgId, ' ' + z.email.toUpperCase() + ' ');
    expect((await listMyInvitations(db, z.email)).some((i) => i.org_id === orgId)).toBe(true);
  });

  it('重複邀請與邀請成員回 409', async () => {
    const z = await seedUser(db);
    await invite(db, admin.id, orgId, z.email);
    await rejects(invite(db, admin.id, orgId, z.email), 409, '已經邀請過這個 email');
    await rejects(invite(db, admin.id, orgId, member.email), 409, '這個人已經是成員');
  });

  it('過期的邀請不能接受', async () => {
    const z = await seedUser(db);
    const inv = await invited(orgId, z, admin.id);
    await db.from('org_invitations').update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq('id', inv.id);
    expect((await listMyInvitations(db, z.email)).some((i) => i.id === inv.id)).toBe(false);
    await rejects(acceptInvitation(db, z, inv.id), 410, '邀請已過期，請對方重新邀請');
    const again = await invite(db, admin.id, orgId, z.email);
    expect(again.expired).toBe(false);
  });

  it('別人不能接受不是給自己的邀請', async () => {
    const z = await seedUser(db);
    const inv = await invited(orgId, z, admin.id);
    await rejects(acceptInvitation(db, outsider, inv.id), 404, '找不到這份邀請');
  });

  it('一般成員只看得到自己發的邀請、不能核准或改設定', async () => {
    const a = await seedUser(db);
    const b = await seedUser(db);
    await invite(db, admin.id, orgId, a.email);
    const mine = await invite(db, member.id, orgId, b.email);
    const detail = await getOrgDetail(db, member.id, orgId);
    expect(detail.invitations.map((i) => i.id)).toEqual([mine.id]);
    expect(mine.needs_approval).toBe(true);
    expect(mine.invited_by_email).toBe(member.email);
    await rejects(approveInvitation(db, member.id, orgId, mine.id), 403, '只有管理員可以這樣做');
    await rejects(updateOrg(db, member.id, orgId, { name: '改名' }), 403, '只有管理員可以這樣做');
    const updated = await updateOrg(db, admin.id, orgId, { require_template_approval: true });
    expect(updated.require_template_approval).toBe(true);
  });

  it('撤回邀請', async () => {
    const a = await seedUser(db);
    const inv = await invite(db, member.id, orgId, a.email);
    const other = await seedUser(db);
    const inv2 = await invited(orgId, other, admin.id);
    await acceptInvitation(db, other, inv2.id); // other 成為一般成員
    await rejects(revokeInvitation(db, other.id, orgId, inv.id), 403, '只有管理員可以這樣做');
    await revokeInvitation(db, member.id, orgId, inv.id);
    expect((await listMyInvitations(db, a.email)).length).toBe(0);
    await rejects(revokeInvitation(db, member.id, orgId, inv.id), 404, '找不到這份邀請');
  });

  it('最後一位管理員不能退出或降級', async () => {
    const o = await createOrg(db, outsider, { name: '另一個' });
    const m = await seedUser(db);
    const inv = await invited(o.id, m, outsider.id);
    await acceptInvitation(db, m, inv.id);
    const msg = '組織至少要有一位管理員，請先指定另一位管理員';
    await rejects(removeMember(db, outsider.id, o.id, outsider.id), 409, msg);
    await rejects(setMemberRole(db, outsider.id, o.id, outsider.id, 'member'), 409, msg);
    await setMemberRole(db, outsider.id, o.id, m.id, 'admin');
    await removeMember(db, outsider.id, o.id, outsider.id);
    expect(await getMembership(db, outsider.id, o.id)).toBeNull();
    await db.from('organizations').delete().eq('id', o.id);
  });

  it('成員可以自己退出、管理員可以移出', async () => {
    const a = await seedUser(db);
    const b = await seedUser(db);
    const c = await seedUser(db);
    for (const u of [a, b, c]) await acceptInvitation(db, u, (await invited(orgId, u, admin.id)).id);
    await removeMember(db, a.id, orgId, a.id);
    expect(await getMembership(db, a.id, orgId)).toBeNull();
    await removeMember(db, admin.id, orgId, b.id);
    expect(await getMembership(db, b.id, orgId)).toBeNull();
    await rejects(removeMember(db, c.id, orgId, member.id), 403, '只有管理員可以這樣做');
  });

  // 組織與留下的範本由 global-setup 清掉：刪到最後一位管理員時範本跟著刪，組織才刪得掉
  it('建立者刪帳號時，組織顧問轉給最早加入的管理員', async () => {
    const [a, b, c] = await Promise.all([seedUser(db), seedUser(db), seedUser(db)]);
    const o = await createOrg(db, a, { name: '轉移' });
    expect(o.creator_deleted_action).toBe('transfer');
    await join(o.id, b, a.id);
    await join(o.id, c, a.id);
    await setMemberRole(db, a.id, o.id, b.id, 'admin');
    const t = await publishedOrgTemplate(o.id, c.id);
    await deleteAccount(c.id);
    expect(await templateRow(t.id)).toEqual({ creator_id: a.id, status: 'published' });
  });

  it('設定為跟著刪除時，組織顧問一起刪掉', async () => {
    const [a, m] = await Promise.all([seedUser(db), seedUser(db)]);
    const o = await createOrg(db, a, { name: '跟著刪除' });
    expect((await updateOrg(db, a.id, o.id, { creator_deleted_action: 'delete' })).creator_deleted_action).toBe('delete');
    await join(o.id, m, a.id);
    const t = await publishedOrgTemplate(o.id, m.id);
    await deleteAccount(m.id);
    expect(await templateRow(t.id)).toBeNull();
  });

  it('沒有其他管理員時一律刪除', async () => {
    const [a, m] = await Promise.all([seedUser(db), seedUser(db)]);
    const o = await createOrg(db, a, { name: '唯一管理員' });
    await join(o.id, m, a.id);
    const t = await publishedOrgTemplate(o.id, a.id);
    await deleteAccount(a.id);
    expect(await templateRow(t.id)).toBeNull();
    // 建立者已刪，created_by 變成 null，global-setup 找不到這個組織
    await db.from('organizations').delete().eq('id', o.id);
  });

  it('建立與修改組織可以設定這個選項', async () => {
    const [a, m] = await Promise.all([seedUser(db), seedUser(db)]);
    const o = await createOrg(db, a, { name: '設定', creator_deleted_action: 'delete' });
    expect(o.creator_deleted_action).toBe('delete');
    const { data, error } = await db.from('organizations').select('creator_deleted_action').eq('id', o.id).single();
    if (error) throw error;
    expect(data.creator_deleted_action).toBe('delete');
    await join(o.id, m, a.id);
    await rejects(updateOrg(db, m.id, o.id, { creator_deleted_action: 'transfer' }), 403, '只有管理員可以這樣做');
    await db.from('organizations').delete().eq('id', o.id);
  });
});
