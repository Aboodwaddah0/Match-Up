-- ============================================================================
-- Media: cleanup of STRAY provider objects after a successful confirmation (follow-up of 20261124000200_media_items).
--
-- WHY. The Cloudinary upload signature does not cover the RESOURCE TYPE (it is part of the upload URL), so a client holding a valid signature can
-- also upload a file under another resource type than the one confirmed ("image" for a video slot, "video" or "raw" for a photo slot; a raw file is
-- stored as "<key>.<extension>"). Confirmation verifies only the expected type; this adds what happens to the others once the item is READY.
-- The signature stays usable for one hour (verified against the live service: a timestamp up to ~3,600 s old is accepted, older ones are refused, and
-- the check happens when the request has been received IN FULL, so a slow upload cannot complete after the window; only the provider's own
-- processing of a request received just before the expiry can reach past it). Each READY item therefore gets THREE idempotent sweeps, tracked here:
--     stray_sweeps_left = 3  -> due at confirmation                       (anything uploaded before the confirmation)
--     stray_sweeps_left = 2  -> due 70 minutes after the slot was created (anything uploaded inside the window: no new upload can complete after it)
--     stray_sweeps_left = 1  -> due 24 hours after the slot was created   (insurance against a request still being processed when the window closed)
--     stray_sweeps_left = 0  -> done, nothing scheduled
-- A failed sweep keeps its place and is retried with backoff (the READY item is never touched by it). Anything that is still left when the item is
-- finally deleted is removed by the deletion worker, which sweeps every resource type (and which keeps a deleted row, hidden, until the upload window
-- has closed, so a signature that is still valid cannot be used to create an asset that has no row).
--
-- BACKFILL. A database that already applied 20261124000200_media_items may hold READY items without a schedule. They get one, by age, so the cost
-- stays bounded: an item older than 24 h needs one sweep, older than 70 min two, a younger one three. (The media feature had never been deployed
-- when this migration was written: no release contained the media tables, so on a fresh deployment this UPDATE touches no row.)
--
-- Additive: four columns with defaults, one CHECK, one partial index, fym_media_guard() re-created with the new columns allowed to change, and the
-- backfill. Rollback: DROP INDEX idx_media_stray_due; ALTER TABLE media_item DROP CONSTRAINT chk_media_stray_shape and DROP the four columns;
-- restore the previous fym_media_guard() from 20261124000200_media_items.
-- ============================================================================

-- AlterTable
ALTER TABLE "media_item" ADD COLUMN     "last_stray_error" TEXT,
ADD COLUMN     "stray_sweep_at" TIMESTAMPTZ(6),
ADD COLUMN     "stray_sweep_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "stray_sweeps_left" SMALLINT NOT NULL DEFAULT 0;

-- A sweep is scheduled only for a READY item; when none is left the bookkeeping is empty.
ALTER TABLE "media_item"
  ADD CONSTRAINT chk_media_stray_shape CHECK (
    stray_sweeps_left BETWEEN 0 AND 3
    AND (
      (stray_sweeps_left = 0 AND stray_sweep_at IS NULL AND stray_sweep_attempts = 0 AND last_stray_error IS NULL)
      OR (stray_sweeps_left > 0 AND stray_sweep_at IS NOT NULL AND status = 'READY')));

-- the worker's queue: READY items with a sweep to do
CREATE INDEX idx_media_stray_due ON media_item (stray_sweep_at) WHERE stray_sweeps_left > 0;

-- Same state machine as before; the stray_* columns may now change where a sweep can be scheduled, advanced or cleared:
--   PENDING -> READY (scheduled), READY -> READY (advanced / retried), any -> DELETING (cleared).
CREATE OR REPLACE FUNCTION fym_media_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_allowed text[];
BEGIN
  IF OLD.status = NEW.status THEN
    v_allowed := CASE OLD.status
      WHEN 'READY' THEN ARRAY['caption', 'sort_order', 'updated_at', 'stray_sweeps_left', 'stray_sweep_at', 'stray_sweep_attempts', 'last_stray_error']
      WHEN 'DELETING' THEN ARRAY['deletion_attempts', 'next_deletion_at', 'deletion_claim_id', 'deletion_lease_until', 'last_deletion_error', 'updated_at']
      ELSE ARRAY['updated_at']
    END;
  ELSIF OLD.status = 'PENDING' AND NEW.status = 'READY' THEN
    v_allowed := ARRAY['status', 'url', 'thumbnail_url', 'mime_type', 'size_bytes', 'width', 'height', 'duration_ms', 'sort_order', 'confirmed_at', 'updated_at',
                       'stray_sweeps_left', 'stray_sweep_at'];
  ELSIF OLD.status IN ('PENDING', 'READY') AND NEW.status = 'DELETING' THEN
    v_allowed := ARRAY['status', 'url', 'thumbnail_url', 'deleting_since', 'next_deletion_at', 'updated_at',
                       'stray_sweeps_left', 'stray_sweep_at', 'stray_sweep_attempts', 'last_stray_error'];
  ELSE
    RAISE EXCEPTION 'FYM_MEDIA_BAD_TRANSITION';
  END IF;
  IF (to_jsonb(NEW) - v_allowed) IS DISTINCT FROM (to_jsonb(OLD) - v_allowed) THEN
    RAISE EXCEPTION 'FYM_MEDIA_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;

-- BACKFILL: schedule the sweeps of READY items that exist already (after the guard above allows it). Due at once; the worker takes at most 10 per pass.
UPDATE media_item
   SET stray_sweeps_left = CASE
         WHEN created_at <= now() - interval '24 hours' THEN 1
         WHEN created_at <= now() - interval '70 minutes' THEN 2
         ELSE 3
       END,
       stray_sweep_at = now()
 WHERE status = 'READY' AND stray_sweeps_left = 0;
