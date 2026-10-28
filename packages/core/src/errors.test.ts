import { describe, expect, it } from 'vitest';
import { DomainError, ValidationFailed } from './errors.js';

describe('ValidationFailed', () => {
  it('carries issues and a readable message', () => {
    const err = new ValidationFailed([
      { path: ['content', 2], message: 'Raw HTML is not allowed' },
      { path: [], message: 'Title is required' },
    ]);
    expect(err).toBeInstanceOf(DomainError);
    expect(err.code).toBe('validation_failed');
    expect(err.message).toBe('content.2: Raw HTML is not allowed; Title is required');
  });
});
