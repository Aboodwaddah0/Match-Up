import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, startApp } from './helpers/client';
import { acceptChallenge, challenge, makeTeam, T, transferCaptaincy, type Team } from './helpers/teams';
import { makeUser, type TestUser } from './helpers/users';

/*
 * Accepting a challenge versus a change of the creator's eligibility (BIZ-02, D19 / B1), with REAL concurrent transactions:
 *  - the creator becomes ineligible BEFORE acceptance is serialized  -> 409 CHALLENGE_ORGANIZER_UNAVAILABLE, nothing created;
 *  - acceptance is serialized FIRST                                  -> the creator is the organizer, even if they leave right after.
 * "In flight" changes are held open in a second transaction (not yet committed); "acceptance first" is forced by slowing the match insert
 * of the acceptance with a temporary trigger, so the competing change really starts while acceptance holds its locks.
 */

let api: Awaited<ReturnType<typeof startApp>>;
let A: Team;
let B: Team;
let admin: TestUser;
let challengeId: string;

const A_ = '/api/v1/admin';
const prismaP = async () => (await import('../src/lib/prisma')).prisma;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

beforeAll(async () => {
  api = await startApp();
});
afterAll(async () => {
  await api.close();
  await (await prismaP()).$disconnect();
});
beforeEach(async () => {
  await resetDb();
  A = await makeTeam(api, 'a');
  B = await makeTeam(api, 'b');
  admin = await makeUser(api, 'admin@example.com');
  await (await prismaP()).user.update({ where: { id: admin.userId }, data: { platformRole: 'ADMIN' } });
  challengeId = (await challenge(api, A, A.captain, B)).body.challenge.id as string;
  expect((await transferCaptaincy(api, A, A.captain, A.vice)).status).toBe(200); // the creator A0 is a plain-role member now: free to leave
});

const creator = () => A.captain;
const matches = async () => (await prismaP()).match.findMany();
const challengeStatus = async (id = challengeId) => (await (await prismaP()).teamChallenge.findUniqueOrThrow({ where: { id } })).status;
const leave = () => api.call('POST', `${T}/${A.teamId}/leave`, {}, creator().token);
const suspend = () => api.call('POST', `${A_}/users/${creator().userId}/suspend`, {}, admin.token);

/** Runs `change` inside a transaction that stays OPEN until `release()`; resolves once the change has been executed (uncommitted). */
async function holdOpen(change: (tx: import('@prisma/client').Prisma.TransactionClient) => Promise<unknown>, outcome: 'commit' | 'rollback') {
  const prisma = await prismaP();
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  let entered!: () => void;
  const inside = new Promise<void>((r) => (entered = r));
  const finished = prisma
    .$transaction(
      async (tx) => {
        await change(tx);
        entered();
        await hold;
        if (outcome === 'rollback') throw new Error('rolled back on purpose');
      },
      { timeout: 30_000, maxWait: 10_000 },
    )
    .catch((e: Error) => {
      if (e.message !== 'rolled back on purpose') throw e;
    });
  await inside;
  return { release, finished };
}

async function slowMatchInserts(fn: () => Promise<void>) {
  const prisma = await prismaP();
  await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION race_test_slow() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.8); RETURN NEW; END $$`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER trg_race_test_slow BEFORE INSERT ON "match" FOR EACH ROW EXECUTE FUNCTION race_test_slow()`);
  try {
    await fn();
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS trg_race_test_slow ON "match"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS race_test_slow()`);
  }
}

const removeCreatorFromTeam = (tx: import('@prisma/client').Prisma.TransactionClient) =>
  tx.teamMember.delete({ where: { teamId_userId: { teamId: A.teamId, userId: creator().userId } } });
const suspendCreator = (tx: import('@prisma/client').Prisma.TransactionClient) => tx.user.update({ where: { id: creator().userId }, data: { status: 'SUSPENDED' } });

describe('the creator becomes ineligible BEFORE acceptance is serialized: 409 and nothing is created', () => {
  for (const [name, change] of [['leaving the team', removeCreatorFromTeam], ['being suspended', suspendCreator]] as const) {
    it(`${name} (still uncommitted when acceptance starts): acceptance waits, then is refused once the change commits`, async () => {
      const { release, finished } = await holdOpen(change, 'commit');
      let settled = false;
      const accepting = acceptChallenge(api, challengeId, B.captain).then((r) => {
        settled = true;
        return r;
      });
      await sleep(600);
      expect(settled).toBe(false); // it is queued behind the change, not racing past it with a stale view
      release();
      await finished;
      const res = await accepting;
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CHALLENGE_ORGANIZER_UNAVAILABLE');
      expect(await challengeStatus()).toBe('PENDING');
      expect(await matches()).toHaveLength(0);
    });

    it(`${name} that is rolled back: acceptance simply goes ahead and the creator is the organizer`, async () => {
      const { release, finished } = await holdOpen(change, 'rollback');
      let settled = false;
      const accepting = acceptChallenge(api, challengeId, B.captain).then((r) => {
        settled = true;
        return r;
      });
      await sleep(600);
      expect(settled).toBe(false);
      release();
      await finished;
      const res = await accepting;
      expect(res.status).toBe(200);
      expect((await matches())[0]!.organizerId).toBe(creator().userId);
    });
  }
});

describe('acceptance is serialized FIRST: the creator stays the organizer even if they leave or are suspended right after', () => {
  it('leaving the team starts while acceptance is in flight: it waits for acceptance, then goes through', async () => {
    await slowMatchInserts(async () => {
      let acceptDone = false;
      let leaveDone = false;
      const accepting = acceptChallenge(api, challengeId, B.captain).then((r) => ((acceptDone = true), r));
      await sleep(300); // acceptance has taken its locks and is now inside the slowed match insert
      const leaving = leave().then((r) => ((leaveDone = true), r));
      await sleep(300); // still inside the slowed insert: the leave has started but cannot complete
      expect(acceptDone).toBe(false);
      expect(leaveDone).toBe(false);
      expect(await (await prismaP()).teamMember.count({ where: { teamId: A.teamId, userId: creator().userId } })).toBe(1); // not removed yet
      const [a, l] = await Promise.all([accepting, leaving]);
      expect(a.status).toBe(200);
      expect(l.status).toBeLessThan(300);
    });
    const [match] = await matches();
    expect(match!.organizerId).toBe(creator().userId);
    expect(await (await prismaP()).teamMember.count({ where: { teamId: A.teamId, userId: creator().userId } })).toBe(0);
    expect(await challengeStatus()).toBe('ACCEPTED');
  });

  it('being suspended starts while acceptance is in flight: same ordering, the creator is still the organizer', async () => {
    await slowMatchInserts(async () => {
      let acceptDone = false;
      let suspendDone = false;
      const accepting = acceptChallenge(api, challengeId, B.captain).then((r) => ((acceptDone = true), r));
      await sleep(300);
      const suspending = suspend().then((r) => ((suspendDone = true), r));
      await sleep(300);
      expect(acceptDone).toBe(false);
      expect(suspendDone).toBe(false);
      expect((await (await prismaP()).user.findUniqueOrThrow({ where: { id: creator().userId } })).status).toBe('ACTIVE'); // not suspended yet
      const [a, s] = await Promise.all([accepting, suspending]);
      expect(a.status).toBe(200);
      expect(s.status).toBeLessThan(300);
    });
    expect((await matches())[0]!.organizerId).toBe(creator().userId);
    expect((await (await prismaP()).user.findUniqueOrThrow({ where: { id: creator().userId } })).status).toBe('SUSPENDED');
  });

  it('a captaincy transfer in flight does not block or confuse acceptance (the creator stays a member)', async () => {
    await slowMatchInserts(async () => {
      const accepting = acceptChallenge(api, challengeId, B.captain);
      await sleep(300);
      const transferring = transferCaptaincy(api, A, A.vice, A.members[2]!);
      const [a, t] = await Promise.all([accepting, transferring]);
      expect(a.status).toBe(200);
      expect(t.status).toBe(200);
    });
    expect((await matches())[0]!.organizerId).toBe(creator().userId);
  });
});

describe('every interleaving ends consistent and deadlock-free', () => {
  it('acceptance, the creator leaving, an admin suspension and a captaincy transfer fired together (several fresh rounds)', async () => {
    for (let round = 0; round < 3; round++) {
      const a = round === 0 ? A : await makeTeam(api, `x${round}`);
      const b = round === 0 ? B : await makeTeam(api, `y${round}`);
      const id = round === 0 ? challengeId : ((await challenge(api, a, a.captain, b)).body.challenge.id as string);
      const creatorUser = a.captain;
      if (round > 0) expect((await transferCaptaincy(api, a, a.captain, a.vice)).status).toBe(200);

      const results = await Promise.all([
        acceptChallenge(api, id, b.captain),
        api.call('POST', `${T}/${a.teamId}/leave`, {}, creatorUser.token),
        round % 2 === 0 ? api.call('POST', `${A_}/users/${creatorUser.userId}/suspend`, {}, admin.token) : transferCaptaincy(api, a, a.vice, a.members[2]!),
      ]);
      const [accepted, left, other] = results;
      for (const r of results) expect(r.status, JSON.stringify(r.body)).not.toBe(500);
      expect(left.status).toBeLessThan(300);
      expect(other.status).toBeLessThan(300);

      const prisma = await prismaP();
      if (accepted.status === 200) {
        expect((await prisma.match.findUniqueOrThrow({ where: { id: accepted.body.match.id } })).organizerId).toBe(creatorUser.userId);
        expect((await prisma.teamChallenge.findUniqueOrThrow({ where: { id } })).status).toBe('ACCEPTED');
      } else {
        expect(accepted.status).toBe(409);
        expect(accepted.body.error.code).toBe('CHALLENGE_ORGANIZER_UNAVAILABLE');
        expect((await prisma.teamChallenge.findUniqueOrThrow({ where: { id } })).status).toBe('PENDING');
        expect((await prisma.teamChallenge.findUniqueOrThrow({ where: { id } })).resultingMatchId).toBeNull();
      }
    }
  });
});
