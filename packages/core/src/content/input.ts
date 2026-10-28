import { ContentFormatError, markdownToDoc, parseDoc, type Doc } from '@lithocms/content-format';
import { z } from 'zod';

// Zod schemas for content written through REST and MCP. One schema per boundary concept.

function reportContentErrors(e: unknown, ctx: z.RefinementCtx): typeof z.NEVER {
  if (!(e instanceof ContentFormatError)) throw e;
  for (const issue of e.issues)
    ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
  return z.NEVER;
}

/** ProseMirror JSON from the admin editor, checked against the content allowlist. */
export const DocInput = z.unknown().transform((value, ctx): Doc => {
  try {
    return parseDoc(value);
  } catch (e) {
    return reportContentErrors(e, ctx);
  }
});

/** Markdown from MCP clients (`guide://content-format`). */
export const MarkdownInput = z
  .string()
  .max(500_000)
  .transform((value, ctx): Doc => {
    try {
      return markdownToDoc(value);
    } catch (e) {
      return reportContentErrors(e, ctx);
    }
  });
