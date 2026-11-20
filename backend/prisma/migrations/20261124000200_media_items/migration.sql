-- ============================================================================
-- Media (photos and videos of players and teams), part 2 of 2: the media_item table, its constraints, indexes and triggers.
-- Part 1 (20261124000100_media_enums) added the report / audit enum values; they are committed, so nothing here depends on an uncommitted value.
--
-- MODEL. One row per file. Exactly one owner (a user = player media, or a team). The binary lives at the storage provider (Cloudinary now, S3
-- possible later: provider + storage_key); the row holds the reference and the metadata the SERVER verified at confirmation, never what the
-- client claimed.
--   PENDING  an upload slot was issued; no URL yet; not visible anywhere.
--   READY    verified (type, size, duration); has the https delivery URL; the only status any list or report may show.
--   DELETING hidden and URL-less, waiting for the media worker to delete the object at the provider. The ROW is deleted only after that, so a
--            storage key is never lost (a database cascade would leave the file behind). A trigger refuses DELETE of any other status.
--
-- LOCKS (documented on purpose, they are the point of the cap trigger):
--  * trg_000_media_cap fires FIRST (byte order: "trg_000_" sorts before "trg_00_") and locks the OWNER row (user or team) FOR NO KEY UPDATE, then
--    counts. Two simultaneous uploads for the same owner queue on that lock, so the second one counts the first one's row: the cap cannot be
--    overrun. It must come BEFORE fym_active_user_guard (FOR SHARE on the user row): two sessions that both hold SHARE and then ask for
--    NO KEY UPDATE would deadlock. Taking the stronger lock first makes the later SHARE a no-op. Account deletion locks the user row
--    FOR NO KEY UPDATE first as well.
--  * Status changes never re-count: only INSERT adds to the cap, and the state machine forbids leaving DELETING, so no update can move a row
--    back into the counted statuses.
--
-- LIMITS mirrored from the API (src/modules/media/media.limits.ts): photo 10 MiB, video 100 MiB and 60 s, 30 items per player, 50 per team.
--
-- Rollback: DROP the triggers and functions, then DROP TABLE "media_item" and the three types. List and delete the files at the provider first
-- (SELECT storage_key FROM media_item), because the rows are the only record of them.
-- ============================================================================

-- CreateEnum
CREATE TYPE "media_kind" AS ENUM ('PHOTO', 'VIDEO');

-- CreateEnum
CREATE TYPE "media_status" AS ENUM ('PENDING', 'READY', 'DELETING');

-- CreateEnum
CREATE TYPE "storage_provider" AS ENUM ('CLOUDINARY', 'S3');

-- CreateTable
CREATE TABLE "media_item" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "owner_user_id" UUID,
    "team_id" UUID,
    "uploaded_by_id" UUID NOT NULL,
    "kind" "media_kind" NOT NULL,
    "status" "media_status" NOT NULL DEFAULT 'PENDING',
    "provider" "storage_provider" NOT NULL DEFAULT 'CLOUDINARY',
    "storage_key" TEXT NOT NULL,
    "url" TEXT,
    "thumbnail_url" TEXT,
    "mime_type" TEXT NOT NULL,
    "size_bytes" BIGINT,
    "width" INTEGER,
    "height" INTEGER,
    "duration_ms" INTEGER,
    "caption" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleting_since" TIMESTAMPTZ(6),
    "deletion_attempts" INTEGER NOT NULL DEFAULT 0,
    "next_deletion_at" TIMESTAMPTZ(6),
    "deletion_claim_id" UUID,
    "deletion_lease_until" TIMESTAMPTZ(6),
    "last_deletion_error" TEXT,

    CONSTRAINT "media_item_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "media_item_uploaded_by_id_idx" ON "media_item"("uploaded_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "media_item_provider_storage_key_key" ON "media_item"("provider", "storage_key");

-- AddForeignKey
ALTER TABLE "media_item" ADD CONSTRAINT "media_item_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_item" ADD CONSTRAINT "media_item_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_item" ADD CONSTRAINT "media_item_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ───────────────────────── constraints ─────────────────────────

ALTER TABLE "media_item"
  -- exactly one owner
  ADD CONSTRAINT chk_media_one_owner CHECK ((owner_user_id IS NULL) <> (team_id IS NULL)),
  -- a player's media is uploaded by that player (team media records WHO uploaded it, who need not be the owner)
  ADD CONSTRAINT chk_media_player_self_upload CHECK (owner_user_id IS NULL OR uploaded_by_id = owner_user_id),
  -- supported formats: photos JPEG PNG WebP HEIC; videos MP4 and QuickTime (MOV). The original type is kept (HEIC stays image/heic).
  ADD CONSTRAINT chk_media_kind_mime CHECK (
    (kind = 'PHOTO' AND mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'image/heic'))
    OR (kind = 'VIDEO' AND mime_type IN ('video/mp4', 'video/quicktime'))),
  -- size: 10 MiB per photo, 100 MiB per video (set at confirmation from the provider's figure)
  ADD CONSTRAINT chk_media_size CHECK (
    size_bytes IS NULL
    OR (size_bytes > 0 AND ((kind = 'PHOTO' AND size_bytes <= 10485760) OR (kind = 'VIDEO' AND size_bytes <= 104857600)))),
  -- duration: videos only, at most 60 seconds
  ADD CONSTRAINT chk_media_duration CHECK (
    (kind = 'PHOTO' AND duration_ms IS NULL)
    OR (kind = 'VIDEO' AND (duration_ms IS NULL OR duration_ms BETWEEN 1 AND 60000))),
  ADD CONSTRAINT chk_media_dimensions CHECK ((width IS NULL OR width > 0) AND (height IS NULL OR height > 0)),
  ADD CONSTRAINT chk_media_sort_order CHECK (sort_order >= 0),
  -- optional caption: at most 300 characters, never blank
  ADD CONSTRAINT chk_media_caption CHECK (caption IS NULL OR (char_length(caption) <= 300 AND btrim(caption) <> '')),
  ADD CONSTRAINT chk_media_storage_key CHECK (btrim(storage_key) <> ''),
  ADD CONSTRAINT chk_media_thumbnail_https CHECK (thumbnail_url IS NULL OR thumbnail_url ~ '^https://'),
  -- URL lifecycle. PENDING has no delivery URL; READY has a valid https URL, a confirmation time, the verified size (and a duration for videos).
  -- "url IS NOT NULL AND ..." is explicit on purpose: a regex match on NULL is NULL, and a CHECK lets NULL through.
  ADD CONSTRAINT chk_media_pending_shape CHECK (status <> 'PENDING' OR (url IS NULL AND thumbnail_url IS NULL AND confirmed_at IS NULL)),
  ADD CONSTRAINT chk_media_ready_shape CHECK (
    status <> 'READY'
    OR (url IS NOT NULL AND url ~ '^https://' AND confirmed_at IS NOT NULL AND size_bytes IS NOT NULL AND (kind = 'PHOTO' OR duration_ms IS NOT NULL))),
  -- DELETING has no URL (nothing may still point at it) and is scheduled for the worker
  ADD CONSTRAINT chk_media_deleting_shape CHECK (
    status <> 'DELETING' OR (url IS NULL AND thumbnail_url IS NULL AND deleting_since IS NOT NULL AND next_deletion_at IS NOT NULL)),
  -- deletion bookkeeping exists only while DELETING
  ADD CONSTRAINT chk_media_deletion_columns CHECK (
    status = 'DELETING'
    OR (deleting_since IS NULL AND next_deletion_at IS NULL AND deletion_claim_id IS NULL AND deletion_lease_until IS NULL
        AND last_deletion_error IS NULL AND deletion_attempts = 0));

-- ───────────────────────── indexes (partial ones are invisible to Prisma, like the other hand-written indexes) ─────────────────────────

-- the lists shown to people: READY only, in display order
CREATE INDEX idx_media_owner_ready ON media_item (owner_user_id, sort_order, created_at) WHERE status = 'READY' AND owner_user_id IS NOT NULL;
CREATE INDEX idx_media_team_ready ON media_item (team_id, sort_order, created_at) WHERE status = 'READY' AND team_id IS NOT NULL;
-- the cap count (PENDING + READY) and the account-deletion sweep of a user's media
CREATE INDEX idx_media_owner_live ON media_item (owner_user_id) WHERE status <> 'DELETING' AND owner_user_id IS NOT NULL;
CREATE INDEX idx_media_team_live ON media_item (team_id) WHERE status <> 'DELETING' AND team_id IS NOT NULL;
-- the worker: files waiting to be deleted at the provider, and uploads that were never confirmed
CREATE INDEX idx_media_deleting_due ON media_item (next_deletion_at) WHERE status = 'DELETING';
CREATE INDEX idx_media_pending_created ON media_item (created_at) WHERE status = 'PENDING';

-- ───────────────────────── triggers ─────────────────────────

-- Cap per owner, enforced under the owner row lock (see the header). The message FYM_MEDIA_LIMIT is mapped to 409 MEDIA_LIMIT_REACHED.
-- Each statement in a volatile plpgsql function takes a fresh snapshot (READ COMMITTED), so the count after the lock sees the row the previous
-- lock holder committed.
CREATE FUNCTION fym_media_cap() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_count int;
  v_limit int;
BEGIN
  IF NEW.owner_user_id IS NOT NULL THEN
    PERFORM 1 FROM "user" WHERE id = NEW.owner_user_id FOR NO KEY UPDATE;
    SELECT count(*) INTO v_count FROM media_item WHERE owner_user_id = NEW.owner_user_id AND status <> 'DELETING';
    v_limit := 30;
  ELSE
    PERFORM 1 FROM team WHERE id = NEW.team_id FOR NO KEY UPDATE;
    SELECT count(*) INTO v_count FROM media_item WHERE team_id = NEW.team_id AND status <> 'DELETING';
    v_limit := 50;
  END IF;
  IF v_count >= v_limit THEN RAISE EXCEPTION 'FYM_MEDIA_LIMIT'; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_000_media_cap BEFORE INSERT ON media_item
  FOR EACH ROW EXECUTE FUNCTION fym_media_cap();

-- A DELETED account gains no media (PRIV-01 guard, the same function as on the other tables). For player media owner and uploader are one user.
CREATE TRIGGER trg_00_active_user_guard_owner BEFORE INSERT ON media_item
  FOR EACH ROW EXECUTE FUNCTION fym_active_user_guard('owner_user_id');
CREATE TRIGGER trg_00_active_user_guard_uploader BEFORE INSERT ON media_item
  FOR EACH ROW EXECUTE FUNCTION fym_active_user_guard('uploaded_by_id');

-- State machine and immutability. Allowed moves: PENDING -> READY, PENDING -> DELETING, READY -> DELETING. Nothing leaves DELETING, so a row can
-- never come back into the cap count. Who / what / where (owner, team, uploader, kind, provider, key, created_at) never changes. Within a status
-- only the columns listed below may change: READY keeps its verified metadata, only the caption and the order are editable.
CREATE FUNCTION fym_media_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_allowed text[];
BEGIN
  IF OLD.status = NEW.status THEN
    v_allowed := CASE OLD.status
      WHEN 'READY' THEN ARRAY['caption', 'sort_order', 'updated_at']
      WHEN 'DELETING' THEN ARRAY['deletion_attempts', 'next_deletion_at', 'deletion_claim_id', 'deletion_lease_until', 'last_deletion_error', 'updated_at']
      ELSE ARRAY['updated_at']
    END;
  ELSIF OLD.status = 'PENDING' AND NEW.status = 'READY' THEN
    v_allowed := ARRAY['status', 'url', 'thumbnail_url', 'mime_type', 'size_bytes', 'width', 'height', 'duration_ms', 'sort_order', 'confirmed_at', 'updated_at'];
  ELSIF OLD.status IN ('PENDING', 'READY') AND NEW.status = 'DELETING' THEN
    v_allowed := ARRAY['status', 'url', 'thumbnail_url', 'deleting_since', 'next_deletion_at', 'updated_at'];
  ELSE
    RAISE EXCEPTION 'FYM_MEDIA_BAD_TRANSITION';
  END IF;
  IF (to_jsonb(NEW) - v_allowed) IS DISTINCT FROM (to_jsonb(OLD) - v_allowed) THEN
    RAISE EXCEPTION 'FYM_MEDIA_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_media_guard BEFORE UPDATE ON media_item
  FOR EACH ROW EXECUTE FUNCTION fym_media_guard();

-- A row is the only record of the storage key: it may be deleted only once it is DELETING (the worker deletes it after the provider confirmed).
CREATE FUNCTION fym_media_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'DELETING' THEN RAISE EXCEPTION 'FYM_MEDIA_NOT_DELETING'; END IF;
  RETURN OLD;
END $$;

CREATE TRIGGER trg_media_delete_guard BEFORE DELETE ON media_item
  FOR EACH ROW EXECUTE FUNCTION fym_media_delete_guard();
