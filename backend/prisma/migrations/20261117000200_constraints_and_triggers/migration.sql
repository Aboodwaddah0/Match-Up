-- ============================================================================
-- Find Your Match — hand-written migration (constraints, triggers, views)
-- Applies AFTER 20261117000100_init (Prisma-generated tables).
--
-- Everything here is something Prisma cannot express. It is the database-level
-- safety net: even buggy application code cannot overfill a match, double-book
-- a field, or put a player in two overlapping matches.
--
-- Error convention: triggers RAISE EXCEPTION 'FYM_<CODE>' (SQLSTATE P0001).
-- Constraint violations keep their standard SQLSTATEs:
--   23P01 exclusion_violation  -> booking/block/player overlap
--   23505 unique_violation     -> duplicate pending request, 2nd captain, ...
--   23514 check_violation      -> shape/range rules
--   23503 foreign_key_violation
-- The service layer maps these to API errors (see DATABASE_DESIGN.md §11).
--
-- Concurrency assumption: READ COMMITTED (the PostgreSQL default). Triggers
-- take row locks first, then run fresh statements that see committed rows.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS cube;
CREATE EXTENSION IF NOT EXISTS earthdistance;

-- ───────────────────── 1. Business constants (one place to tune) ─────────────────────

CREATE FUNCTION fym_hold_duration()          RETURNS interval LANGUAGE sql IMMUTABLE AS $$ SELECT interval '2 hours' $$;   -- D1
CREATE FUNCTION fym_max_pending_holds()      RETURNS int      LANGUAGE sql IMMUTABLE AS $$ SELECT 3 $$;                    -- per user
CREATE FUNCTION fym_late_cancel_window()     RETURNS interval LANGUAGE sql IMMUTABLE AS $$ SELECT interval '12 hours' $$;  -- D4
CREATE FUNCTION fym_unconfirmed_grace()      RETURNS interval LANGUAGE sql IMMUTABLE AS $$ SELECT interval '48 hours' $$;  -- D16
CREATE FUNCTION fym_unconfirmed_recovery()   RETURNS interval LANGUAGE sql IMMUTABLE AS $$ SELECT interval '7 days' $$;    -- D16
CREATE FUNCTION fym_review_window()          RETURNS interval LANGUAGE sql IMMUTABLE AS $$ SELECT interval '7 days' $$;

-- Players on the pitch for one side of a format.
CREATE FUNCTION fym_format_size(f match_format) RETURNS int LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE f WHEN 'F5' THEN 5 WHEN 'F7' THEN 7 WHEN 'F11' THEN 11 END
$$;

-- ───────────────────── 2. CHECK constraints ─────────────────────

ALTER TABLE player_profile ADD CONSTRAINT chk_player_geo CHECK (
  (latitude IS NULL) = (longitude IS NULL)
  AND (latitude IS NULL OR (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180)));
ALTER TABLE player_profile ADD CONSTRAINT chk_player_dob CHECK (date_of_birth IS NULL OR date_of_birth < CURRENT_DATE);

ALTER TABLE venue ADD CONSTRAINT chk_venue_geo CHECK (
  latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180);

ALTER TABLE venue_field ADD CONSTRAINT chk_field_values CHECK (
  capacity > 0 AND price_per_hour >= 0 AND slot_minutes BETWEEN 15 AND 240);

ALTER TABLE venue_opening_hours ADD CONSTRAINT chk_hours_values CHECK (
  weekday BETWEEN 0 AND 6 AND close_time > open_time);

ALTER TABLE venue_block ADD CONSTRAINT chk_block_window CHECK (end_at > start_at);

ALTER TABLE booking ADD CONSTRAINT chk_booking_window  CHECK (end_at > start_at);
ALTER TABLE booking ADD CONSTRAINT chk_booking_price   CHECK (total_price >= 0);
ALTER TABLE booking ADD CONSTRAINT chk_booking_decider CHECK (decided_by_id IS NULL OR decided_by_id <> created_by_id);
ALTER TABLE booking ADD CONSTRAINT chk_booking_pending_hold CHECK (status <> 'PENDING' OR hold_expires_at IS NOT NULL);
ALTER TABLE booking ADD CONSTRAINT chk_booking_source_shape CHECK (
  (source = 'IN_APP'
     AND venue_field_id IS NOT NULL
     AND ext_venue_name IS NULL AND ext_venue_address IS NULL
     AND ext_venue_phone IS NULL AND ext_field_info IS NULL)
  OR
  (source = 'EXTERNAL'
     AND venue_field_id IS NULL
     AND ext_venue_name IS NOT NULL
     AND hold_expires_at IS NULL
     AND status IN ('CONFIRMED', 'CANCELLED', 'COMPLETED')));

ALTER TABLE "match" ADD CONSTRAINT chk_match_window CHECK (end_at > start_at);
ALTER TABLE "match" ADD CONSTRAINT chk_match_price  CHECK (price_per_player IS NULL OR price_per_player >= 0);
ALTER TABLE "match" ADD CONSTRAINT chk_match_geo CHECK (
  (latitude IS NULL) = (longitude IS NULL)
  AND (latitude IS NULL OR (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180)));
-- OPEN_MATCH: capacity = players wanted via the app (1..pitch total). TEAM_CHALLENGE: no capacity.
ALTER TABLE "match" ADD CONSTRAINT chk_match_type_shape CHECK (
  (type = 'OPEN_MATCH'
     AND capacity IS NOT NULL
     AND capacity BETWEEN 1 AND 2 * fym_format_size(format)
     AND status IN ('OPEN', 'FULL', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'CLOSED_UNCONFIRMED'))
  OR
  (type = 'TEAM_CHALLENGE'
     AND capacity IS NULL
     AND status IN ('SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'CLOSED_UNCONFIRMED')));
ALTER TABLE "match" ADD CONSTRAINT chk_match_status_stamps CHECK (
  (status <> 'CANCELLED'          OR cancelled_at IS NOT NULL) AND
  (status <> 'COMPLETED'          OR completed_at IS NOT NULL) AND
  (status <> 'CLOSED_UNCONFIRMED' OR closed_unconfirmed_at IS NOT NULL));

ALTER TABLE match_participant ADD CONSTRAINT chk_participant_left CHECK (
  status = 'CONFIRMED' OR left_at IS NOT NULL);

ALTER TABLE review ADD CONSTRAINT chk_review_scores CHECK (
  sportsmanship_score BETWEEN 1 AND 5 AND skill_score BETWEEN 1 AND 5 AND reliability_score BETWEEN 1 AND 5);
ALTER TABLE review ADD CONSTRAINT chk_review_not_self CHECK (reviewer_id <> reviewed_id);

ALTER TABLE blocked_user    ADD CONSTRAINT chk_block_not_self      CHECK (blocker_id <> blocked_id);
ALTER TABLE team_challenge  ADD CONSTRAINT chk_challenge_teams_differ CHECK (challenger_team_id <> challenged_team_id);

-- A player's primary position must be one of their selected positions.
-- Checked at COMMIT (deferred) so profile + positions can be created in one transaction.
-- (A composite FK would work too, but Prisma would try to drop it on the next `migrate dev`;
--  constraint triggers are invisible to Prisma's diff.)
CREATE FUNCTION fym_primary_position_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_profile uuid;
  v_primary "position";
BEGIN
  IF TG_TABLE_NAME = 'player_position' THEN v_profile := OLD.player_profile_id; ELSE v_profile := NEW.id; END IF;
  SELECT primary_position INTO v_primary FROM player_profile WHERE id = v_profile;
  IF v_primary IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM player_position pp WHERE pp.player_profile_id = v_profile AND pp."position" = v_primary) THEN
    RAISE EXCEPTION 'FYM_PRIMARY_POSITION_NOT_SELECTED';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER trg_profile_primary_position AFTER INSERT OR UPDATE OF primary_position ON player_profile
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fym_primary_position_check();
CREATE CONSTRAINT TRIGGER trg_position_primary_position AFTER DELETE OR UPDATE ON player_position
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fym_primary_position_check();

-- ───────────────────── 3. Partial unique indexes ─────────────────────

-- One OPEN ask per (match, user); history rows (REJECTED/WITHDRAWN/...) are unrestricted.
CREATE UNIQUE INDEX uq_match_request_one_pending ON match_request (match_id, user_id) WHERE status = 'PENDING';
-- Exactly-at-most-one captain per team.
CREATE UNIQUE INDEX uq_team_one_captain ON team_member (team_id) WHERE role = 'CAPTAIN';
CREATE UNIQUE INDEX uq_team_invitation_one_pending ON team_invitation (team_id, invitee_id) WHERE status = 'PENDING';
CREATE UNIQUE INDEX uq_team_challenge_one_pending ON team_challenge (challenger_team_id, challenged_team_id) WHERE status = 'PENDING';
-- A booking backs at most one non-cancelled match.
CREATE UNIQUE INDEX uq_match_one_active_per_booking ON "match" (booking_id) WHERE booking_id IS NOT NULL AND status <> 'CANCELLED';

-- ───────────────────── 4. Exclusion constraints (overlap protection) ─────────────────────

-- No two active holds (PENDING or CONFIRMED) on the same field may overlap (D1).
-- '[)' ranges: back-to-back bookings (18:00-19:00, 19:00-20:00) are allowed.
ALTER TABLE booking ADD CONSTRAINT booking_no_overlap
  EXCLUDE USING gist (venue_field_id WITH =, time_range WITH &&)
  WHERE (venue_field_id IS NOT NULL AND status IN ('PENDING', 'CONFIRMED'));

-- Blocks never overlap each other on a field.
ALTER TABLE venue_block ADD CONSTRAINT venue_block_no_overlap
  EXCLUDE USING gist (venue_field_id WITH =, time_range WITH &&);

-- A player cannot be CONFIRMED in two overlapping matches (D3). Pending requests are not covered.
ALTER TABLE match_participant ADD CONSTRAINT participant_no_overlap
  EXCLUDE USING gist (user_id WITH =, time_range WITH &&)
  WHERE (status = 'CONFIRMED');

-- ───────────────────── 5. Booking and VenueBlock triggers ─────────────────────

CREATE FUNCTION fym_booking_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_active  boolean;
  v_pending int;
BEGIN
  NEW.time_range := tstzrange(NEW.start_at, NEW.end_at, '[)');

  IF TG_OP = 'INSERT' THEN
    -- (an IN_APP row without a field is left to chk_booking_source_shape)
    IF NEW.source = 'IN_APP' AND NEW.venue_field_id IS NOT NULL THEN
      IF NEW.status <> 'PENDING' THEN RAISE EXCEPTION 'FYM_BOOKING_MUST_START_PENDING'; END IF;
      IF NEW.start_at <= now()   THEN RAISE EXCEPTION 'FYM_BOOKING_IN_PAST'; END IF;

      -- Serialize every writer (bookings AND blocks) touching this field.
      SELECT f.is_active INTO v_active FROM venue_field f WHERE f.id = NEW.venue_field_id FOR NO KEY UPDATE;
      IF v_active IS NOT TRUE THEN RAISE EXCEPTION 'FYM_FIELD_INACTIVE'; END IF;

      -- The DB owns the hold: 2h, but never beyond the start time.
      NEW.hold_expires_at := LEAST(now() + fym_hold_duration(), NEW.start_at);

      -- Lazy expiry: a stale PENDING hold can never block a new request, even if the sweeper is down.
      UPDATE booking SET status = 'EXPIRED'
       WHERE venue_field_id = NEW.venue_field_id AND status = 'PENDING'
         AND hold_expires_at <= now() AND time_range && NEW.time_range;

      IF EXISTS (SELECT 1 FROM venue_block b
                  WHERE b.venue_field_id = NEW.venue_field_id AND b.time_range && NEW.time_range) THEN
        RAISE EXCEPTION 'FYM_SLOT_BLOCKED';
      END IF;

      -- Per-user cap on simultaneous holds (anti slot-hoarding); advisory lock makes the count race-free.
      PERFORM pg_advisory_xact_lock(hashtextextended('fym:pending:' || NEW.created_by_id::text, 0));
      SELECT count(*) INTO v_pending FROM booking b
       WHERE b.created_by_id = NEW.created_by_id AND b.source = 'IN_APP'
         AND b.status = 'PENDING' AND b.hold_expires_at > now();
      IF v_pending >= fym_max_pending_holds() THEN RAISE EXCEPTION 'FYM_TOO_MANY_PENDING'; END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF NEW.source <> OLD.source OR NEW.created_by_id <> OLD.created_by_id THEN
    RAISE EXCEPTION 'FYM_BOOKING_IMMUTABLE';
  END IF;
  IF OLD.source = 'IN_APP' AND (NEW.venue_field_id IS DISTINCT FROM OLD.venue_field_id
                                OR NEW.start_at <> OLD.start_at OR NEW.end_at <> OLD.end_at) THEN
    RAISE EXCEPTION 'FYM_BOOKING_IMMUTABLE';
  END IF;

  IF NEW.status <> OLD.status THEN
    IF NOT ((OLD.status = 'PENDING'   AND NEW.status IN ('CONFIRMED', 'REJECTED', 'CANCELLED', 'EXPIRED'))
         OR (OLD.status = 'CONFIRMED' AND NEW.status IN ('CANCELLED', 'COMPLETED'))) THEN
      RAISE EXCEPTION 'FYM_BOOKING_BAD_TRANSITION';
    END IF;
    -- Owner confirm racing the expiry: decided by DB time, deterministically.
    IF OLD.status = 'PENDING' AND NEW.status = 'CONFIRMED' AND OLD.hold_expires_at <= now() THEN
      RAISE EXCEPTION 'FYM_HOLD_EXPIRED';
    END IF;
    IF NEW.status = 'EXPIRED'   AND OLD.hold_expires_at > now() THEN RAISE EXCEPTION 'FYM_HOLD_NOT_EXPIRED'; END IF;
    IF NEW.status = 'COMPLETED' AND now() < OLD.end_at           THEN RAISE EXCEPTION 'FYM_BOOKING_NOT_ENDED'; END IF;
    IF NEW.status IN ('CONFIRMED', 'REJECTED') AND NEW.decided_at IS NULL THEN NEW.decided_at := now(); END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_booking_guard BEFORE INSERT OR UPDATE ON booking
  FOR EACH ROW EXECUTE FUNCTION fym_booking_guard();

CREATE FUNCTION fym_venue_block_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.time_range := tstzrange(NEW.start_at, NEW.end_at, '[)');

  -- Same per-field lock as bookings => block-vs-booking race is serialized.
  PERFORM 1 FROM venue_field f WHERE f.id = NEW.venue_field_id FOR NO KEY UPDATE;

  UPDATE booking SET status = 'EXPIRED'
   WHERE venue_field_id = NEW.venue_field_id AND status = 'PENDING'
     AND hold_expires_at <= now() AND time_range && NEW.time_range;

  -- Never silently cancel a player's booking: the owner must reject/cancel it first.
  IF EXISTS (SELECT 1 FROM booking b
              WHERE b.venue_field_id = NEW.venue_field_id
                AND b.status IN ('PENDING', 'CONFIRMED') AND b.time_range && NEW.time_range) THEN
    RAISE EXCEPTION 'FYM_BLOCK_CONFLICTS_BOOKING';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_venue_block_guard BEFORE INSERT OR UPDATE ON venue_block
  FOR EACH ROW EXECUTE FUNCTION fym_venue_block_guard();

-- ───────────────────── 6. Match triggers ─────────────────────

-- Validates the optional booking link (also used when match time changes).
CREATE FUNCTION fym_check_match_booking(m "match", p_require_confirmed boolean) RETURNS void LANGUAGE plpgsql AS $$
DECLARE b booking%ROWTYPE;
BEGIN
  IF m.booking_id IS NULL THEN RETURN; END IF;
  SELECT * INTO b FROM booking WHERE id = m.booking_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'FYM_BOOKING_NOT_FOUND'; END IF;
  IF p_require_confirmed AND b.status <> 'CONFIRMED' THEN RAISE EXCEPTION 'FYM_BOOKING_NOT_CONFIRMED'; END IF;
  IF m.type = 'OPEN_MATCH' AND b.created_by_id <> m.organizer_id THEN RAISE EXCEPTION 'FYM_BOOKING_NOT_OWNED'; END IF;
  IF m.start_at < b.start_at OR m.end_at > b.end_at THEN RAISE EXCEPTION 'FYM_MATCH_OUTSIDE_BOOKING'; END IF;
END $$;

CREATE FUNCTION fym_match_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_cnt   int;
  v_admin boolean := coalesce(current_setting('fym.actor_is_admin', true), 'false') = 'true';
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF (NEW.type = 'OPEN_MATCH' AND NEW.status <> 'OPEN')
    OR (NEW.type = 'TEAM_CHALLENGE' AND NEW.status <> 'SCHEDULED') THEN
      RAISE EXCEPTION 'FYM_BAD_INITIAL_STATUS';
    END IF;
    IF NEW.start_at <= now() THEN RAISE EXCEPTION 'FYM_MATCH_IN_PAST'; END IF;
    PERFORM fym_check_match_booking(NEW, true);
    RETURN NEW;
  END IF;

  -- (the row is already locked by the UPDATE itself, so the checks below are race-free)
  IF NEW.type <> OLD.type THEN RAISE EXCEPTION 'FYM_MATCH_TYPE_IMMUTABLE'; END IF;

  -- D12: time/format may change only before start and while nobody is confirmed.
  IF NEW.start_at <> OLD.start_at OR NEW.end_at <> OLD.end_at OR NEW.format <> OLD.format THEN
    IF OLD.status NOT IN ('OPEN', 'FULL', 'SCHEDULED') THEN RAISE EXCEPTION 'FYM_MATCH_TIME_LOCKED'; END IF;
    IF NEW.start_at <= now() THEN RAISE EXCEPTION 'FYM_MATCH_IN_PAST'; END IF;
    IF EXISTS (SELECT 1 FROM match_participant p WHERE p.match_id = OLD.id AND p.status = 'CONFIRMED') THEN
      RAISE EXCEPTION 'FYM_MATCH_TIME_LOCKED';
    END IF;
    PERFORM fym_check_match_booking(NEW, false);
  END IF;

  -- Linking (not unlinking) a booking: only before start, and it must be CONFIRMED.
  IF NEW.booking_id IS DISTINCT FROM OLD.booking_id AND NEW.booking_id IS NOT NULL THEN
    IF OLD.status NOT IN ('OPEN', 'FULL', 'SCHEDULED') THEN RAISE EXCEPTION 'FYM_MATCH_LINK_LOCKED'; END IF;
    PERFORM fym_check_match_booking(NEW, true);
  END IF;

  -- D14: capacity edit (OPEN_MATCH): before start, never below confirmed; recompute OPEN/FULL.
  IF NEW.capacity IS DISTINCT FROM OLD.capacity THEN
    IF OLD.status NOT IN ('OPEN', 'FULL') OR now() >= OLD.start_at THEN RAISE EXCEPTION 'FYM_CAPACITY_LOCKED'; END IF;
    SELECT count(*) INTO v_cnt FROM match_participant p WHERE p.match_id = OLD.id AND p.status = 'CONFIRMED';
    IF NEW.capacity < v_cnt THEN RAISE EXCEPTION 'FYM_CAPACITY_BELOW_CONFIRMED'; END IF;
    NEW.status := CASE WHEN v_cnt >= NEW.capacity THEN 'FULL'::match_status ELSE 'OPEN'::match_status END;
  END IF;

  -- Lifecycle state machine (D5, D15, D16).
  IF NEW.status <> OLD.status THEN
    IF NOT ((OLD.status = 'OPEN'               AND NEW.status IN ('FULL', 'IN_PROGRESS', 'CANCELLED'))
         OR (OLD.status = 'FULL'               AND NEW.status IN ('OPEN', 'IN_PROGRESS', 'CANCELLED'))
         OR (OLD.status = 'SCHEDULED'          AND NEW.status IN ('IN_PROGRESS', 'CANCELLED'))
         OR (OLD.status = 'IN_PROGRESS'        AND NEW.status IN ('COMPLETED', 'CANCELLED', 'CLOSED_UNCONFIRMED'))
         OR (OLD.status = 'CLOSED_UNCONFIRMED' AND NEW.status IN ('COMPLETED', 'CANCELLED'))) THEN
      RAISE EXCEPTION 'FYM_MATCH_BAD_TRANSITION';
    END IF;
    IF NEW.status = 'IN_PROGRESS' AND now() < OLD.start_at THEN RAISE EXCEPTION 'FYM_TOO_EARLY'; END IF;
    IF NEW.status = 'CLOSED_UNCONFIRMED' AND now() < OLD.end_at + fym_unconfirmed_grace() THEN
      RAISE EXCEPTION 'FYM_TOO_EARLY';
    END IF;
    -- Recovery from CLOSED_UNCONFIRMED: organizer within 7 days, admin afterwards.
    -- The service sets: SELECT set_config('fym.actor_is_admin','true', true) for admin actors.
    IF OLD.status = 'CLOSED_UNCONFIRMED'
       AND now() > OLD.closed_unconfirmed_at + fym_unconfirmed_recovery() AND NOT v_admin THEN
      RAISE EXCEPTION 'FYM_RECOVERY_WINDOW_EXPIRED';
    END IF;
    IF NEW.status = 'COMPLETED'          THEN NEW.completed_at          := coalesce(NEW.completed_at, now()); END IF;
    IF NEW.status = 'CANCELLED'          THEN NEW.cancelled_at          := coalesce(NEW.cancelled_at, now()); END IF;
    IF NEW.status = 'CLOSED_UNCONFIRMED' THEN NEW.closed_unconfirmed_at := coalesce(NEW.closed_unconfirmed_at, now()); END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_match_guard BEFORE INSERT OR UPDATE ON "match"
  FOR EACH ROW EXECUTE FUNCTION fym_match_guard();

-- Consequences of a status change, guaranteed by the DB (notifications stay in the service).
CREATE FUNCTION fym_match_after_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'CLOSED_UNCONFIRMED') THEN
    UPDATE match_request SET status = 'EXPIRED', decided_at = coalesce(decided_at, now())
     WHERE match_id = NEW.id AND status = 'PENDING';
    UPDATE match_invitation SET status = 'EXPIRED' WHERE match_id = NEW.id AND status = 'PENDING';
  END IF;
  IF NEW.status = 'CANCELLED' THEN
    -- Frees every player's time slot; not a leave, no reliability impact.
    UPDATE match_participant SET status = 'MATCH_CANCELLED' WHERE match_id = NEW.id AND status = 'CONFIRMED';
  END IF;
  IF NEW.status = 'COMPLETED' THEN
    -- Organizer confirmation finalizes attendance: anyone not marked NO_SHOW attended.
    UPDATE match_participant
       SET attendance_status = 'ATTENDED', attendance_confirmed_at = now(),
           attendance_confirmed_by_id = NEW.completed_by_id
     WHERE match_id = NEW.id AND status = 'CONFIRMED' AND attendance_status = 'UNKNOWN';
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER trg_match_after_status AFTER UPDATE OF status ON "match"
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION fym_match_after_status();

-- TEAM_CHALLENGE must end up with exactly two sides (checked at COMMIT).
CREATE FUNCTION fym_match_teams_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(*) FROM match_team WHERE match_id = NEW.id) <> 2 THEN
    RAISE EXCEPTION 'FYM_TEAM_MATCH_NEEDS_TWO_TEAMS';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER trg_match_teams_complete AFTER INSERT ON "match"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.type = 'TEAM_CHALLENGE')
  EXECUTE FUNCTION fym_match_teams_complete();

CREATE FUNCTION fym_match_team_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_type match_type;
BEGIN
  SELECT type INTO v_type FROM "match" WHERE id = NEW.match_id;
  IF v_type IS DISTINCT FROM 'TEAM_CHALLENGE' THEN RAISE EXCEPTION 'FYM_NOT_TEAM_MATCH'; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_match_team_guard BEFORE INSERT ON match_team
  FOR EACH ROW EXECUTE FUNCTION fym_match_team_guard();

-- ───────────────────── 7. Join requests (the ASK) ─────────────────────

CREATE FUNCTION fym_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m "match"%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Share-lock the match so a concurrent cancel/start cannot slip between check and insert.
    SELECT * INTO m FROM "match" WHERE id = NEW.match_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'FYM_MATCH_NOT_FOUND'; END IF;
    IF m.type <> 'OPEN_MATCH'                THEN RAISE EXCEPTION 'FYM_REQUESTS_NOT_ALLOWED'; END IF;
    IF m.status <> 'OPEN'                    THEN RAISE EXCEPTION 'FYM_MATCH_NOT_OPEN'; END IF;   -- FULL/CANCELLED/... refuse
    IF now() >= m.start_at                   THEN RAISE EXCEPTION 'FYM_MATCH_STARTED'; END IF;
    IF m.organizer_id = NEW.user_id          THEN RAISE EXCEPTION 'FYM_ORGANIZER_CANNOT_REQUEST'; END IF;
    IF NEW.status <> 'PENDING'               THEN RAISE EXCEPTION 'FYM_REQUEST_MUST_START_PENDING'; END IF;
    IF EXISTS (SELECT 1 FROM match_participant p
                WHERE p.match_id = NEW.match_id AND p.user_id = NEW.user_id AND p.status = 'CONFIRMED') THEN
      RAISE EXCEPTION 'FYM_ALREADY_PARTICIPANT';
    END IF;
    IF m.visibility = 'PRIVATE' AND NOT EXISTS (
         SELECT 1 FROM match_invitation i
          WHERE i.match_id = NEW.match_id AND i.invitee_id = NEW.user_id AND i.status IN ('PENDING', 'ACCEPTED')) THEN
      RAISE EXCEPTION 'FYM_PRIVATE_NOT_INVITED';
    END IF;
    IF EXISTS (SELECT 1 FROM blocked_user b
                WHERE (b.blocker_id = m.organizer_id AND b.blocked_id = NEW.user_id)
                   OR (b.blocker_id = NEW.user_id    AND b.blocked_id = m.organizer_id)) THEN
      RAISE EXCEPTION 'FYM_BLOCKED';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: a decided request is final.
  IF OLD.status <> 'PENDING' AND NEW.status <> OLD.status THEN RAISE EXCEPTION 'FYM_REQUEST_FINAL'; END IF;
  IF NEW.status <> OLD.status AND NEW.decided_at IS NULL THEN NEW.decided_at := now(); END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_request_guard BEFORE INSERT OR UPDATE ON match_request
  FOR EACH ROW EXECUTE FUNCTION fym_request_guard();

-- ───────────────────── 8. Participants (confirmed membership) ─────────────────────
-- THE capacity guard. Order matters: (1) lock the match row, (2) count CONFIRMED rows
-- with a fresh statement, (3) allow/deny. Because every confirmation takes the same
-- row lock, two concurrent approvals are serialized and the loser sees the winner's row.

CREATE FUNCTION fym_participant_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  m            "match"%ROWTYPE;
  v_confirming boolean;
BEGIN
  SELECT * INTO m FROM "match" WHERE id = NEW.match_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FYM_MATCH_NOT_FOUND'; END IF;

  -- Copy of the match window drives the anti-overlap exclusion constraint.
  NEW.time_range := tstzrange(m.start_at, m.end_at, '[)');

  IF TG_OP = 'INSERT' AND NEW.status <> 'CONFIRMED' THEN RAISE EXCEPTION 'FYM_PARTICIPANT_MUST_START_CONFIRMED'; END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.match_id <> OLD.match_id OR NEW.user_id <> OLD.user_id THEN RAISE EXCEPTION 'FYM_PARTICIPANT_KEYS_IMMUTABLE'; END IF;
    IF NEW.status <> OLD.status AND NOT (
         (OLD.status = 'CONFIRMED'              AND NEW.status IN ('LEFT', 'REMOVED', 'MATCH_CANCELLED'))
      OR (OLD.status IN ('LEFT', 'REMOVED')     AND NEW.status = 'CONFIRMED')) THEN
      RAISE EXCEPTION 'FYM_PARTICIPANT_BAD_TRANSITION';
    END IF;
  END IF;

  v_confirming := NEW.status = 'CONFIRMED' AND (TG_OP = 'INSERT' OR OLD.status <> 'CONFIRMED');

  IF v_confirming THEN
    IF m.type = 'OPEN_MATCH' THEN
      IF m.status NOT IN ('OPEN', 'FULL') OR now() >= m.start_at THEN RAISE EXCEPTION 'FYM_MATCH_NOT_ACCEPTING'; END IF;
      IF NEW.match_team_id IS NOT NULL THEN RAISE EXCEPTION 'FYM_TEAM_NOT_ALLOWED'; END IF;
      IF (SELECT count(*) FROM match_participant p
           WHERE p.match_id = NEW.match_id AND p.status = 'CONFIRMED' AND p.id <> NEW.id) >= m.capacity THEN
        RAISE EXCEPTION 'FYM_MATCH_FULL';
      END IF;
    ELSE  -- TEAM_CHALLENGE: roster per side, no recruitment capacity
      IF m.status <> 'SCHEDULED' OR now() >= m.start_at THEN RAISE EXCEPTION 'FYM_MATCH_NOT_ACCEPTING'; END IF;
      IF NEW.match_team_id IS NULL THEN RAISE EXCEPTION 'FYM_TEAM_REQUIRED'; END IF;
      IF NOT EXISTS (SELECT 1 FROM match_team t WHERE t.id = NEW.match_team_id AND t.match_id = NEW.match_id) THEN
        RAISE EXCEPTION 'FYM_TEAM_NOT_IN_MATCH';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM match_team t JOIN team_member tm ON tm.team_id = t.team_id
                      WHERE t.id = NEW.match_team_id AND tm.user_id = NEW.user_id) THEN
        RAISE EXCEPTION 'FYM_NOT_TEAM_MEMBER';
      END IF;
      IF (SELECT count(*) FROM match_participant p
           WHERE p.match_team_id = NEW.match_team_id AND p.status = 'CONFIRMED' AND p.id <> NEW.id)
         >= fym_format_size(m.format) THEN
        RAISE EXCEPTION 'FYM_ROSTER_FULL';
      END IF;
    END IF;
    IF TG_OP = 'UPDATE' THEN  -- re-activation of a LEFT/REMOVED row starts a fresh record
      NEW.joined_at := now(); NEW.left_at := NULL; NEW.is_late_cancellation := false;
      NEW.attendance_status := 'UNKNOWN'; NEW.attendance_confirmed_at := NULL; NEW.attendance_confirmed_by_id := NULL;
    END IF;

  ELSIF TG_OP = 'UPDATE' AND NEW.status <> OLD.status THEN   -- leaving CONFIRMED
    IF NEW.status = 'MATCH_CANCELLED' THEN
      IF m.status <> 'CANCELLED' THEN RAISE EXCEPTION 'FYM_MATCH_NOT_CANCELLED'; END IF;
      NEW.left_at := now();
    ELSE   -- LEFT (player) or REMOVED (organizer): only before start (D4)
      IF now() >= m.start_at OR m.status NOT IN ('OPEN', 'FULL', 'SCHEDULED') THEN RAISE EXCEPTION 'FYM_MATCH_STARTED'; END IF;
      NEW.left_at := now();
      NEW.is_late_cancellation := (NEW.status = 'LEFT' AND (m.start_at - now()) < fym_late_cancel_window());
    END IF;
  END IF;

  -- No-show / attendance: only for confirmed participants, only once the match has started.
  IF TG_OP = 'UPDATE' AND NEW.attendance_status <> OLD.attendance_status THEN
    IF NEW.status <> 'CONFIRMED' THEN RAISE EXCEPTION 'FYM_ATTENDANCE_NOT_CONFIRMED_PARTICIPANT'; END IF;
    IF m.status NOT IN ('IN_PROGRESS', 'COMPLETED', 'CLOSED_UNCONFIRMED') THEN RAISE EXCEPTION 'FYM_ATTENDANCE_TOO_EARLY'; END IF;
    NEW.attendance_confirmed_at := coalesce(NEW.attendance_confirmed_at, now());
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_participant_guard BEFORE INSERT OR UPDATE ON match_participant
  FOR EACH ROW EXECUTE FUNCTION fym_participant_guard();

-- Keep OPEN/FULL in sync with the derived count, inside the same transaction.
CREATE FUNCTION fym_participant_after() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_cap    int;
  v_cnt    int;
  v_target match_status;
BEGIN
  SELECT capacity INTO v_cap FROM "match"
   WHERE id = NEW.match_id AND type = 'OPEN_MATCH' AND status IN ('OPEN', 'FULL');
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT count(*) INTO v_cnt FROM match_participant WHERE match_id = NEW.match_id AND status = 'CONFIRMED';
  v_target := CASE WHEN v_cnt >= v_cap THEN 'FULL'::match_status ELSE 'OPEN'::match_status END;
  UPDATE "match" SET status = v_target WHERE id = NEW.match_id AND status <> v_target;
  RETURN NULL;
END $$;

CREATE TRIGGER trg_participant_after AFTER INSERT OR UPDATE OF status ON match_participant
  FOR EACH ROW EXECUTE FUNCTION fym_participant_after();

-- ───────────────────── 9. Reviews ─────────────────────

CREATE FUNCTION fym_review_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m "match"%ROWTYPE;
BEGIN
  SELECT * INTO m FROM "match" WHERE id = NEW.match_id;
  IF m.status <> 'COMPLETED' THEN RAISE EXCEPTION 'FYM_MATCH_NOT_COMPLETED'; END IF;
  IF now() > m.completed_at + fym_review_window() THEN RAISE EXCEPTION 'FYM_REVIEW_WINDOW_CLOSED'; END IF;
  IF NOT EXISTS (SELECT 1 FROM match_participant p WHERE p.match_id = NEW.match_id AND p.user_id = NEW.reviewer_id
                  AND p.status = 'CONFIRMED' AND p.attendance_status = 'ATTENDED') THEN
    RAISE EXCEPTION 'FYM_REVIEWER_NOT_ATTENDEE';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM match_participant p WHERE p.match_id = NEW.match_id AND p.user_id = NEW.reviewed_id
                  AND p.status = 'CONFIRMED' AND p.attendance_status = 'ATTENDED') THEN
    RAISE EXCEPTION 'FYM_REVIEWED_NOT_ATTENDEE';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_review_guard BEFORE INSERT ON review
  FOR EACH ROW EXECUTE FUNCTION fym_review_guard();

-- ───────────────────── 10. Derived availability (D17: never stored) ─────────────────────

CREATE VIEW match_availability AS
SELECT m.id AS match_id,
       m.capacity,
       c.confirmed_count,
       (m.capacity - c.confirmed_count) AS available_spots
  FROM "match" m
 CROSS JOIN LATERAL (
       SELECT count(*)::int AS confirmed_count
         FROM match_participant p
        WHERE p.match_id = m.id AND p.status = 'CONFIRMED') c
 WHERE m.type = 'OPEN_MATCH';

-- ───────────────────── 11. Performance indexes Prisma cannot express ─────────────────────

-- The capacity count: tiny, hot, partial.
CREATE INDEX idx_participant_confirmed ON match_participant (match_id) WHERE status = 'CONFIRMED';

-- Public discovery.
CREATE INDEX idx_match_discovery ON "match" (start_at)
  WHERE type = 'OPEN_MATCH' AND status IN ('OPEN', 'FULL') AND visibility = 'PUBLIC';

-- Lifecycle sweepers.
CREATE INDEX idx_match_to_start ON "match" (start_at) WHERE status IN ('OPEN', 'FULL', 'SCHEDULED');
CREATE INDEX idx_match_to_close ON "match" (end_at)   WHERE status = 'IN_PROGRESS';
CREATE INDEX idx_booking_pending_holds ON booking (hold_expires_at) WHERE status = 'PENDING';
CREATE INDEX idx_booking_to_complete   ON booking (end_at)          WHERE status = 'CONFIRMED';

-- "Nearby" queries: WHERE earth_box(ll_to_earth($lat,$lng), $meters) @> ll_to_earth(latitude, longitude)
--                    AND earth_distance(...) <= $meters
CREATE INDEX idx_venue_geo  ON venue USING gist (ll_to_earth(latitude, longitude));
CREATE INDEX idx_match_geo  ON "match" USING gist (ll_to_earth(latitude, longitude)) WHERE latitude IS NOT NULL;
CREATE INDEX idx_player_geo ON player_profile USING gist (ll_to_earth(latitude, longitude)) WHERE latitude IS NOT NULL;

-- Notifications: inbox index (user_id, created_at DESC) is declared in schema.prisma;
-- unread badge and push outbox are partial, so they live here.
CREATE INDEX idx_notification_unread ON notification (user_id) WHERE read_at IS NULL;
CREATE INDEX idx_notification_push   ON notification (created_at) WHERE push_sent_at IS NULL;
