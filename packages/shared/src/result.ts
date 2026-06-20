// Explicit Result type — the runtime never throws into a hot path (docs/08).

export interface Issue {
  code: string;
  message: string; // plain English, user-surfaceable
  path?: string; // e.g. 'N1*02' or 'shipment.consignee.name'
  detail?: unknown;
}

export type Result<T> =
  | { ok: true; value: T; warnings: Issue[] }
  | { ok: false; errors: Issue[] };

export function ok<T>(value: T, warnings: Issue[] = []): Result<T> {
  return { ok: true, value, warnings };
}

export function err<T = never>(errors: Issue[] | Issue): Result<T> {
  return { ok: false, errors: Array.isArray(errors) ? errors : [errors] };
}

export function isOk<T>(r: Result<T>): r is { ok: true; value: T; warnings: Issue[] } {
  return r.ok;
}

/** Map the success value, propagating errors unchanged. */
export function mapResult<T, U>(r: Result<T>, fn: (value: T) => U): Result<U> {
  return r.ok ? ok(fn(r.value), r.warnings) : r;
}
