-- ============================================================================
-- PRIV-01 / D18: guards that stop a DELETED account from gaining new dependencies, and the venue-ACTIVE booking guard.
--
-- WHY. Account deletion checks its blockers and then anonymizes the user in ONE transaction that first takes
-- `SELECT ... FROM "user" FOR NO KEY UPDATE` on the user row. Anything that creates a row depending on that user must
-- therefore queue behind (or ahead of) the deletion, and must be refused once the account is DELETED, otherwise a request
-- that was already past authentication could add a match, booking, venue, ... after the blocker check passed.
--
-- LOCK BEHAVIOUR (documented on purpose):
--  * fym_active_user_guard() runs BEFORE INSERT on the tables below and reads the referenced user with FOR SHARE.
--    FOR SHARE conflicts with the deletion's FOR NO KEY UPDATE and with nothing else that matters: foreign-key checks
--    (notifications, events, ...) only take FOR KEY SHARE, which does not conflict with NO KEY UPDATE, and BIZ-02's
--    challenge acceptance also takes FOR SHARE on that row (share + share is compatible).
--      - deletion already holds the row  -> the insert waits, then sees status DELETED and is refused (FYM_USER_DELETED);
--      - the insert already holds a share -> the deletion waits for it, then its blocker check SEES the new row.
--  * The trigger is named trg_00_* so that it fires FIRST: the user row is always locked before any other lock the
--    insert needs (field locks, match locks), the same order the deletion uses (user row first).
--  * Only DELETED is refused. ACTIVE and SUSPENDED accounts behave exactly as before.
--  * fym_booking_venue_active() reads the venue with FOR SHARE, so a booking request and a venue deactivation /
--    suspension serialize: either the booking is in before the venue stops being ACTIVE (and the owner's deletion then
--    sees it) or it is refused. It fires after the user guard and before the existing booking guard (which takes the field lock).
--
-- No existing function or trigger is changed and no row is touched.
-- Rollback: DROP TRIGGER ... and DROP FUNCTION for the objects created here.
-- ============================================================================

CREATE FUNCTION fym_active_user_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_user   uuid;
  v_status account_status;
BEGIN
  v_user := (to_jsonb(NEW) ->> TG_ARGV[0])::uuid;
  IF v_user IS NULL THEN RETURN NEW; END IF;
  SELECT status INTO v_status FROM "user" WHERE id = v_user FOR SHARE;
  IF v_status = 'DELETED' THEN RAISE EXCEPTION 'FYM_USER_DELETED'; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_00_active_user_guard BEFORE INSERT ON "match"
  FOR EACH ROW EXECUTE FUNCTION fym_active_user_guard('organizer_id');
CREATE TRIGGER trg_00_active_user_guard BEFORE INSERT ON booking
  FOR EACH ROW EXECUTE FUNCTION fym_active_user_guard('created_by_id');
CREATE TRIGGER trg_00_active_user_guard BEFORE INSERT ON venue
  FOR EACH ROW EXECUTE FUNCTION fym_active_user_guard('owner_id');
CREATE TRIGGER trg_00_active_user_guard BEFORE INSERT ON venue_staff
  FOR EACH ROW EXECUTE FUNCTION fym_active_user_guard('user_id');
CREATE TRIGGER trg_00_active_user_guard BEFORE INSERT ON match_request
  FOR EACH ROW EXECUTE FUNCTION fym_active_user_guard('user_id');
CREATE TRIGGER trg_00_active_user_guard BEFORE INSERT ON team_member
  FOR EACH ROW EXECUTE FUNCTION fym_active_user_guard('user_id');
CREATE TRIGGER trg_00_active_user_guard BEFORE INSERT ON team_challenge
  FOR EACH ROW EXECUTE FUNCTION fym_active_user_guard('organizer_id');
-- a captaincy transfer or a promotion changes the role of an EXISTING membership
CREATE TRIGGER trg_00_active_user_guard_role BEFORE UPDATE OF role ON team_member
  FOR EACH ROW WHEN (OLD.role IS DISTINCT FROM NEW.role)
  EXECUTE FUNCTION fym_active_user_guard('user_id');

CREATE FUNCTION fym_booking_venue_active() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status venue_status;
BEGIN
  IF NEW.venue_field_id IS NULL THEN RETURN NEW; END IF; -- EXTERNAL bookings reserve no registered venue
  SELECT v.status INTO v_status FROM venue_field f JOIN venue v ON v.id = f.venue_id WHERE f.id = NEW.venue_field_id FOR SHARE OF v;
  IF v_status IS DISTINCT FROM 'ACTIVE' THEN RAISE EXCEPTION 'FYM_VENUE_NOT_ACTIVE'; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_01_booking_venue_active BEFORE INSERT ON booking
  FOR EACH ROW EXECUTE FUNCTION fym_booking_venue_active();
