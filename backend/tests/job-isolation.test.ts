import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, startApp } from './helpers/client';
import { makeUser, matchBody, moveMatchTime, type TestUser } from './helpers/users';

let api: Awaited<ReturnType<typeof startApp>>;
let org: TestUser;

beforeAll(async () => {
  api = await startApp();
});
afterAll(async () => {
  await api.close();
  const { prisma } = await import('../src/lib/prisma');
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDb();
  org = await makeUser(api, 'org@example.com');
});

/** A match that is due to start (its start time has passed) but that no sweeper has touched. */
async function dueMatch(title: string, index: number) {
  const m = (await api.call('POST', '/api/v1/matches', matchBody({ title, startAt: new Date(Date.now() + (100 + index * 4) * 3_600_000).toISOString() }), org.token)).body.match.id as string;
  await moveMatchTime(m, -2, -0.5);
  return m;
}
const statusOf = async (id: string) => (await (await import('../src/lib/prisma')).prisma.match.findUniqueOrThrow({ where: { id } })).status;

describe('one failing job does not stop the others', () => {
  it('runIsolated reports the job that threw and still runs every other job', async () => {
    const { runIsolated } = await import('../src/jobs/match-lifecycle');
    const ran: string[] = [];
    const { counts, failed } = await runIsolated({
      first: async () => { ran.push('first'); return 3; },
      broken: async () => { ran.push('broken'); throw new Error('boom'); },
      last: async () => { ran.push('last'); return 5; },
    });
    expect(ran).toEqual(['first', 'broken', 'last']);
    expect(failed).toEqual(['broken']);
    expect(counts).toEqual({ first: 3, broken: 0, last: 5 });
  });

  it('runLifecycleJobs reports no failures when everything is healthy', async () => {
    const { runLifecycleJobs } = await import('../src/jobs/match-lifecycle');
    expect(await runLifecycleJobs()).toMatchObject({ failedJobs: [], failedRows: 0 });
  });
});

describe('one bad row does not block the others', () => {
  // A trigger that makes the update of ONE specific match fail, standing in for any unexpected data problem.
  const install = async () => {
    const { prisma } = await import('../src/lib/prisma');
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION audit_poison() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.title LIKE 'POISON%' AND NEW.status = 'IN_PROGRESS' THEN RAISE EXCEPTION 'poison row'; END IF; RETURN NEW; END $$`);
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS trg_audit_poison ON "match"`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER trg_audit_poison BEFORE UPDATE ON "match" FOR EACH ROW EXECUTE FUNCTION audit_poison()`);
  };
  const uninstall = async () => {
    const { prisma } = await import('../src/lib/prisma');
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS trg_audit_poison ON "match"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS audit_poison()`);
  };

  it('processes the healthy rows, skips the failing one, and does not retry it straight away', async () => {
    await install();
    try {
      const good1 = await dueMatch('Healthy game number one', 0);
      const bad = await dueMatch('POISON game that always fails', 1);
      const good2 = await dueMatch('Healthy game number two', 2);

      const { startDueMatches, runLifecycleJobs } = await import('../src/jobs/match-lifecycle');
      expect(await startDueMatches()).toBe(2);
      expect(await statusOf(good1)).toBe('IN_PROGRESS');
      expect(await statusOf(good2)).toBe('IN_PROGRESS');
      expect(await statusOf(bad)).toBe('OPEN'); // skipped, not lost

      // quarantined: the next runs do not keep hammering the same row, and nothing else is affected
      const again = await runLifecycleJobs();
      expect(again.started).toBe(0);
      expect(again.failedJobs).toEqual([]);
      expect(await statusOf(bad)).toBe('OPEN');
    } finally {
      await uninstall();
    }
  });

  it('a quarantined row is NOT lost: once the 10-minute cool-down has passed and the cause is fixed, it is processed', async () => {
    await install();
    try {
      const bad = await dueMatch('POISON game fixed later', 0);
      const { startDueMatches } = await import('../src/jobs/match-lifecycle');
      expect(await startDueMatches()).toBe(0); // fails, quarantined
      expect(await startDueMatches()).toBe(0); // still quarantined
      expect(await statusOf(bad)).toBe('OPEN');

      await uninstall(); // the data problem is repaired
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(Date.now() + 9 * 60_000);
        expect(await startDueMatches()).toBe(0); // 9 minutes: still cooling down
        vi.setSystemTime(Date.now() + 2 * 60_000);
        expect(await startDueMatches()).toBe(1); // 11 minutes: retried and started
      } finally {
        vi.useRealTimers();
      }
      expect(await statusOf(bad)).toBe('IN_PROGRESS');
    } finally {
      await uninstall();
    }
  });

  it('a failing row is counted in the run result', async () => {
    await install();
    try {
      await dueMatch('POISON again, different match', 0);
      const { runLifecycleJobs } = await import('../src/jobs/match-lifecycle');
      expect(await runLifecycleJobs()).toMatchObject({ started: 0, failedRows: 1, failedJobs: [] });
    } finally {
      await uninstall();
    }
  });
});

describe('work is taken in bounded batches', () => {
  it('a batch handles at most batchSize rows; later runs continue; maxBatches lets one run drain a backlog', async () => {
    for (let i = 0; i < 5; i++) await dueMatch(`Backlog game number ${i}`, i);
    const { startDueMatches } = await import('../src/jobs/match-lifecycle');
    expect(await startDueMatches({ batchSize: 2, maxBatches: 1 })).toBe(2);
    expect(await startDueMatches({ batchSize: 2, maxBatches: 1 })).toBe(2);
    expect(await startDueMatches({ batchSize: 2, maxBatches: 10 })).toBe(1);
    expect(await startDueMatches()).toBe(0);
  });

  it('closing unconfirmed matches and expiring offers use the same batches and stay idempotent', async () => {
    const { closeUnconfirmedMatches, expireStaleTeamOffers } = await import('../src/jobs/match-lifecycle');
    expect(await closeUnconfirmedMatches()).toBe(0);
    expect(await expireStaleTeamOffers()).toBe(0);
  });
});
