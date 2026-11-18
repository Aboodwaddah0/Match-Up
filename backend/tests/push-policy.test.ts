import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPush, isPushType, KNOWN_TYPES, PUSH_POLICY, PUSH_TYPES, PUSH_TTL_SECONDS } from '../src/modules/notifications/push-policy';

/** The union as written in notify.ts, parsed from the source so the test cannot drift from it. */
function unionFromSource(): string[] {
  const src = readFileSync(path.resolve(__dirname, '../src/modules/notifications/notify.ts'), 'utf8');
  const block = src.slice(src.indexOf('export type NotificationType'), src.indexOf(';', src.indexOf('export type NotificationType')));
  return [...block.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]!);
}

const APPROVED_PUSH = [
  'MATCH_REQUEST_RECEIVED', 'MATCH_REQUEST_ACCEPTED', 'MATCH_REQUEST_REJECTED', 'MATCH_CANCELLED', 'MATCH_TIME_CHANGED', 'MATCH_INVITATION',
  'BOOKING_CONFIRMED', 'BOOKING_REJECTED', 'TEAM_INVITATION', 'CHALLENGE_RECEIVED', 'CHALLENGE_ACCEPTED',
];
const APPROVED_NO_PUSH = [
  'MATCH_PLAYER_LEFT', 'MATCH_REMOVED', 'MATCH_CLOSED_UNCONFIRMED', 'MATCH_VENUE_UNCONFIRMED', 'BOOKING_REQUEST_RECEIVED', 'BOOKING_CANCELLED',
  'BOOKING_EXPIRED', 'TEAM_INVITATION_ACCEPTED', 'TEAM_INVITATION_DECLINED', 'TEAM_MEMBER_REMOVED', 'TEAM_MEMBER_LEFT', 'TEAM_CAPTAIN_TRANSFERRED',
  'TEAM_ROSTER_ADDED', 'TEAM_ROSTER_REMOVED', 'CHALLENGE_REJECTED', 'CHALLENGE_CANCELLED', 'REVIEW_RECEIVED', 'REPORT_RESOLVED',
  'VENUE_SUSPENDED', 'VENUE_REACTIVATED',
];

describe('every notification type is classified (default-deny)', () => {
  it('the policy covers EXACTLY the types of the union in notify.ts: none missing, none extra', () => {
    const union = unionFromSource();
    expect(union).toHaveLength(31);
    expect(new Set(union).size).toBe(31);
    expect([...KNOWN_TYPES].sort()).toEqual([...union].sort());
  });

  it('11 types push, 20 do not, and the two lists are exactly the approved ones', () => {
    expect(PUSH_TYPES).toHaveLength(11);
    expect([...PUSH_TYPES].sort()).toEqual([...APPROVED_PUSH].sort());
    const noPush = KNOWN_TYPES.filter((t) => PUSH_POLICY[t as keyof typeof PUSH_POLICY] === 'NO_PUSH');
    expect(noPush).toHaveLength(20);
    expect([...noPush].sort()).toEqual([...APPROVED_NO_PUSH].sort());
    expect(PUSH_TYPES.length + noPush.length).toBe(unionFromSource().length);
  });

  it('reviews and report updates never push, and chat is not a notification type at all', () => {
    expect(isPushType('REVIEW_RECEIVED')).toBe(false);
    expect(isPushType('REPORT_RESOLVED')).toBe(false);
    expect(unionFromSource().some((t) => t.includes('CHAT') || t.includes('MESSAGE'))).toBe(false);
  });

  it('a value that is not in the policy is NOT pushed (the type column is a free string)', () => {
    for (const unknown of ['SOMETHING_NEW', '', 'match_cancelled', 'toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      expect(isPushType(unknown)).toBe(false);
      expect(buildPush({ notificationId: 'n1', type: unknown, params: {}, resourceType: null, resourceId: null }, 'ExponentPushToken[abcdefghij]', 'en')).toBeNull();
    }
  });
});

describe('what a push says', () => {
  const token = 'ExponentPushToken[abcdefghijklmn]';
  const src = (type: string, params: Record<string, unknown>) => ({ notificationId: '11111111-2222-4333-8444-555555555555', type, params, resourceType: 'match', resourceId: '99999999-2222-4333-8444-555555555555' });
  const PARAMS: Record<string, Record<string, unknown>> = {
    MATCH_REQUEST_RECEIVED: { title: 'Friday 7v7' }, MATCH_REQUEST_ACCEPTED: { title: 'Friday 7v7' }, MATCH_REQUEST_REJECTED: { title: 'Friday 7v7' },
    MATCH_CANCELLED: { title: 'Friday 7v7' }, MATCH_TIME_CHANGED: { title: 'Friday 7v7' }, MATCH_INVITATION: { title: 'Friday 7v7' },
    BOOKING_CONFIRMED: { venueName: 'Hebron Arena' }, BOOKING_REJECTED: { venueName: 'Hebron Arena' }, TEAM_INVITATION: { teamName: 'Eagles' },
    CHALLENGE_RECEIVED: { challengerName: 'Lions' }, CHALLENGE_ACCEPTED: { challengedName: 'Tigers' },
  };

  it.each(APPROVED_PUSH)('%s has an English and an Arabic text that use the available detail', (type) => {
    const en = buildPush(src(type, PARAMS[type]!), token, 'en')!;
    const ar = buildPush(src(type, PARAMS[type]!), token, 'ar')!;
    expect(en.title).toBeTruthy();
    expect(en.body).toBeTruthy();
    expect(ar.title).toMatch(/[؀-ۿ]/); // Arabic script
    expect(ar.body).toMatch(/[؀-ۿ]/);
    expect(en.title).not.toBe(ar.title);
    const detail = Object.values(PARAMS[type]!)[0] as string;
    expect(en.body).toContain(detail);
    expect(ar.body).toContain(detail);
  });

  it.each(APPROVED_PUSH)('%s falls back to a generic sentence when the detail is missing', (type) => {
    for (const locale of ['en', 'ar'] as const) {
      const m = buildPush(src(type, {}), token, locale)!;
      expect(m.body).toBeTruthy();
      expect(m.body).not.toMatch(/undefined|null|\{|\}/);
    }
  });

  it('the message carries the token, a stable payload, collapse keys and a 24 h ttl', () => {
    const m = buildPush(src('MATCH_CANCELLED', { title: 'Friday 7v7', reason: 'free text the organizer typed' }), token, 'en')!;
    expect(m).toMatchObject({ to: token, priority: 'high', sound: 'default', ttl: PUSH_TTL_SECONDS, collapseId: '11111111-2222-4333-8444-555555555555', tag: '11111111-2222-4333-8444-555555555555' });
    expect(PUSH_TTL_SECONDS).toBe(86_400);
    expect(m.data).toEqual({ type: 'MATCH_CANCELLED', notificationId: '11111111-2222-4333-8444-555555555555', resourceType: 'match', resourceId: '99999999-2222-4333-8444-555555555555' });
  });

  it('free text typed by users (cancel reasons, booking notes) and ids of other people never appear in a push', () => {
    const m = buildPush(src('BOOKING_REJECTED', { venueName: 'Hebron Arena', reason: 'call me on 0599-123-456', userId: 'someone-else', invitedBy: 'another' }), token, 'en')!;
    const text = JSON.stringify(m);
    expect(text).not.toContain('0599');
    expect(text).not.toContain('someone-else');
    expect(text).not.toContain('another');
  });

  it('a very long title is cut, so a payload can never approach the 4 KiB limit', () => {
    const m = buildPush(src('MATCH_INVITATION', { title: 'x'.repeat(5000) }), token, 'en')!;
    expect(m.body.length).toBeLessThan(200);
    expect(Buffer.byteLength(JSON.stringify(m))).toBeLessThan(1500);
  });

  it('non-string or hostile params are ignored, not rendered', () => {
    const m = buildPush(src('MATCH_CANCELLED', { title: { evil: true } as never }), token, 'en')!;
    expect(m.body).not.toContain('object');
    expect(buildPush({ ...src('MATCH_CANCELLED', {}), params: null }, token, 'en')).not.toBeNull();
    expect(buildPush({ ...src('MATCH_CANCELLED', {}), params: ['x'] }, token, 'en')).not.toBeNull();
  });

  it.each(APPROVED_NO_PUSH)('%s produces no push message', (type) => {
    expect(buildPush(src(type, { title: 'x' }), token, 'en')).toBeNull();
  });
});
