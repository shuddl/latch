// Typed errors. Surfaced to users as plain English, never as stack traces (CLAUDE.md §5).

export type LatchErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNSUPPORTED'
  | 'PARSE'
  | 'TRANSFORM'
  | 'CERTIFICATION'
  | 'CONNECTIVITY'
  | 'INTERNAL';

export class LatchError extends Error {
  readonly code: LatchErrorCode;
  readonly detail?: unknown;
  /** HTTP status to surface at the API boundary. */
  readonly status: number;

  constructor(code: LatchErrorCode, message: string, opts?: { detail?: unknown; status?: number }) {
    super(message);
    this.name = 'LatchError';
    this.code = code;
    this.detail = opts?.detail;
    this.status = opts?.status ?? defaultStatus(code);
  }

  /** API error envelope (docs/08): { error: { code, message, detail? } }. */
  toEnvelope(): { error: { code: LatchErrorCode; message: string; detail?: unknown } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.detail !== undefined ? { detail: this.detail } : {}),
      },
    };
  }
}

function defaultStatus(code: LatchErrorCode): number {
  switch (code) {
    case 'VALIDATION':
    case 'PARSE':
      return 400;
    case 'NOT_FOUND':
      return 404;
    case 'CONFLICT':
      return 409;
    case 'UNSUPPORTED':
      return 422;
    default:
      return 500;
  }
}
