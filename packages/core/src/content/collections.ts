import { and, asc, desc, eq, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Tx } from '../db/client.js';
import {
  COLLECTION_SORT_MODES,
  collectionEntries,
  collections,
  ENTRY_STATUSES,
  fieldSchemas,
  type FieldDef,
} from '../db/schema.js';
import { Conflict, Forbidden, NotFound } from '../errors.js';
import { can } from '../permissions.js';
import { audit, type Actor } from './audit.js';
import { checkFieldRefs, FieldList, parseFieldData } from './fields.js';

export const CollectionKey = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'Expected a lowercase key');

export const CollectionCreateInput = z.strictObject({
  key: CollectionKey,
  label: z.string().trim().min(1).max(200),
  sortMode: z.enum(COLLECTION_SORT_MODES).optional(),
  fields: FieldList,
});
export type CollectionCreateInput = z.output<typeof CollectionCreateInput>;

export const CollectionUpdateInput = CollectionCreateInput.omit({ key: true }).partial();
export type CollectionUpdateInput = z.output<typeof CollectionUpdateInput>;

export const EntryInput = z.strictObject({
  data: z.record(z.string(), z.unknown()),
  status: z.enum(ENTRY_STATUSES).optional(),
  sort: z.int().min(-100_000).max(100_000).optional(),
});
export type EntryInput = z.output<typeof EntryInput>;

export const EntryListQuery = z.strictObject({
  status: z.enum(ENTRY_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
export type EntryListQuery = z.output<typeof EntryListQuery>;

export type Collection = typeof collections.$inferSelect & { fields: FieldDef[] };
export type Entry = typeof collectionEntries.$inferSelect;

const target = (key: string) => `collection:${key}`;

function assertManage(actor: Actor) {
  if (!can(actor.role, 'collection.manage')) {
    throw new Forbidden('Only editors can manage collections');
  }
}

export async function listCollections(tx: Tx, siteId: string): Promise<Collection[]> {
  const [rows, schemas] = await Promise.all([
    tx
      .select()
      .from(collections)
      .where(eq(collections.siteId, siteId))
      .orderBy(asc(collections.key)),
    tx.select().from(fieldSchemas).where(eq(fieldSchemas.siteId, siteId)),
  ]);
  const fieldsOf = new Map(schemas.map((s) => [s.target, s.fields]));
  return rows.map((r) => ({ ...r, fields: fieldsOf.get(target(r.key)) ?? [] }));
}

export async function getCollection(tx: Tx, siteId: string, key: string): Promise<Collection> {
  const [row] = await tx
    .select()
    .from(collections)
    .where(and(eq(collections.siteId, siteId), eq(collections.key, key)));
  if (!row) throw new NotFound('Collection not found');
  const [schema] = await tx
    .select({ fields: fieldSchemas.fields })
    .from(fieldSchemas)
    .where(and(eq(fieldSchemas.siteId, siteId), eq(fieldSchemas.target, target(key))));
  return { ...row, fields: schema?.fields ?? [] };
}

export async function createCollection(
  tx: Tx,
  siteId: string,
  actor: Actor,
  input: CollectionCreateInput,
): Promise<Collection> {
  assertManage(actor);
  const [row] = await tx
    .insert(collections)
    .values({ siteId, key: input.key, label: input.label, sortMode: input.sortMode })
    .onConflictDoNothing()
    .returning();
  if (!row) throw new Conflict(`A collection with the key "${input.key}" exists`);
  await tx.insert(fieldSchemas).values({ siteId, target: target(input.key), fields: input.fields });
  await audit(tx, siteId, actor, {
    action: 'collection.create',
    entityType: 'collection',
    entityId: row.id,
    diff: { key: input.key, fields: input.fields.map((f) => f.key) },
  });
  return { ...row, fields: input.fields };
}

/**
 * Changing fields does not rewrite existing entries: values of removed fields stay stored but
 * are no longer rendered, and entries are validated against the new fields when next saved.
 */
export async function updateCollection(
  tx: Tx,
  siteId: string,
  actor: Actor,
  key: string,
  input: CollectionUpdateInput,
): Promise<Collection> {
  assertManage(actor);
  const current = await getCollection(tx, siteId, key);
  if (input.label !== undefined || input.sortMode !== undefined) {
    await tx
      .update(collections)
      .set({ label: input.label, sortMode: input.sortMode })
      .where(and(eq(collections.siteId, siteId), eq(collections.id, current.id)));
  }
  if (input.fields) {
    await tx
      .insert(fieldSchemas)
      .values({ siteId, target: target(key), fields: input.fields })
      .onConflictDoUpdate({
        target: [fieldSchemas.siteId, fieldSchemas.target],
        set: { fields: input.fields, updatedAt: new Date() },
      });
  }
  await audit(tx, siteId, actor, {
    action: 'collection.update',
    entityType: 'collection',
    entityId: current.id,
    diff: { changed: Object.keys(input).sort() },
  });
  return getCollection(tx, siteId, key);
}

export async function listEntries(
  tx: Tx,
  siteId: string,
  key: string,
  q: EntryListQuery,
): Promise<Entry[]> {
  const collection = await getCollection(tx, siteId, key);
  return entriesOf(
    tx,
    siteId,
    collection,
    q.status ? eq(collectionEntries.status, q.status) : undefined,
  )
    .limit(q.limit)
    .offset(q.offset);
}

export async function upsertEntry(
  tx: Tx,
  siteId: string,
  actor: Actor,
  key: string,
  id: string | undefined,
  input: EntryInput,
): Promise<Entry> {
  assertManage(actor);
  const collection = await getCollection(tx, siteId, key);
  const data = parseFieldData(collection.fields, input.data);
  await checkFieldRefs(tx, siteId, collection.fields, data);
  const values = { data, status: input.status, sort: input.sort };
  const [row] = id
    ? await tx
        .update(collectionEntries)
        .set({ ...values, updatedAt: new Date() })
        .where(
          and(
            eq(collectionEntries.siteId, siteId),
            eq(collectionEntries.collectionId, collection.id),
            eq(collectionEntries.id, id),
          ),
        )
        .returning()
    : await tx
        .insert(collectionEntries)
        .values({ siteId, collectionId: collection.id, ...values })
        .returning();
  if (!row) throw new NotFound('Entry not found');
  await audit(tx, siteId, actor, {
    action: id ? 'collection_entry.update' : 'collection_entry.create',
    entityType: 'collection_entry',
    entityId: row.id,
    diff: { collection: key, fields: Object.keys(data).sort() },
  });
  return row;
}

export async function deleteEntry(
  tx: Tx,
  siteId: string,
  actor: Actor,
  key: string,
  id: string,
): Promise<void> {
  assertManage(actor);
  const collection = await getCollection(tx, siteId, key);
  const [row] = await tx
    .delete(collectionEntries)
    .where(
      and(
        eq(collectionEntries.siteId, siteId),
        eq(collectionEntries.collectionId, collection.id),
        eq(collectionEntries.id, id),
      ),
    )
    .returning({ id: collectionEntries.id });
  if (!row) throw new NotFound('Entry not found');
  await audit(tx, siteId, actor, {
    action: 'collection_entry.delete',
    entityType: 'collection_entry',
    entityId: id,
    diff: { collection: key },
  });
}

/** A collection's entries in its own order. */
export function entriesOf(
  tx: Tx,
  siteId: string,
  collection: Pick<Collection, 'id' | 'sortMode'>,
  where?: SQL,
) {
  return tx
    .select()
    .from(collectionEntries)
    .where(
      and(
        eq(collectionEntries.siteId, siteId),
        eq(collectionEntries.collectionId, collection.id),
        where,
      ),
    )
    .orderBy(
      ...(collection.sortMode === 'manual'
        ? [asc(collectionEntries.sort), asc(collectionEntries.createdAt)]
        : [desc(collectionEntries.createdAt)]),
    )
    .$dynamic();
}
