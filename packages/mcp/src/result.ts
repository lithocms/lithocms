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
 * Wraps tool bodies: a value becomes JSON text; domain errors become tool errors with a stable
 * `code` (MCP_SPEC.md) Claude can act on. Anything else is logged and answered with a generic
 * `internal` error, so server details never reach the client.
 */
export const toolFor =
  (logError: (err: unknown) => void) =>
  <A>(fn: (args: A) => Promise<unknown>) =>
  async (args: A): Promise<ToolResult> => {
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
      logError(e);
      return {
        ...json({ code: 'internal', message: 'Something went wrong on the server; try again' }),
        isError: true,
      };
    }
  };
