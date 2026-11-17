import { describe, expect, it } from 'vitest';
import { AppError } from '../src/lib/errors';
import { isDeadlock, toAppError, withDeadlockRetry } from '../src/lib/db-errors';

// The shape Prisma produced in the real failure (see the 40P01 deadlock log).
const deadlock = () =>
  new Error('Error occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "40P01", message: "deadlock detected", severity: "ERROR" }), transient: false })');

describe('isDeadlock', () => {
  it('recognises the Postgres deadlock code and Prisma P2034, nothing else', () => {
    expect(isDeadlock(deadlock())).toBe(true);
    expect(isDeadlock(Object.assign(new Error('write conflict'), { code: 'P2034' }))).toBe(true);
    expect(isDeadlock(new Error('exclusion violation 23P01 participant_no_overlap'))).toBe(false);
    expect(isDeadlock(new AppError(409, 'X', 'y'))).toBe(false);
    expect(isDeadlock('deadlock detected')).toBe(false);
    // free text that merely mentions it (e.g. an echoed user value) is not a deadlock
    expect(isDeadlock(new Error('Unique constraint failed on title "deadlock detected 40P01"'))).toBe(false);
  });

  it('maps a deadlock that survives the retries to a clean 409', () => {
    expect(toAppError(deadlock())).toMatchObject({ status: 409, code: 'CONCURRENT_CONFLICT' });
  });
});

describe('withDeadlockRetry', () => {
  it('re-runs the whole function after a deadlock and returns its result', async () => {
    let calls = 0;
    const result = await withDeadlockRetry(async () => {
      calls++;
      if (calls < 3) throw deadlock();
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('is bounded: gives up after 3 attempts and throws the original error', async () => {
    let calls = 0;
    const err = deadlock();
    await expect(
      withDeadlockRetry(async () => {
        calls++;
        throw err;
      }),
    ).rejects.toBe(err);
    expect(calls).toBe(3);
  });

  it('never retries other errors and preserves them untouched', async () => {
    for (const err of [new AppError(409, 'SCHEDULE_CONFLICT', 'x'), new Error('participant_no_overlap'), new Error('boom')]) {
      let calls = 0;
      await expect(
        withDeadlockRetry(async () => {
          calls++;
          throw err;
        }),
      ).rejects.toBe(err);
      expect(calls).toBe(1);
    }
  });
});
