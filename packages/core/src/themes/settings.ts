import type { SectionSchema, Setting } from '@lithocms/theme-engine';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { audit, type Actor } from '../content/audit.js';
import { DocInput } from '../content/input.js';
import type { Tx } from '../db/client.js';
import { themeSettings, type SectionInstance } from '../db/schema.js';
import { Forbidden, ValidationFailed } from '../errors.js';
import { can } from '../permissions.js';

// Values for the `settings` a theme declares in theme.json (customizer) and in section schemas.

const COLOR = /^(?:#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([\d\s.,%/-]{1,60}\))$/i;
const FONT = /^[\w\s,'"-]{1,200}$/;
const URL_OR_PATH =
  /^(?:https?:\/\/[^\s]+|\/(?![/\\])[^\s\\]*|#[^\s]*|mailto:[^\s]+|tel:[+\d\s()-]+)$/;

/** The value type of one setting. */
export function settingSchema(def: Setting): z.ZodType {
  switch (def.type) {
    case 'text':
      return z.string().max(500);
    case 'textarea':
      return z.string().max(5000);
    case 'richtext':
      return DocInput;
    case 'boolean':
      return z.boolean();
    case 'number':
      return z.number().finite();
    case 'select':
      return z.enum((def.options ?? []).map((o) => o.value) as [string, ...string[]]);
    case 'color':
      return z.string().regex(COLOR, 'Use a hex, rgb() or hsl() color');
    case 'image':
      return z.uuid();
    case 'url':
      return z.string().max(2000).regex(URL_OR_PATH, 'Use a full http(s) URL or a /path');
    case 'font':
      return z.string().regex(FONT, 'Use a font family list');
  }
}

/** Validates values for `defs`; unknown keys are rejected, `null` clears a value. */
export function parseSettings(
  defs: Setting[],
  input: unknown,
  path = 'values',
): Record<string, unknown> {
  const shape = Object.fromEntries(defs.map((d) => [d.id, settingSchema(d).nullable().optional()]));
  const parsed = z.strictObject(shape).safeParse(input);
  if (!parsed.success) {
    throw new ValidationFailed(
      parsed.error.issues.map((i) => ({ path: [path, ...i.path.map(String)], message: i.message })),
    );
  }
  return Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v != null));
}

/**
 * Every setting with its stored value if still valid for its current type, else its default.
 * Stored values are only validated when saved, and themes change.
 */
export function effectiveSettings(
  defs: Setting[],
  values: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    defs.map((d) => {
      const stored = settingSchema(d).safeParse(values[d.id]);
      if (values[d.id] !== undefined && stored.success) return [d.id, stored.data];
      const fallback = d.default === undefined ? null : settingSchema(d).safeParse(d.default);
      return [d.id, fallback?.success ? fallback.data : null];
    }),
  );
}

export type StaticSection = Omit<SectionInstance, 'type'>;

/** Validates a section's settings and blocks against its schema. */
export function parseSection(schema: SectionSchema, input: unknown): StaticSection {
  const parsed = z
    .strictObject({
      settings: z.record(z.string(), z.unknown()).default({}),
      blocks: z
        .array(z.strictObject({ type: z.string(), settings: z.record(z.string(), z.unknown()) }))
        .max(schema.max_blocks ?? 50)
        .default([]),
    })
    .safeParse(input);
  if (!parsed.success) {
    throw new ValidationFailed(
      parsed.error.issues.map((i) => ({ path: i.path.map(String), message: i.message })),
    );
  }
  return {
    settings: parseSettings(schema.settings ?? [], parsed.data.settings, 'settings'),
    blocks: parsed.data.blocks.map((block, i) => {
      const def = schema.blocks?.find((b) => b.type === block.type);
      if (!def) {
        throw new ValidationFailed([
          { path: ['blocks', String(i), 'type'], message: 'Unknown block type' },
        ]);
      }
      return {
        type: block.type,
        settings: parseSettings(def.settings ?? [], block.settings, `blocks.${i}`),
      };
    }),
  };
}

/** A section with every setting filled in (stored if valid, else default); unknown blocks dropped. */
export function effectiveSection(
  schema: SectionSchema,
  data: Partial<StaticSection> | undefined,
): StaticSection {
  return {
    settings: effectiveSettings(schema.settings ?? [], data?.settings ?? {}),
    blocks: (data?.blocks ?? []).flatMap((block) => {
      const def = schema.blocks?.find((b) => b.type === block.type);
      return def
        ? [{ type: block.type, settings: effectiveSettings(def.settings ?? [], block.settings) }]
        : [];
    }),
  };
}

export interface StoredThemeSettings {
  values: Record<string, unknown>;
  sections: Record<string, StaticSection>;
}

export async function loadThemeSettings(
  tx: Tx,
  siteId: string,
  themeId: string,
): Promise<StoredThemeSettings> {
  const [row] = await tx
    .select({ values: themeSettings.values, sections: themeSettings.sections })
    .from(themeSettings)
    .where(and(eq(themeSettings.siteId, siteId), eq(themeSettings.themeId, themeId)));
  return row ?? { values: {}, sections: {} };
}

function assertThemeManager(actor: Actor) {
  if (!can(actor.role, 'theme.manage')) throw new Forbidden('Only admins can change the theme');
}

/** Replaces the site's values for a theme (customizer save). */
export async function updateThemeSettings(
  tx: Tx,
  siteId: string,
  actor: Actor,
  themeId: string,
  defs: Setting[],
  input: unknown,
): Promise<Record<string, unknown>> {
  assertThemeManager(actor);
  const values = parseSettings(defs, input);
  await tx
    .insert(themeSettings)
    .values({ siteId, themeId, values })
    .onConflictDoUpdate({
      target: [themeSettings.siteId, themeSettings.themeId],
      set: { values, updatedAt: new Date() },
    });
  await audit(tx, siteId, actor, {
    action: 'theme.settings.update',
    entityType: 'theme_settings',
    entityId: themeId,
    diff: { changed: Object.keys(values).sort() },
  });
  return values;
}

/** Replaces the stored content of one static section. */
export async function updateThemeSection(
  tx: Tx,
  siteId: string,
  actor: Actor,
  themeId: string,
  name: string,
  schema: SectionSchema,
  input: unknown,
): Promise<StaticSection> {
  assertThemeManager(actor);
  const section = parseSection(schema, input);
  const patch = { [name]: section };
  await tx
    .insert(themeSettings)
    .values({ siteId, themeId, sections: patch })
    .onConflictDoUpdate({
      target: [themeSettings.siteId, themeSettings.themeId],
      set: {
        sections: sql`${themeSettings.sections} || ${JSON.stringify(patch)}::jsonb`,
        updatedAt: new Date(),
      },
    });
  await audit(tx, siteId, actor, {
    action: 'theme.section.update',
    entityType: 'theme_settings',
    entityId: themeId,
    diff: { section: name },
  });
  return section;
}
