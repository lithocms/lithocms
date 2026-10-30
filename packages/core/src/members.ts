import { and, asc, eq, exists, not } from 'drizzle-orm';
import { z } from 'zod';
import type { Tx } from './db/client.js';
import { accounts, memberships, ROLES, users, type Role } from './db/schema.js';
import { Conflict, Forbidden, NotFound } from './errors.js';
import { can } from './permissions.js';
import { audit, type Actor } from './content/audit.js';

/** Roles that can be given to a member; ownership moves only by transfer. */
const GRANTABLE = ['admin', 'editor', 'author'] as const;

export const MemberInviteInput = z.strictObject({
  email: z.email().max(254).toLowerCase(),
  name: z.string().trim().max(200).optional(),
  role: z.enum(GRANTABLE),
});
export type MemberInviteInput = z.output<typeof MemberInviteInput>;

export const MemberUpdateInput = z.strictObject({ role: z.enum(GRANTABLE) });
export type MemberUpdateInput = z.output<typeof MemberUpdateInput>;

export interface Member {
  userId: string;
  name: string;
  email: string;
  role: Role;
  twoFactorEnabled: boolean;
  /** No password yet: the invitation has not been accepted. */
  pending: boolean;
}

/** Higher outranks lower: owner 3 … author 0. */
const rank = (role: Role) => ROLES.length - 1 - ROLES.indexOf(role);

/**
 * Admins and the owner manage members, and only members ranked below them, with roles below
 * their own: an admin manages editors and authors, the owner also manages admins. No one
 * changes their own role.
 */
export function assertCanManage(actor: Actor, target: { userId?: string; role: Role }) {
  if (!can(actor.role, 'user.manage')) throw new Forbidden('Only admins can manage members');
  if (target.userId === actor.userId) throw new Forbidden('You cannot change your own membership');
  if (rank(target.role) >= rank(actor.role)) {
    throw new Forbidden(`Only an owner can give or change the ${target.role} role`);
  }
}

export function listMembers(tx: Tx, siteId: string): Promise<Member[]> {
  return tx
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      role: memberships.role,
      twoFactorEnabled: users.twoFactorEnabled,
      pending: not(
        exists(
          tx
            .select({ id: accounts.id })
            .from(accounts)
            .where(and(eq(accounts.userId, users.id), eq(accounts.providerId, 'credential'))),
        ),
      ).mapWith(Boolean),
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.siteId, siteId))
    .orderBy(asc(users.name), asc(users.email));
}

export async function getMember(tx: Tx, siteId: string, userId: string): Promise<Member> {
  const member = (await listMembers(tx, siteId)).find((m) => m.userId === userId);
  if (!member) throw new NotFound('Member not found');
  return member;
}

/** Gives an existing user a role on the site. Accounts themselves are made by the caller. */
export async function addMember(
  tx: Tx,
  siteId: string,
  actor: Actor,
  userId: string,
  role: Role,
): Promise<Member> {
  assertCanManage(actor, { userId, role });
  const [row] = await tx
    .insert(memberships)
    .values({ siteId, userId, role })
    .onConflictDoNothing()
    .returning();
  if (!row) throw new Conflict('Already a member of this site');
  await audit(tx, siteId, actor, {
    action: 'member.add',
    entityType: 'member',
    entityId: userId,
    diff: { role },
  });
  return getMember(tx, siteId, userId);
}

export async function updateMember(
  tx: Tx,
  siteId: string,
  actor: Actor,
  userId: string,
  input: MemberUpdateInput,
): Promise<Member> {
  const current = await getMember(tx, siteId, userId);
  assertCanManage(actor, current);
  assertCanManage(actor, { userId, role: input.role });
  await tx
    .update(memberships)
    .set({ role: input.role })
    .where(and(eq(memberships.siteId, siteId), eq(memberships.userId, userId)));
  await audit(tx, siteId, actor, {
    action: 'member.update',
    entityType: 'member',
    entityId: userId,
    diff: { role: [current.role, input.role] },
  });
  return { ...current, role: input.role };
}

/** Takes away the user's access to this site; their account and posts stay. */
export async function removeMember(
  tx: Tx,
  siteId: string,
  actor: Actor,
  userId: string,
): Promise<void> {
  const current = await getMember(tx, siteId, userId);
  assertCanManage(actor, current);
  await tx
    .delete(memberships)
    .where(and(eq(memberships.siteId, siteId), eq(memberships.userId, userId)));
  await audit(tx, siteId, actor, {
    action: 'member.remove',
    entityType: 'member',
    entityId: userId,
    diff: { role: current.role, email: current.email },
  });
}
