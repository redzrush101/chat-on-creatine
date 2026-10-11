import type { PageResult } from '@shared/page-protocol';

type Failure = Extract<PageResult, { ok: false }>;
type FailureCode = NonNullable<Failure['code']>;

export class DriverError extends Error {
  readonly code: FailureCode;
  constructor(message: string, code: FailureCode) {
    super(message);
    this.code = code;
  }
}

export function fail(code: FailureCode, error: string): PageResult {
  return { ok: false, error, code };
}

