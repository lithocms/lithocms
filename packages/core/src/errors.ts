// Typed domain errors. Mapped to HTTP and MCP errors in one place at each boundary.

export interface Issue {
  path: (string | number)[];
  message: string;
}

export abstract class DomainError extends Error {
  abstract readonly code: 'not_found' | 'forbidden' | 'conflict' | 'validation_failed';
}

export class NotFound extends DomainError {
  readonly code = 'not_found';
  override name = 'NotFound';
}

export class Forbidden extends DomainError {
  readonly code = 'forbidden';
  override name = 'Forbidden';
}

export class Conflict extends DomainError {
  readonly code = 'conflict';
  override name = 'Conflict';
}

export class ValidationFailed extends DomainError {
  readonly code = 'validation_failed';
  override name = 'ValidationFailed';
  constructor(
    readonly issues: Issue[],
    message = issues
      .map((i) => (i.path.length ? `${i.path.join('.')}: ` : '') + i.message)
      .join('; '),
  ) {
    super(message);
  }
}
