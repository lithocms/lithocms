export interface Issue {
  path: (string | number)[];
  message: string;
}

/** Content that is not valid Markdown/ProseMirror for LithoCMS. Core maps it to ValidationFailed. */
export class ContentFormatError extends Error {
  override name = 'ContentFormatError';
  constructor(readonly issues: Issue[]) {
    super(issues.map((i) => (i.path.length ? `${i.path.join('.')}: ` : '') + i.message).join('; '));
  }
}
