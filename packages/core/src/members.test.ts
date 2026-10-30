import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from './content/audit.js';
import { createDb, runMigrations, withSite, type Db, type Tx } from './db/client.js';
import { accounts, auditLog, memberships, sites, users, type Role } from './db/schema.js';
import { Conflict, Forbidden, NotFound } from './errors.js';
import {
  addMember,
  listMembers,
  MemberInviteInput,
  removeMember,
  updateMember,
} from './members.js';
import { startTestDatabase, type TestDatabase } from './testing/postgres.js';

let tdb: TestDatabase;
let db: Db;
let pool: Pool;
let siteA: string;
let siteB: string;
const ids: Record<string, string> = {};
const actor = (name: string, role: Role): Actor => ({ userId: ids[name]!, role, channel: 'admin' });
const inA = <T>(fn: (tx: Tx) => Promise<T>) => withSite(db, siteA, fn);

beforeAll(async () => {
  tdb = await startTestDatabase();
  await runMigrations(tdb.ownerUrl);
  ({ db, pool } = createDb(tdb.appUrl));
  const rows = await db
    .insert(sites)
    .values([{ name: 'A' }, { name: 'B' }])
    .returning();
  [siteA, siteB] = rows.map((r) => r.id) as [string, string];
  for (const name of ['owner', 'admin', 'admin2', 'editor', 'newcomer']) {
    const [u] = await db
      .insert(users)
      .values({ name, email: `${name}@example.com` })
      .returning();
    ids[name] = u!.id;
  }
  await db.insert(accounts).values(
    ['owner', 'admin', 'admin2', 'editor'].map((name) => ({
      userId: ids[name]!,
      accountId: ids[name]!,
      providerId: 'credential',
      password: 'x',
    })),
  );
  await db.insert(memberships).values([
    { siteId: siteA, userId: ids.owner!, role: 'owner' as const },
    { siteId: siteA, userId: ids.admin!, role: 'admin' as const },
    { siteId: siteA, userId: ids.admin2!, role: 'admin' as const },
    { siteId: siteA, userId: ids.editor!, role: 'editor' as const },
  ]);
}, 120_000);

afterAll(async () => {
  await pool.end();
  await tdb.stop();
});

describe('members', () => {
  it('normalizes the invited email and offers only roles below owner', () => {
    expect(MemberInviteInput.parse({ email: 'New@Example.COM', role: 'editor' }).email).toBe(
      'new@example.com',
    );
    expect(MemberInviteInput.safeParse({ email: 'x@example.com', role: 'owner' }).success).toBe(
      false,
    );
  });

  it('lists members with whether they have accepted', async () => {
    const editorView = await inA((tx) =>
      addMember(tx, siteA, actor('admin', 'admin'), ids.newcomer!, 'author'),
    );
    expect(editorView).toMatchObject({ role: 'author', pending: true });
    const list = await inA((tx) => listMembers(tx, siteA));
    expect(list.map((m) => [m.name, m.role, m.pending])).toEqual([
      ['admin', 'admin', false],
      ['admin2', 'admin', false],
      ['editor', 'editor', false],
      ['newcomer', 'author', true],
      ['owner', 'owner', false],
    ]);
    await expect(
      inA((tx) => addMember(tx, siteA, actor('admin', 'admin'), ids.newcomer!, 'editor')),
    ).rejects.toThrow(Conflict);
  });

  it('lets admins manage only members below them, and nobody themselves', async () => {
    const admin = actor('admin', 'admin');
    await expect(
      inA((tx) => updateMember(tx, siteA, admin, ids.editor!, { role: 'admin' })),
    ).rejects.toThrow(Forbidden);
    await expect(
      inA((tx) => updateMember(tx, siteA, admin, ids.admin2!, { role: 'editor' })),
    ).rejects.toThrow(Forbidden);
    await expect(inA((tx) => removeMember(tx, siteA, admin, ids.owner!))).rejects.toThrow(
      Forbidden,
    );
    await expect(
      inA((tx) => updateMember(tx, siteA, actor('owner', 'owner'), ids.owner!, { role: 'admin' })),
    ).rejects.toThrow(Forbidden);
    await expect(
      inA((tx) => addMember(tx, siteA, actor('editor', 'editor'), ids.newcomer!, 'author')),
    ).rejects.toThrow(Forbidden);

    expect(
      await inA((tx) => updateMember(tx, siteA, admin, ids.editor!, { role: 'author' })),
    ).toMatchObject({ role: 'author' });
    // The owner manages admins.
    expect(
      await inA((tx) =>
        updateMember(tx, siteA, actor('owner', 'owner'), ids.admin2!, { role: 'editor' }),
      ),
    ).toMatchObject({ role: 'editor' });
  });

  it('removes access on one site only, and audits every change', async () => {
    await expect(
      withSite(db, siteB, (tx) => removeMember(tx, siteB, actor('owner', 'owner'), ids.editor!)),
    ).rejects.toThrow(NotFound);
    await inA((tx) => removeMember(tx, siteA, actor('admin', 'admin'), ids.editor!));
    const list = await inA((tx) => listMembers(tx, siteA));
    expect(list.some((m) => m.userId === ids.editor)).toBe(false);
    const actions = await inA((tx) =>
      tx.select({ action: auditLog.action }).from(auditLog).orderBy(auditLog.createdAt),
    );
    expect(actions.map((a) => a.action)).toEqual([
      'member.add',
      'member.update',
      'member.update',
      'member.remove',
    ]);
  });
});
