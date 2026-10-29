import { DomainError, ValidationFailed } from '@lithocms/core';
import { z } from 'zod';
import { RateLimited } from './context.js';

export interface ToolResult {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

const json = (value: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
});

/** Parses a value the tool schema cannot express (e.g. Markdown) into a typed one. */
export function parse<S extends z.ZodType>(schema: S, value: unknown, path: string): z.output<S> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new ValidationFailed(
    parsed.error.issues.map((i) => ({ path: [path, ...i.path.map(String)], message: i.message })),
  );
}

/**
 * Wraps a tool body: its value becomes JSON text; domain errors become tool errors with a
 * stable `code` (MCP_SPEC.md) Claude can act on. Anything else is a bug and propagates.
 */
export function tool<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A): Promise<ToolResult> => {
    try {
      return json(await fn(args));
    } catch (e) {
      if (e instanceof DomainError || e instanceof RateLimited) {
        return {
          ...json({
            code: e.code,
            message: e.message,
            ...(e instanceof ValidationFailed ? { issues: e.issues } : {}),
          }),
          isError: true,
        };
      }
      throw e;
    }
  };
}
