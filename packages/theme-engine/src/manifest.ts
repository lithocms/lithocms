import { z } from 'zod';

// `theme.json` and section `{% schema %}`: shared by the validator, the admin API and MCP.

const Label = z.union([
  z.string().min(1),
  z.record(z.string().regex(/^[a-z]{2}$/), z.string().min(1)),
]);
const Id = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, 'Expected a snake_case id');
const Key = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'Expected a lowercase key');
// Token values end up in a <style> block as custom properties, so they are an allowlist:
// colors, lengths and font lists, with a few CSS functions. No escapes, no url(), no `;{}`.
const CSS_FUNCTIONS = [
  'rgb',
  'rgba',
  'hsl',
  'hsla',
  'oklch',
  'oklab',
  'color-mix',
  'calc',
  'min',
  'max',
  'clamp',
  'var',
];
const CssValue = z
  .string()
  .max(200)
  .refine(
    (v) =>
      /^[\w\s#%.,()'"/+-]*$/.test(v) &&
      [...v.matchAll(/([a-z-]+)\s*\(/gi)].every((m) =>
        CSS_FUNCTIONS.includes((m[1] ?? '').toLowerCase()),
      ) &&
      (v.match(/"/g) ?? []).length % 2 === 0 &&
      (v.match(/'/g) ?? []).length % 2 === 0,
    'Use a color, length or font list',
  );

export const SETTING_TYPES = [
  'text',
  'textarea',
  'richtext',
  'boolean',
  'number',
  'select',
  'color',
  'image',
  'url',
  'font',
] as const;

export const Setting = z.strictObject({
  id: Id,
  type: z.enum(SETTING_TYPES),
  label: Label.optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  options: z.array(z.strictObject({ value: z.string(), label: Label.optional() })).optional(),
});

const Tokens = z.strictObject({
  colors: z.record(Key, CssValue).optional(),
  fonts: z.record(Key, CssValue).optional(),
  radius: CssValue.optional(),
  spacing: CssValue.optional(),
  content_width: CssValue.optional(),
});

export const ThemeManifest = z.strictObject({
  name: z.string().min(1).max(100),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'Expected a lowercase slug'),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/, 'Expected a semantic version'),
  author: z.string().max(100).optional(),
  license: z.string().max(50).optional(),
  engine: z.string().max(50).optional(),
  description: z.string().max(500).optional(),
  tokens: Tokens.optional(),
  dark_tokens: Tokens.optional(),
  settings: z.array(Setting).max(100).optional(),
  menus: z.array(z.strictObject({ location: Key, label: Label })).optional(),
  slots: z.array(z.strictObject({ key: Key, label: Label })).optional(),
  collections: z.array(Key).optional(),
  supports: z
    .strictObject({
      comments: z.boolean().optional(),
      search: z.boolean().optional(),
      dark_mode: z.boolean().optional(),
    })
    .optional(),
  page_templates: z
    .array(
      z.strictObject({
        key: z.string().regex(/^page\.[a-z0-9_-]+$/, 'Expected page.<name>'),
        label: Label,
        sections: z.boolean().optional(),
      }),
    )
    .optional(),
});
export type ThemeManifest = z.infer<typeof ThemeManifest>;

export const SectionSchema = z.strictObject({
  name: Label,
  settings: z.array(Setting).max(50).optional(),
  blocks: z
    .array(
      z.strictObject({
        type: Key,
        name: Label.optional(),
        settings: z.array(Setting).max(50).optional(),
      }),
    )
    .optional(),
  max_blocks: z.int().min(1).max(50).optional(),
});
export type SectionSchema = z.infer<typeof SectionSchema>;
