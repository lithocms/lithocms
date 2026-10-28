import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Tx } from '../db/client.js';
import { FIELD_TYPES, media, posts, terms, type FieldDef } from '../db/schema.js';
import { ValidationFailed } from '../errors.js';
import { DocInput } from './input.js';

// Field schemas describe structured data (collection entries, term meta): a flat list of typed
// fields, no nested objects and no arbitrary JSON (DATA_MODEL.md, flexibility layer).

const Label = z.union([
  z.string().trim().min(1).max(200),
  z.record(z.string().regex(/^[a-z]{2}$/), z.string().trim().min(1).max(200)),
]);

const FieldDefInput = z
  .strictObject({
    key: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,63}$/, 'Expected a snake_case key')
      .refine((k) => k !== 'id', '`id` is reserved for the entry id'),
    label: Label,
    type: z.enum(FIELD_TYPES),
    required: z.boolean().optional(),
    options: z
      .array(z.strictObject({ value: z.string().min(1).max(200), label: Label.optional() }))
      .min(1)
      .max(100)
      .optional(),
  })
  .refine((f) => (f.type === 'select') === (f.options !== undefined), {
    message: '`options` is required for select fields and only allowed there',
  });

export const FieldList = z
  .array(FieldDefInput)
  .max(50)
  .refine((fields) => new Set(fields.map((f) => f.key)).size === fields.length, {
    message: 'Field keys must be unique',
  });

const Url = z
  .string()
  .max(2000)
  .regex(/^(?:https?:\/\/[^\s]+|\/(?![/\\])[^\s\\]*)$/, 'Use a full http(s) URL or a /path');

const Reference = z.strictObject({ kind: z.enum(['post', 'term']), id: z.uuid() });
export type Reference = z.infer<typeof Reference>;

function valueSchema(field: FieldDef): z.ZodType {
  switch (field.type) {
    case 'text':
      return z.string().max(5000);
    case 'richtext':
      return DocInput;
    case 'number':
      return z.number().finite();
    case 'select':
      return z.enum((field.options ?? []).map((o) => o.value) as [string, ...string[]]);
    case 'image':
      return z.uuid();
    case 'url':
      return Url;
    case 'date':
      return z.union([z.iso.date(), z.iso.datetime({ offset: true })]);
    case 'boolean':
      return z.boolean();
    case 'reference':
      return Reference;
  }
}

/** Validates `data` against `fields`; unknown keys are rejected. */
export function parseFieldData(fields: FieldDef[], data: unknown): Record<string, unknown> {
  const shape = Object.fromEntries(
    fields.map((f) => {
      const value = valueSchema(f);
      return [f.key, f.required ? value : value.nullable().optional()];
    }),
  );
  const parsed = z
    .strictObject(shape)
    .refine((d) => JSON.stringify(d).length <= 100_000, 'Data is larger than 100 KB')
    .safeParse(data);
  if (!parsed.success) {
    throw new ValidationFailed(
      parsed.error.issues.map((i) => ({
        path: ['data', ...i.path.map(String)],
        message: i.message,
      })),
    );
  }
  return parsed.data;
}

/** Images and references in `data` must exist in this site. */
export async function checkFieldRefs(
  tx: Tx,
  siteId: string,
  fields: FieldDef[],
  data: Record<string, unknown>,
): Promise<void> {
  const of = (type: FieldDef['type']) =>
    fields.filter((f) => f.type === type && data[f.key] != null);
  const images = of('image').map((f) => data[f.key] as string);
  const refs = of('reference').map((f) => data[f.key] as Reference);
  const ids = (kind: Reference['kind']) => refs.filter((r) => r.kind === kind).map((r) => r.id);
  const [foundImages, foundPosts, foundTerms] = await Promise.all([
    images.length
      ? tx
          .select({ id: media.id })
          .from(media)
          .where(and(eq(media.siteId, siteId), inArray(media.id, images)))
      : [],
    ids('post').length
      ? tx
          .select({ id: posts.id })
          .from(posts)
          .where(and(eq(posts.siteId, siteId), inArray(posts.id, ids('post'))))
      : [],
    ids('term').length
      ? tx
          .select({ id: terms.id })
          .from(terms)
          .where(and(eq(terms.siteId, siteId), inArray(terms.id, ids('term'))))
      : [],
  ]);
  const found = new Set([...foundImages, ...foundPosts, ...foundTerms].map((r) => r.id));
  const missing = [
    ...of('image').filter((f) => !found.has(data[f.key] as string)),
    ...of('reference').filter((f) => !found.has((data[f.key] as Reference).id)),
  ];
  if (missing.length) {
    throw new ValidationFailed(
      missing.map((f) => ({ path: ['data', f.key], message: 'Not found in this site' })),
    );
  }
}
