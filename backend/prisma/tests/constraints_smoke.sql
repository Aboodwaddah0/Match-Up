-- Smoke test for 20261117000200_constraints_and_triggers.
-- Runs in ONE transaction and ROLLS BACK, so it leaves no data behind.
--   psql -v ON_ERROR_STOP=1 -d <db> -f constraints_smoke.sql
-- Every check prints NOTICE 'PASS ...'; any failure aborts with 'FAIL ...'.
-- (Real multi-session concurrency tests live in tests/concurrency.sh.)

BEGIN;

CREATE FUNCTION pg_temp.expect(label text, stmt text, needle text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN OTHERS THEN
    IF position(needle IN SQLERRM) > 0 OR SQLSTATE = needle THEN
      RAISE NOTICE 'PASS  %', label; RETURN;
    END IF;
    RAISE EXCEPTION 'FAIL  %: expected [%] but got [%] %', label, needle, SQLSTATE, SQLERRM;
  END;
  RAISE EXCEPTION 'FAIL  %: statement succeeded but [%] was expected', label, needle;
END $$;

CREATE FUNCTION pg_temp.ok(label text, cond boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF cond IS TRUE THEN RAISE NOTICE 'PASS  %', label;
  ELSE RAISE EXCEPTION 'FAIL  %', label; END IF;
END $$;

-- Prisma fills @updatedAt client-side; give raw-SQL fixtures a default (rolled back with the rest).
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='updated_at' LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN updated_at SET DEFAULT now()', r.table_name);
  END LOOP;
END $$;

-- ── fixtures ────────────────────────────────────────────────────────────────
INSERT INTO "user" (id, email, password_hash, full_name, updated_at) VALUES
 ('00000000-0000-0000-0000-000000000001','org@x.com','h','Organizer',now()),
 ('00000000-0000-0000-0000-000000000002','p2@x.com','h','P2',now()),
 ('00000000-0000-0000-0000-000000000003','p3@x.com','h','P3',now()),
 ('00000000-0000-0000-0000-000000000004','p4@x.com','h','P4',now()),
 ('00000000-0000-0000-0000-000000000005','p5@x.com','h','P5',now()),
 ('00000000-0000-0000-0000-000000000006','p6@x.com','h','P6',now()),
 ('00000000-0000-0000-0000-000000000007','p7@x.com','h','P7',now()),
 ('00000000-0000-0000-0000-00000000000a','owner@x.com','h','Owner',now());
INSERT INTO city (id, name_ar, name_en) VALUES ('00000000-0000-0000-0000-0000000000c1','الخليل','Hebron');
INSERT INTO venue (id, owner_id, name, city_id, address, latitude, longitude, updated_at) VALUES
 ('00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-00000000000a','V','00000000-0000-0000-0000-0000000000c1','addr',31.53,35.10,now());
INSERT INTO venue_field (id, venue_id, name, format, capacity, price_per_hour, updated_at) VALUES
 ('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000e1','F1','F7',14,200,now());

-- ── 1. identity ─────────────────────────────────────────────────────────────
SELECT pg_temp.expect('email unique is case-insensitive',
  $q$INSERT INTO "user" (email,password_hash,full_name,updated_at) VALUES ('ORG@X.COM','h','dup',now())$q$, '23505');

-- ── 2. OPEN_MATCH capacity, derived count, FULL/OPEN sync ──────────────────
INSERT INTO "match" (id, organizer_id, type, format, status, title, start_at, end_at, capacity) VALUES
 ('00000000-0000-0000-0000-000000000b01','00000000-0000-0000-0000-000000000001','OPEN_MATCH','F7','OPEN','m1',
  now() + interval '3 days', now() + interval '3 days 90 minutes', 2);

SELECT pg_temp.expect('bad initial status rejected',
  $q$INSERT INTO "match" (organizer_id,type,format,status,title,start_at,end_at,capacity) VALUES
     ('00000000-0000-0000-0000-000000000001','OPEN_MATCH','F7','FULL','x',now()+interval '1 day',now()+interval '2 day',2)$q$, 'FYM_BAD_INITIAL_STATUS');
SELECT pg_temp.expect('capacity above pitch total rejected (F5 -> max 10)',
  $q$INSERT INTO "match" (organizer_id,type,format,status,title,start_at,end_at,capacity) VALUES
     ('00000000-0000-0000-0000-000000000001','OPEN_MATCH','F5','OPEN','x',now()+interval '1 day',now()+interval '2 day',11)$q$, '23514');
SELECT pg_temp.expect('capacity 0 rejected',
  $q$INSERT INTO "match" (organizer_id,type,format,status,title,start_at,end_at,capacity) VALUES
     ('00000000-0000-0000-0000-000000000001','OPEN_MATCH','F7','OPEN','x',now()+interval '1 day',now()+interval '2 day',0)$q$, '23514');
SELECT pg_temp.expect('TEAM_CHALLENGE may not have capacity',
  $q$INSERT INTO "match" (organizer_id,type,format,status,title,start_at,end_at,capacity) VALUES
     ('00000000-0000-0000-0000-000000000001','TEAM_CHALLENGE','F7','SCHEDULED','x',now()+interval '1 day',now()+interval '2 day',4)$q$, '23514');

INSERT INTO match_participant (match_id, user_id) VALUES ('00000000-0000-0000-0000-000000000b01','00000000-0000-0000-0000-000000000002');
SELECT pg_temp.ok('1 of 2 confirmed -> still OPEN',
  (SELECT status FROM "match" WHERE id='00000000-0000-0000-0000-000000000b01') = 'OPEN');
INSERT INTO match_participant (match_id, user_id) VALUES ('00000000-0000-0000-0000-000000000b01','00000000-0000-0000-0000-000000000003');
SELECT pg_temp.ok('2 of 2 confirmed -> FULL automatically',
  (SELECT status FROM "match" WHERE id='00000000-0000-0000-0000-000000000b01') = 'FULL');
SELECT pg_temp.ok('view: confirmed=2, available=0',
  (SELECT confirmed_count = 2 AND available_spots = 0 FROM match_availability WHERE match_id='00000000-0000-0000-0000-000000000b01'));
SELECT pg_temp.expect('3rd confirmation rejected (capacity)',
  $q$INSERT INTO match_participant (match_id,user_id) VALUES ('00000000-0000-0000-0000-000000000b01','00000000-0000-0000-0000-000000000004')$q$, 'FYM_MATCH_FULL');
SELECT pg_temp.expect('request to FULL match rejected',
  $q$INSERT INTO match_request (match_id,user_id,updated_at) VALUES ('00000000-0000-0000-0000-000000000b01','00000000-0000-0000-0000-000000000004',now())$q$, 'FYM_MATCH_NOT_OPEN');
SELECT pg_temp.expect('a FULL match refuses even a duplicate row (capacity guard runs first)',
  $q$INSERT INTO match_participant (match_id,user_id) VALUES ('00000000-0000-0000-0000-000000000b01','00000000-0000-0000-0000-000000000002')$q$, 'FYM_MATCH_FULL');

-- leave (3 days before start => NOT late) frees a spot and reopens the match
UPDATE match_participant SET status='LEFT' WHERE match_id='00000000-0000-0000-0000-000000000b01' AND user_id='00000000-0000-0000-0000-000000000003';
SELECT pg_temp.ok('leave >12h before start: not a late cancellation, left_at set',
  (SELECT NOT is_late_cancellation AND left_at IS NOT NULL FROM match_participant
    WHERE match_id='00000000-0000-0000-0000-000000000b01' AND user_id='00000000-0000-0000-0000-000000000003'));
SELECT pg_temp.ok('leaving reopens FULL -> OPEN',
  (SELECT status FROM "match" WHERE id='00000000-0000-0000-0000-000000000b01') = 'OPEN');

-- capacity edits
UPDATE "match" SET capacity = 3 WHERE id='00000000-0000-0000-0000-000000000b01';
SELECT pg_temp.ok('capacity raised 2->3 stays OPEN',
  (SELECT status FROM "match" WHERE id='00000000-0000-0000-0000-000000000b01') = 'OPEN');
UPDATE "match" SET capacity = 1 WHERE id='00000000-0000-0000-0000-000000000b01';   -- 1 confirmed (p2)
SELECT pg_temp.ok('capacity lowered to confirmed count -> FULL',
  (SELECT status FROM "match" WHERE id='00000000-0000-0000-0000-000000000b01') = 'FULL');
UPDATE "match" SET capacity = 3 WHERE id='00000000-0000-0000-0000-000000000b01';
UPDATE match_participant SET status='CONFIRMED' WHERE match_id='00000000-0000-0000-0000-000000000b01' AND user_id='00000000-0000-0000-0000-000000000003';
SELECT pg_temp.ok('LEFT participant re-confirmed (same row, fresh record)',
  (SELECT left_at IS NULL AND NOT is_late_cancellation FROM match_participant
    WHERE match_id='00000000-0000-0000-0000-000000000b01' AND user_id='00000000-0000-0000-0000-000000000003'));
SELECT pg_temp.expect('duplicate (match,user) participant rejected (unique)',
  $q$INSERT INTO match_participant (match_id,user_id) VALUES ('00000000-0000-0000-0000-000000000b01','00000000-0000-0000-0000-000000000002')$q$, '23505');
SELECT pg_temp.expect('capacity below confirmed rejected',
  $q$UPDATE "match" SET capacity = 1 WHERE id='00000000-0000-0000-0000-000000000b01'$q$, 'FYM_CAPACITY_BELOW_CONFIRMED');

-- D12: time locked once someone is confirmed
SELECT pg_temp.expect('reschedule blocked while players confirmed',
  $q$UPDATE "match" SET start_at = start_at + interval '1 hour', end_at = end_at + interval '1 hour' WHERE id='00000000-0000-0000-0000-000000000b01'$q$, 'FYM_MATCH_TIME_LOCKED');

-- ── 3. overlapping matches (D3): requests warn, confirmation blocks ─────────
INSERT INTO "match" (id, organizer_id, type, format, status, title, start_at, end_at, capacity)
SELECT '00000000-0000-0000-0000-000000000b02','00000000-0000-0000-0000-000000000001','OPEN_MATCH','F7','OPEN','m2', start_at + interval '30 minutes', end_at + interval '30 minutes', 5
  FROM "match" WHERE id='00000000-0000-0000-0000-000000000b01';
INSERT INTO match_request (id, match_id, user_id, updated_at) VALUES
 ('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-000000000b02','00000000-0000-0000-0000-000000000002',now());
SELECT pg_temp.ok('request for an overlapping match is allowed (warn only)', true);
SELECT pg_temp.expect('duplicate PENDING request rejected',
  $q$INSERT INTO match_request (match_id,user_id,updated_at) VALUES ('00000000-0000-0000-0000-000000000b02','00000000-0000-0000-0000-000000000002',now())$q$, '23505');
SELECT pg_temp.expect('organizer cannot request own match',
  $q$INSERT INTO match_request (match_id,user_id,updated_at) VALUES ('00000000-0000-0000-0000-000000000b02','00000000-0000-0000-0000-000000000001',now())$q$, 'FYM_ORGANIZER_CANNOT_REQUEST');
SELECT pg_temp.expect('confirming into an overlapping match is rejected',
  $q$INSERT INTO match_participant (match_id,user_id) VALUES ('00000000-0000-0000-0000-000000000b02','00000000-0000-0000-0000-000000000002')$q$, '23P01');

-- late cancellation (D4): match starts in 6h
INSERT INTO "match" (id, organizer_id, type, format, status, title, start_at, end_at, capacity) VALUES
 ('00000000-0000-0000-0000-000000000b03','00000000-0000-0000-0000-000000000001','OPEN_MATCH','F7','OPEN','m3',
  now() + interval '6 hours', now() + interval '8 hours', 2);
INSERT INTO match_participant (match_id, user_id) VALUES ('00000000-0000-0000-0000-000000000b03','00000000-0000-0000-0000-000000000004');
UPDATE match_participant SET status='LEFT' WHERE match_id='00000000-0000-0000-0000-000000000b03' AND user_id='00000000-0000-0000-0000-000000000004';
SELECT pg_temp.ok('leave <12h before start recorded as late cancellation',
  (SELECT is_late_cancellation FROM match_participant WHERE match_id='00000000-0000-0000-0000-000000000b03' AND user_id='00000000-0000-0000-0000-000000000004'));

-- private match: invite-only (D8)
INSERT INTO "match" (id, organizer_id, type, visibility, format, status, title, start_at, end_at, capacity) VALUES
 ('00000000-0000-0000-0000-000000000b04','00000000-0000-0000-0000-000000000001','OPEN_MATCH','PRIVATE','F5','OPEN','priv',
  now() + interval '5 days', now() + interval '5 days 1 hour', 3);
SELECT pg_temp.expect('uninvited user cannot request a PRIVATE match',
  $q$INSERT INTO match_request (match_id,user_id,updated_at) VALUES ('00000000-0000-0000-0000-000000000b04','00000000-0000-0000-0000-000000000005',now())$q$, 'FYM_PRIVATE_NOT_INVITED');
INSERT INTO match_invitation (match_id, invitee_id, invited_by_id) VALUES
 ('00000000-0000-0000-0000-000000000b04','00000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000001');
INSERT INTO match_request (match_id,user_id,updated_at) VALUES ('00000000-0000-0000-0000-000000000b04','00000000-0000-0000-0000-000000000005',now());
SELECT pg_temp.ok('invited user can request a PRIVATE match', true);

-- cancel match m1: frees participants' slots, expires pending requests
UPDATE "match" SET status='CANCELLED', cancelled_by_id='00000000-0000-0000-0000-000000000001' WHERE id='00000000-0000-0000-0000-000000000b01';
SELECT pg_temp.ok('cancel: confirmed participants -> MATCH_CANCELLED',
  (SELECT count(*) FROM match_participant WHERE match_id='00000000-0000-0000-0000-000000000b01' AND status='MATCH_CANCELLED') = 2);
INSERT INTO match_participant (match_id, user_id) VALUES ('00000000-0000-0000-0000-000000000b02','00000000-0000-0000-0000-000000000002');
SELECT pg_temp.ok('after cancel the player can confirm the overlapping match', true);
SELECT pg_temp.expect('CANCELLED match is terminal',
  $q$UPDATE "match" SET status='OPEN' WHERE id='00000000-0000-0000-0000-000000000b01'$q$, 'FYM_MATCH_BAD_TRANSITION');

-- ── 4. lifecycle: start, attendance, complete, review, closed-unconfirmed ───
INSERT INTO "match" (id, organizer_id, type, format, status, title, start_at, end_at, capacity) VALUES
 ('00000000-0000-0000-0000-000000000b05','00000000-0000-0000-0000-000000000001','OPEN_MATCH','F7','OPEN','m5',
  now() + interval '2 days', now() + interval '2 days 2 hours', 3);
INSERT INTO match_request (id, match_id, user_id, updated_at) VALUES   -- pending ask made while still OPEN
 ('00000000-0000-0000-0000-0000000000d2','00000000-0000-0000-0000-000000000b05','00000000-0000-0000-0000-000000000004',now());
INSERT INTO match_participant (match_id, user_id) VALUES
 ('00000000-0000-0000-0000-000000000b05','00000000-0000-0000-0000-000000000005'),
 ('00000000-0000-0000-0000-000000000b05','00000000-0000-0000-0000-000000000006'),
 ('00000000-0000-0000-0000-000000000b05','00000000-0000-0000-0000-000000000007');
SELECT pg_temp.ok('m5 is FULL after 3 confirmations',
  (SELECT status FROM "match" WHERE id='00000000-0000-0000-0000-000000000b05') = 'FULL');
SELECT pg_temp.expect('IN_PROGRESS before start time rejected',
  $q$UPDATE "match" SET status='IN_PROGRESS' WHERE id='00000000-0000-0000-0000-000000000b05'$q$, 'FYM_TOO_EARLY');
SELECT pg_temp.expect('no-show before the match starts rejected',
  $q$UPDATE match_participant SET attendance_status='NO_SHOW' WHERE match_id='00000000-0000-0000-0000-000000000b05' AND user_id='00000000-0000-0000-0000-000000000006'$q$, 'FYM_ATTENDANCE_TOO_EARLY');

-- time travel for fixtures only (the sweeper would normally do this): disable triggers just for the shift
SET LOCAL session_replication_role = replica;
UPDATE "match" SET start_at = now() - interval '5 hours', end_at = now() - interval '3 hours' WHERE id='00000000-0000-0000-0000-000000000b05';
SET LOCAL session_replication_role = origin;

UPDATE "match" SET status='IN_PROGRESS' WHERE id='00000000-0000-0000-0000-000000000b05';
SELECT pg_temp.ok('start: pending requests expired by the DB',
  (SELECT status FROM match_request WHERE id='00000000-0000-0000-0000-0000000000d2') = 'EXPIRED');
SELECT pg_temp.expect('cannot leave after the match started',
  $q$UPDATE match_participant SET status='LEFT' WHERE match_id='00000000-0000-0000-0000-000000000b05' AND user_id='00000000-0000-0000-0000-000000000005'$q$, 'FYM_MATCH_STARTED');
UPDATE match_participant SET attendance_status='NO_SHOW', attendance_confirmed_by_id='00000000-0000-0000-0000-000000000001'
 WHERE match_id='00000000-0000-0000-0000-000000000b05' AND user_id='00000000-0000-0000-0000-000000000006';
SELECT pg_temp.expect('CLOSED_UNCONFIRMED before the 48h grace rejected',
  $q$UPDATE "match" SET status='CLOSED_UNCONFIRMED' WHERE id='00000000-0000-0000-0000-000000000b05'$q$, 'FYM_TOO_EARLY');
UPDATE "match" SET status='COMPLETED', completed_by_id='00000000-0000-0000-0000-000000000001' WHERE id='00000000-0000-0000-0000-000000000b05';
SELECT pg_temp.ok('COMPLETED: completed_at stamped, non-no-shows ATTENDED, no-show kept',
  (SELECT m.completed_at IS NOT NULL
      AND (SELECT attendance_status FROM match_participant WHERE match_id=m.id AND user_id='00000000-0000-0000-0000-000000000005') = 'ATTENDED'
      AND (SELECT attendance_status FROM match_participant WHERE match_id=m.id AND user_id='00000000-0000-0000-0000-000000000006') = 'NO_SHOW'
     FROM "match" m WHERE m.id='00000000-0000-0000-0000-000000000b05'));

-- reviews (D: only attendees of a COMPLETED match, once per pair)
INSERT INTO review (match_id, reviewer_id, reviewed_id, sportsmanship_score, skill_score, reliability_score)
VALUES ('00000000-0000-0000-0000-000000000b05','00000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000007',5,4,5);
SELECT pg_temp.ok('attendee reviews attendee', true);
SELECT pg_temp.expect('duplicate review rejected',
  $q$INSERT INTO review (match_id,reviewer_id,reviewed_id,sportsmanship_score,skill_score,reliability_score) VALUES ('00000000-0000-0000-0000-000000000b05','00000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000007',3,3,3)$q$, '23505');
SELECT pg_temp.expect('cannot review a NO_SHOW',
  $q$INSERT INTO review (match_id,reviewer_id,reviewed_id,sportsmanship_score,skill_score,reliability_score) VALUES ('00000000-0000-0000-0000-000000000b05','00000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000006',3,3,3)$q$, 'FYM_REVIEWED_NOT_ATTENDEE');
SELECT pg_temp.expect('non-participant cannot review',
  $q$INSERT INTO review (match_id,reviewer_id,reviewed_id,sportsmanship_score,skill_score,reliability_score) VALUES ('00000000-0000-0000-0000-000000000b05','00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000005',3,3,3)$q$, 'FYM_REVIEWER_NOT_ATTENDEE');
SELECT pg_temp.expect('review score out of range rejected',
  $q$INSERT INTO review (match_id,reviewer_id,reviewed_id,sportsmanship_score,skill_score,reliability_score) VALUES ('00000000-0000-0000-0000-000000000b05','00000000-0000-0000-0000-000000000007','00000000-0000-0000-0000-000000000005',6,3,3)$q$, '23514');

-- CLOSED_UNCONFIRMED (D16): 48h grace, organizer recovery 7d, then admin only
INSERT INTO "match" (id, organizer_id, type, format, status, title, start_at, end_at, capacity) VALUES
 ('00000000-0000-0000-0000-000000000b06','00000000-0000-0000-0000-000000000001','OPEN_MATCH','F7','OPEN','m6', now()+interval '9 days', now()+interval '9 days 2 hours', 2),
 ('00000000-0000-0000-0000-000000000b07','00000000-0000-0000-0000-000000000001','TEAM_CHALLENGE','F7','SCHEDULED','m7', now()+interval '9 days', now()+interval '9 days 2 hours', NULL);
INSERT INTO team (id, name, updated_at) VALUES
 ('00000000-0000-0000-0000-0000000000a1','T1',now()),('00000000-0000-0000-0000-0000000000a2','T2',now());
INSERT INTO match_team (match_id, team_id, side) VALUES
 ('00000000-0000-0000-0000-000000000b07','00000000-0000-0000-0000-0000000000a1','HOME'),
 ('00000000-0000-0000-0000-000000000b07','00000000-0000-0000-0000-0000000000a2','AWAY');
SET LOCAL session_replication_role = replica;
UPDATE "match" SET start_at = now() - interval '60 hours', end_at = now() - interval '55 hours' WHERE id IN ('00000000-0000-0000-0000-000000000b06');
UPDATE "match" SET start_at = now() - interval '20 days', end_at = now() - interval '20 days' + interval '2 hours' WHERE id = '00000000-0000-0000-0000-000000000b07';
SET LOCAL session_replication_role = origin;
UPDATE "match" SET status='IN_PROGRESS' WHERE id='00000000-0000-0000-0000-000000000b06';
UPDATE "match" SET status='CLOSED_UNCONFIRMED' WHERE id='00000000-0000-0000-0000-000000000b06';
SELECT pg_temp.ok('55h after end -> CLOSED_UNCONFIRMED allowed, stamped',
  (SELECT closed_unconfirmed_at IS NOT NULL FROM "match" WHERE id='00000000-0000-0000-0000-000000000b06'));
UPDATE "match" SET status='COMPLETED' WHERE id='00000000-0000-0000-0000-000000000b06';
SELECT pg_temp.ok('organizer recovers CLOSED_UNCONFIRMED -> COMPLETED within 7 days', true);

SET LOCAL session_replication_role = replica;
UPDATE "match" SET status='CLOSED_UNCONFIRMED', closed_unconfirmed_at = now() - interval '8 days' WHERE id='00000000-0000-0000-0000-000000000b07';
SET LOCAL session_replication_role = origin;
SELECT pg_temp.expect('after 7 days the organizer can no longer recover',
  $q$UPDATE "match" SET status='COMPLETED' WHERE id='00000000-0000-0000-0000-000000000b07'$q$, 'FYM_RECOVERY_WINDOW_EXPIRED');
SELECT set_config('fym.actor_is_admin', 'true', true);
UPDATE "match" SET status='CANCELLED' WHERE id='00000000-0000-0000-0000-000000000b07';
SELECT pg_temp.ok('admin can still resolve it', true);
SELECT set_config('fym.actor_is_admin', 'false', true);

-- ── 5. TEAM_CHALLENGE is a separate concept (D14) ───────────────────────────
INSERT INTO team_member (team_id, user_id, role) VALUES
 ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-000000000002','CAPTAIN'),
 ('00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-000000000003','CAPTAIN');
SELECT pg_temp.expect('second captain in a team rejected',
  $q$INSERT INTO team_member (team_id,user_id,role) VALUES ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-000000000004','CAPTAIN')$q$, '23505');
SELECT pg_temp.expect('team match with fewer than 2 sides fails at commit',
  $q$INSERT INTO "match" (organizer_id,type,format,status,title,start_at,end_at) VALUES ('00000000-0000-0000-0000-000000000001','TEAM_CHALLENGE','F7','SCHEDULED','bad',now()+interval '30 days',now()+interval '31 days');
     SET CONSTRAINTS ALL IMMEDIATE$q$, 'FYM_TEAM_MATCH_NEEDS_TWO_TEAMS');
SET CONSTRAINTS ALL DEFERRED;

INSERT INTO "match" (id, organizer_id, type, format, status, title, start_at, end_at) VALUES
 ('00000000-0000-0000-0000-000000000b08','00000000-0000-0000-0000-000000000002','TEAM_CHALLENGE','F7','SCHEDULED','derby',
  now() + interval '11 days', now() + interval '11 days 2 hours');
INSERT INTO match_team (id, match_id, team_id, side) VALUES
 ('00000000-0000-0000-0000-0000000000aa','00000000-0000-0000-0000-000000000b08','00000000-0000-0000-0000-0000000000a1','HOME'),
 ('00000000-0000-0000-0000-0000000000ab','00000000-0000-0000-0000-000000000b08','00000000-0000-0000-0000-0000000000a2','AWAY');
SET CONSTRAINTS ALL IMMEDIATE;
SELECT pg_temp.ok('TEAM_CHALLENGE with two sides is accepted; starts SCHEDULED', true);
SELECT pg_temp.expect('team match refuses open join requests',
  $q$INSERT INTO match_request (match_id,user_id,updated_at) VALUES ('00000000-0000-0000-0000-000000000b08','00000000-0000-0000-0000-000000000004',now())$q$, 'FYM_REQUESTS_NOT_ALLOWED');
SELECT pg_temp.expect('roster player must belong to that team',
  $q$INSERT INTO match_participant (match_id,user_id,match_team_id) VALUES ('00000000-0000-0000-0000-000000000b08','00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-0000000000aa')$q$, 'FYM_NOT_TEAM_MEMBER');
SELECT pg_temp.expect('team match roster needs a side',
  $q$INSERT INTO match_participant (match_id,user_id) VALUES ('00000000-0000-0000-0000-000000000b08','00000000-0000-0000-0000-000000000002')$q$, 'FYM_TEAM_REQUIRED');
INSERT INTO match_participant (match_id, user_id, match_team_id) VALUES
 ('00000000-0000-0000-0000-000000000b08','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-0000000000aa');
SELECT pg_temp.ok('rostering a player never flips a TEAM_CHALLENGE to FULL/OPEN',
  (SELECT status FROM "match" WHERE id='00000000-0000-0000-0000-000000000b08') = 'SCHEDULED');
SELECT pg_temp.ok('match_availability view only lists OPEN_MATCH',
  NOT EXISTS (SELECT 1 FROM match_availability WHERE match_id='00000000-0000-0000-0000-000000000b08'));
SELECT pg_temp.expect('match type is immutable',
  $q$UPDATE "match" SET type='OPEN_MATCH', capacity=3 WHERE id='00000000-0000-0000-0000-000000000b08'$q$, 'FYM_MATCH_TYPE_IMMUTABLE');

-- ── 6. bookings, holds, blocks (D1, D11) ────────────────────────────────────
SELECT pg_temp.expect('IN_APP booking needs a field',
  $q$INSERT INTO booking (source,status,created_by_id,start_at,end_at,total_price,updated_at) VALUES ('IN_APP','PENDING','00000000-0000-0000-0000-000000000002',now()+interval '2 days',now()+interval '2 days 1 hour',100,now())$q$, '23514');
SELECT pg_temp.expect('EXTERNAL booking must not reference a registered field',
  $q$INSERT INTO booking (source,status,created_by_id,venue_field_id,ext_venue_name,start_at,end_at,total_price,updated_at) VALUES ('EXTERNAL','CONFIRMED','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-0000000000f1','Other',now()+interval '2 days',now()+interval '2 days 1 hour',100,now())$q$, '23514');
INSERT INTO booking (source,status,created_by_id,ext_venue_name,ext_venue_address,start_at,end_at,total_price,updated_at)
VALUES ('EXTERNAL','CONFIRMED','00000000-0000-0000-0000-000000000002','Phone-booked pitch','Somewhere',now()+interval '2 days',now()+interval '2 days 1 hour',150,now());
SELECT pg_temp.ok('EXTERNAL booking for an unregistered venue accepted (snapshot, no field)', true);

-- in-app booking: client does NOT supply hold_expires_at; the DB sets it
INSERT INTO booking (id,source,status,created_by_id,venue_field_id,start_at,end_at,total_price,updated_at) VALUES
 ('00000000-0000-0000-0000-0000000000b1','IN_APP','PENDING','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-0000000000f1',
  date_trunc('day', now()) + interval '5 days 18 hours', date_trunc('day', now()) + interval '5 days 19 hours', 200, now());
SELECT pg_temp.ok('hold set by the DB = now()+2h (start is days away)',
  (SELECT hold_expires_at BETWEEN now() + interval '119 minutes' AND now() + interval '121 minutes' FROM booking WHERE id='00000000-0000-0000-0000-0000000000b1'));
SELECT pg_temp.expect('overlapping PENDING hold rejected',
  $q$INSERT INTO booking (source,status,created_by_id,venue_field_id,start_at,end_at,total_price,updated_at) VALUES ('IN_APP','PENDING','00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-0000000000f1',date_trunc('day', now()) + interval '5 days 18 hours 30 minutes', date_trunc('day', now()) + interval '5 days 19 hours 30 minutes',200,now())$q$, '23P01');
INSERT INTO booking (source,status,created_by_id,venue_field_id,start_at,end_at,total_price,updated_at) VALUES
 ('IN_APP','PENDING','00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-0000000000f1',
  date_trunc('day', now()) + interval '5 days 19 hours', date_trunc('day', now()) + interval '5 days 20 hours', 200, now());
SELECT pg_temp.ok('back-to-back booking (19:00 right after 18:00-19:00) allowed', true);
SELECT pg_temp.expect('owner cannot decide a booking they created',
  $q$UPDATE booking SET status='CONFIRMED', decided_by_id=created_by_id WHERE id='00000000-0000-0000-0000-0000000000b1'$q$, '23514');
SELECT pg_temp.expect('in-app booking time is immutable',
  $q$UPDATE booking SET start_at = start_at + interval '1 hour', end_at = end_at + interval '1 hour' WHERE id='00000000-0000-0000-0000-0000000000b1'$q$, 'FYM_BOOKING_IMMUTABLE');
SELECT pg_temp.expect('block over a PENDING booking rejected (owner must reject it first)',
  $q$INSERT INTO venue_block (venue_field_id,start_at,end_at,created_by_id) VALUES ('00000000-0000-0000-0000-0000000000f1',date_trunc('day', now()) + interval '5 days 18 hours', date_trunc('day', now()) + interval '5 days 19 hours','00000000-0000-0000-0000-00000000000a')$q$, 'FYM_BLOCK_CONFLICTS_BOOKING');
UPDATE booking SET status='CONFIRMED', decided_by_id='00000000-0000-0000-0000-00000000000a' WHERE id='00000000-0000-0000-0000-0000000000b1';
SELECT pg_temp.ok('owner confirms within the hold; decided_at stamped',
  (SELECT status='CONFIRMED' AND decided_at IS NOT NULL FROM booking WHERE id='00000000-0000-0000-0000-0000000000b1'));

INSERT INTO venue_block (venue_field_id,start_at,end_at,reason,created_by_id) VALUES
 ('00000000-0000-0000-0000-0000000000f1', date_trunc('day', now()) + interval '6 days 18 hours', date_trunc('day', now()) + interval '6 days 20 hours','OFFLINE_BOOKING','00000000-0000-0000-0000-00000000000a');
SELECT pg_temp.ok('owner blocks a free period (phone customer)', true);
SELECT pg_temp.expect('overlapping blocks rejected',
  $q$INSERT INTO venue_block (venue_field_id,start_at,end_at,created_by_id) VALUES ('00000000-0000-0000-0000-0000000000f1',date_trunc('day', now()) + interval '6 days 19 hours', date_trunc('day', now()) + interval '6 days 21 hours','00000000-0000-0000-0000-00000000000a')$q$, '23P01');
SELECT pg_temp.expect('booking on a blocked slot rejected',
  $q$INSERT INTO booking (source,status,created_by_id,venue_field_id,start_at,end_at,total_price,updated_at) VALUES ('IN_APP','PENDING','00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-0000000000f1',date_trunc('day', now()) + interval '6 days 19 hours', date_trunc('day', now()) + interval '6 days 20 hours',200,now())$q$, 'FYM_SLOT_BLOCKED');

-- hold expiry: stale PENDING must not block, and cannot be confirmed
INSERT INTO booking (id,source,status,created_by_id,venue_field_id,start_at,end_at,total_price,updated_at) VALUES
 ('00000000-0000-0000-0000-0000000000b3','IN_APP','PENDING','00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-0000000000f1',
  date_trunc('day', now()) + interval '7 days 18 hours', date_trunc('day', now()) + interval '7 days 19 hours', 200, now());
UPDATE booking SET hold_expires_at = now() - interval '1 minute' WHERE id='00000000-0000-0000-0000-0000000000b3';   -- simulate 2h passing
SELECT pg_temp.expect('confirming after the hold expired is rejected',
  $q$UPDATE booking SET status='CONFIRMED', decided_by_id='00000000-0000-0000-0000-00000000000a' WHERE id='00000000-0000-0000-0000-0000000000b3'$q$, 'FYM_HOLD_EXPIRED');
INSERT INTO booking (source,status,created_by_id,venue_field_id,start_at,end_at,total_price,updated_at) VALUES
 ('IN_APP','PENDING','00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-0000000000f1',
  date_trunc('day', now()) + interval '7 days 18 hours', date_trunc('day', now()) + interval '7 days 19 hours', 200, now());
SELECT pg_temp.ok('stale hold lazily EXPIRED by the new request (no sweeper needed)',
  (SELECT status FROM booking WHERE id='00000000-0000-0000-0000-0000000000b3') = 'EXPIRED');
SELECT pg_temp.expect('EXPIRED is terminal',
  $q$UPDATE booking SET status='PENDING' WHERE id='00000000-0000-0000-0000-0000000000b3'$q$, 'FYM_BOOKING_BAD_TRANSITION');

-- cap on simultaneous holds: 3 pending are fine, the 4th is refused
INSERT INTO booking (source,status,created_by_id,venue_field_id,start_at,end_at,total_price,updated_at)
SELECT 'IN_APP','PENDING','00000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-0000000000f1',
       date_trunc('day', now()) + interval '10 days' + (g || ' hours')::interval,
       date_trunc('day', now()) + interval '10 days' + ((g+1) || ' hours')::interval, 100, now()
  FROM generate_series(8, 10) g;
SELECT pg_temp.expect('4th simultaneous PENDING hold rejected',
  $q$INSERT INTO booking (source,status,created_by_id,venue_field_id,start_at,end_at,total_price,updated_at) VALUES ('IN_APP','PENDING','00000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-0000000000f1',date_trunc('day', now()) + interval '10 days 14 hours', date_trunc('day', now()) + interval '10 days 15 hours',100,now())$q$, 'FYM_TOO_MANY_PENDING');

-- ── 7. match <-> booking link ───────────────────────────────────────────────
SELECT pg_temp.expect('cannot link a PENDING booking to a match',
  $q$INSERT INTO "match" (organizer_id,booking_id,type,format,status,title,start_at,end_at,capacity)
     SELECT '00000000-0000-0000-0000-000000000003', id,'OPEN_MATCH','F7','OPEN','x',start_at,end_at,3 FROM booking WHERE created_by_id='00000000-0000-0000-0000-000000000003' AND status='PENDING' LIMIT 1$q$, 'FYM_BOOKING_NOT_CONFIRMED');
SELECT pg_temp.expect('only the booking creator can link it to their open match',
  $q$INSERT INTO "match" (organizer_id,booking_id,type,format,status,title,start_at,end_at,capacity)
     SELECT '00000000-0000-0000-0000-000000000001', id,'OPEN_MATCH','F7','OPEN','x',start_at,end_at,3 FROM booking WHERE id='00000000-0000-0000-0000-0000000000b1'$q$, 'FYM_BOOKING_NOT_OWNED');
SELECT pg_temp.expect('match window must fit inside the booking',
  $q$INSERT INTO "match" (organizer_id,booking_id,type,format,status,title,start_at,end_at,capacity)
     SELECT '00000000-0000-0000-0000-000000000002', id,'OPEN_MATCH','F7','OPEN','x',start_at,end_at + interval '1 hour',3 FROM booking WHERE id='00000000-0000-0000-0000-0000000000b1'$q$, 'FYM_MATCH_OUTSIDE_BOOKING');
INSERT INTO "match" (id,organizer_id,booking_id,type,format,status,title,start_at,end_at,capacity)
SELECT '00000000-0000-0000-0000-000000000b09','00000000-0000-0000-0000-000000000002', id,'OPEN_MATCH','F7','OPEN','linked',start_at,end_at,3
  FROM booking WHERE id='00000000-0000-0000-0000-0000000000b1';
SELECT pg_temp.ok('CONFIRMED booking linked by its creator', true);
SELECT pg_temp.expect('a booking backs only one active match',
  $q$INSERT INTO "match" (organizer_id,booking_id,type,format,status,title,start_at,end_at,capacity)
     SELECT '00000000-0000-0000-0000-000000000002', id,'OPEN_MATCH','F7','OPEN','second',start_at,end_at,3 FROM booking WHERE id='00000000-0000-0000-0000-0000000000b1'$q$, '23505');

-- ── 8. misc integrity ───────────────────────────────────────────────────────
SELECT pg_temp.expect('block yourself rejected',
  $q$INSERT INTO blocked_user (blocker_id,blocked_id) VALUES ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000002')$q$, '23514');
INSERT INTO blocked_user (blocker_id,blocked_id) VALUES ('00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000002');
SELECT pg_temp.expect('a blocked relationship stops join requests',
  $q$INSERT INTO match_request (match_id,user_id,updated_at) VALUES ('00000000-0000-0000-0000-000000000b09','00000000-0000-0000-0000-000000000004',now())$q$, 'FYM_BLOCKED');
SELECT pg_temp.expect('primary position must be a selected position (deferred check)',
  $q$INSERT INTO player_profile (user_id,primary_position,updated_at) VALUES ('00000000-0000-0000-0000-000000000003','GOALKEEPER',now()); SET CONSTRAINTS ALL IMMEDIATE$q$, 'FYM_PRIMARY_POSITION_NOT_SELECTED');
SET CONSTRAINTS ALL DEFERRED;   -- (an earlier step switched them to IMMEDIATE)
INSERT INTO player_profile (id,user_id,primary_position,updated_at) VALUES ('00000000-0000-0000-0000-0000000000f9','00000000-0000-0000-0000-000000000004','STRIKER',now());
INSERT INTO player_position (player_profile_id,"position") VALUES ('00000000-0000-0000-0000-0000000000f9','STRIKER');
SET CONSTRAINTS ALL IMMEDIATE;
SELECT pg_temp.ok('profile + positions created together pass the deferred check', true);

ROLLBACK;
