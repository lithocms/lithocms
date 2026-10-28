import { and, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import sharp, { type Metadata, type Sharp } from 'sharp';
import { z } from 'zod';
import type { Tx } from '../db/client.js';
import { media, type MediaVariant } from '../db/schema.js';
import { Forbidden, NotFound, ValidationFailed } from '../errors.js';
import { can } from '../permissions.js';
import { audit, type Actor } from '../content/audit.js';
import type { MediaStore } from './store.js';

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_PIXELS = 50_000_000;
const WIDTHS = [400, 800, 1200, 1920];

// What we accept, by the format sharp detects in the bytes.
const FORMATS = {
  jpeg: { mime: 'image/jpeg', ext: 'jpg' },
  png: { mime: 'image/png', ext: 'png' },
  webp: { mime: 'image/webp', ext: 'webp' },
  gif: { mime: 'image/gif', ext: 'gif' },
  avif: { mime: 'image/avif', ext: 'avif' },
} as const;
type Format = keyof typeof FORMATS;

export const MediaUpdateInput = z.strictObject({
  alt: z.string().max(500).optional(),
  caption: z.string().max(2000).optional(),
});
export type MediaUpdateInput = z.output<typeof MediaUpdateInput>;

export const MediaListQuery = z.strictObject({
  query: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(30),
  cursor: z.string().max(200).optional(),
});
export type MediaListQuery = z.output<typeof MediaListQuery>;

export type Media = typeof media.$inferSelect;

export interface UploadInput {
  data: Buffer;
  filename: string;
  alt?: string;
  caption?: string;
}

/**
 * Stores an uploaded image: the format is sniffed from the bytes, the image is re-encoded
 * (orientation applied, metadata such as EXIF/GPS dropped) and WebP/AVIF variants are made.
 * TODO(phase-1): generate variants in a pg-boss job instead of during the request.
 */
export async function uploadMedia(
  tx: Tx,
  store: MediaStore,
  siteId: string,
  actor: Actor,
  input: UploadInput,
): Promise<Media> {
  if (!can(actor.role, 'media.upload')) throw new Forbidden('You cannot upload media');
  if (input.data.byteLength > MAX_UPLOAD_BYTES) throw invalid('File is larger than 20 MB');

  const meta = await sharp(input.data, { limitInputPixels: MAX_PIXELS })
    .metadata()
    .catch(() => {
      throw invalid('Not an image this site accepts (JPEG, PNG, WebP, GIF or AVIF)');
    });
  const format = detectFormat(meta);
  if (!format) {
    throw invalid(
      meta.format === 'heif'
        ? 'HEIC photos are not supported yet; export them as JPEG'
        : 'Not an image this site accepts (JPEG, PNG, WebP, GIF or AVIF)',
    );
  }
  const animated = (meta.pages ?? 1) > 1;
  const load = () => sharp(input.data, { limitInputPixels: MAX_PIXELS, animated }).rotate();

  const original = await encode(load(), format).toBuffer({ resolveWithObject: true });
  const width = original.info.width;
  // Animated images decode as one tall strip of frames; the frame height is what we want.
  const height = animated ? (meta.pageHeight ?? meta.height ?? 0) : original.info.height;

  const now = new Date();
  const stem = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}`;
  const path = `${stem}.${FORMATS[format].ext}`;
  await store.put(`${siteId}/${path}`, original.data);

  const variants: MediaVariant[] = [];
  for (const w of WIDTHS.filter((w) => w < width)) {
    for (const variantFormat of animated ? (['webp'] as const) : (['webp', 'avif'] as const)) {
      const resized = load().resize({ width: w });
      const data = await (
        variantFormat === 'webp'
          ? resized.webp({ quality: 78 })
          : resized.avif({ quality: 55, effort: 2 })
      ).toBuffer();
      const variantPath = `${stem}-${w}.${variantFormat}`;
      await store.put(`${siteId}/${variantPath}`, data);
      variants.push({ width: w, format: variantFormat, path: variantPath });
    }
  }

  const [row] = await tx
    .insert(media)
    .values({
      siteId,
      path,
      originalName: input.filename.slice(0, 255),
      mime: FORMATS[format].mime,
      size: original.data.byteLength,
      width,
      height,
      alt: input.alt ?? '',
      caption: input.caption ?? '',
      variants,
      uploadedBy: actor.userId,
    })
    .returning();
  await audit(tx, siteId, actor, {
    action: 'media.upload',
    entityType: 'media',
    entityId: row!.id,
    diff: { originalName: row!.originalName, mime: row!.mime, size: row!.size },
  });
  return row!;
}

export async function getMedia(tx: Tx, siteId: string, id: string): Promise<Media> {
  const [row] = await tx
    .select()
    .from(media)
    .where(and(eq(media.siteId, siteId), eq(media.id, id)));
  if (!row) throw new NotFound('Media not found');
  return row;
}

export async function listMedia(
  tx: Tx,
  siteId: string,
  q: MediaListQuery,
): Promise<{ items: Media[]; nextCursor: string | null }> {
  const pattern = q.query && `%${q.query.replace(/[\\%_]/g, '\\$&')}%`;
  const where: (SQL | undefined)[] = [
    eq(media.siteId, siteId),
    pattern ? or(ilike(media.originalName, pattern), ilike(media.alt, pattern)) : undefined,
  ];
  if (q.cursor) {
    const [at, id] = Buffer.from(q.cursor, 'base64url').toString().split('|');
    const date = new Date(at ?? '');
    if (Number.isNaN(date.getTime()) || !z.uuid().safeParse(id).success) {
      throw new ValidationFailed([{ path: ['cursor'], message: 'Invalid cursor' }]);
    }
    where.push(sql`(${media.createdAt}, ${media.id}) < (${date}, ${id})`);
  }
  const rows = await tx
    .select()
    .from(media)
    .where(and(...where))
    .orderBy(desc(media.createdAt), desc(media.id))
    .limit(q.limit + 1);
  const items = rows.slice(0, q.limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > q.limit && last
        ? Buffer.from(`${last.createdAt.toISOString()}|${last.id}`).toString('base64url')
        : null,
  };
}

export async function updateMedia(
  tx: Tx,
  siteId: string,
  actor: Actor,
  id: string,
  input: MediaUpdateInput,
): Promise<Media> {
  const current = await getMedia(tx, siteId, id);
  if (current.uploadedBy !== actor.userId && !can(actor.role, 'media.manage')) {
    throw new Forbidden('You can only edit media you uploaded');
  }
  const [row] = await tx
    .update(media)
    .set(input)
    .where(and(eq(media.siteId, siteId), eq(media.id, id)))
    .returning();
  await audit(tx, siteId, actor, {
    action: 'media.update',
    entityType: 'media',
    entityId: id,
    diff: { changed: Object.keys(input).sort() },
  });
  return row!;
}

/** Media rows by id, for rendering content and themes. */
export async function mediaByIds(
  tx: Tx,
  siteId: string,
  ids: string[],
): Promise<Map<string, Media>> {
  if (!ids.length) return new Map();
  const rows = await tx
    .select()
    .from(media)
    .where(and(eq(media.siteId, siteId), inArray(media.id, ids)));
  return new Map(rows.map((r) => [r.id, r]));
}

/** Public URL of a stored file, relative to the site origin. */
export const mediaUrl = (path: string) => `/media/${path}`;

/** `srcset` from the WebP variants plus the original. */
export function mediaSrcset(row: Media): string {
  return [
    ...row.variants
      .filter((v) => v.format === 'webp')
      .map((v) => `${mediaUrl(v.path)} ${v.width}w`),
    `${mediaUrl(row.path)} ${row.width}w`,
  ].join(', ');
}

function detectFormat(meta: Metadata): Format | undefined {
  if (meta.format === 'heif') return meta.compression === 'av1' ? 'avif' : undefined;
  return meta.format && meta.format in FORMATS ? (meta.format as Format) : undefined;
}

function encode(image: Sharp, format: Format): Sharp {
  switch (format) {
    case 'jpeg':
      return image.jpeg({ quality: 85, mozjpeg: true });
    case 'png':
      return image.png({ compressionLevel: 9 });
    case 'webp':
      return image.webp({ quality: 85 });
    case 'gif':
      return image.gif();
    case 'avif':
      return image.avif({ quality: 60, effort: 2 });
  }
}

function invalid(message: string): ValidationFailed {
  return new ValidationFailed([{ path: ['file'], message }]);
}
