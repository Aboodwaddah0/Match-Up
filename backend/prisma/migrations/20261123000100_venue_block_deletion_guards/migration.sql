-- ============================================================================
-- PRIV-01 review fix: a future VenueBlock must not appear on an owned venue while the owner's account is being deleted.
--
-- WHY. Account deletion refuses to run while the owner's venues have future blocks. Without these triggers a block inserted by the owner's
-- second session, or by a staff member / admin, after the deletion's blocker check but before its commit would slip through. The deletion
-- now locks the venues the user owns (`SELECT ... FOR NO KEY UPDATE`, in id order, after the user row and before it evaluates anything), and:
--
--  * trg_00_active_user_guard (the existing fym_active_user_guard) now also covers venue_block.created_by_id: it takes FOR SHARE on the
--    CREATOR's user row and refuses a DELETED creator, so a deleted owner's own late session cannot create a block. Staff and admins create
--    blocks as themselves, so they stay able to manage the venue after its owner has been deleted.
--  * trg_01_venue_block_venue_share takes FOR SHARE on the VENUE row (reached through the field). FOR SHARE conflicts with the deletion's
--    NO KEY UPDATE on the same row, so an in-flight block makes the deletion wait and then see it, and a block that starts later waits for the
--    deletion. It conflicts with nothing else that matters: foreign-key checks take FOR KEY SHARE, which does not conflict with NO KEY UPDATE.
--
-- LOCK ORDER (all verified against the code that takes these locks): user row -> venue row -> field row -> booking rows.
--  * both triggers are named trg_0*, so they fire BEFORE the existing trg_venue_block_guard, which takes the field row: venue before field,
--    exactly as bookings (trg_00_active_user_guard -> trg_01_booking_venue_active -> trg_booking_guard) and lockVenue-based admin changes do;
--  * nothing takes a field row and then asks for its venue row, so no cycle can form with the deletion (user row -> venue rows) either.
--
-- No existing function or trigger is changed and no row is touched.
-- Rollback: DROP TRIGGER trg_00_active_user_guard / trg_01_venue_block_venue_share ON venue_block; DROP FUNCTION fym_venue_block_venue_share().
-- ============================================================================

CREATE TRIGGER trg_00_active_user_guard BEFORE INSERT ON venue_block
  FOR EACH ROW EXECUTE FUNCTION fym_active_user_guard('created_by_id');

CREATE FUNCTION fym_venue_block_venue_share() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM venue_field f JOIN venue v ON v.id = f.venue_id WHERE f.id = NEW.venue_field_id FOR SHARE OF v;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_01_venue_block_venue_share BEFORE INSERT ON venue_block
  FOR EACH ROW EXECUTE FUNCTION fym_venue_block_venue_share();
