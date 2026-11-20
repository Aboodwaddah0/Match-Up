-- ============================================================================
-- Media: daily RECONCILIATION of the media folder at the storage provider (follow-up of 20261125000100_media_stray_sweep).
--
-- WHY. The per-item stray sweeps end 24 hours after a slot was created, and nobody can prove that the provider never finishes processing an upload
-- later than that. This table holds the progress of a job that walks the provider's own listing of "<folder>/media/" (image, video and raw, each
-- with its own pagination state) and removes whatever is not the verified file of a READY item, so a late stray is found whenever it appears.
--
-- ONE ROW PER RESOURCE TYPE (created by the job itself; the job needs no seed):
--   cursor            the cursor that fetches the NEXT page. It only ever moves forward after a page was processed completely, so a failed page is
--                     fetched again (never skipped). Null = the cycle has not fetched a page yet.
--   cycle_started_at  null = idle. Otherwise when the running cycle began: the age of the oldest unprocessed work. A cycle completes only when the
--                     last page (the listing returned no next cursor) was processed without a failure; then the row goes idle and the next cycle
--                     starts one interval after this one started. Assets that appear behind the cursor are therefore found by the next cycle.
--   cycle_pages / cycle_scanned / cycle_deleted   progress of the running cycle, for monitoring.
--   next_run_at       when the job may touch this type again (a pause after the page budget of a run is used up, a backoff after a failure, or the
--                     interval between two cycles).
--   claim_id / lease_until   one runner at a time per type, like the other workers; every write of a run is conditional on its claim id.
--   attempts / last_error    consecutive failed runs of the running cycle and why (visible in GET /admin/stats).
--
-- Additive: one table, no changes to existing tables. Rollback: DROP TABLE media_reconcile.
-- ============================================================================

-- CreateTable
CREATE TABLE "media_reconcile" (
    "resource_type" TEXT NOT NULL,
    "cursor" TEXT,
    "cycle_started_at" TIMESTAMPTZ(6),
    "cycle_pages" INTEGER NOT NULL DEFAULT 0,
    "cycle_scanned" INTEGER NOT NULL DEFAULT 0,
    "cycle_deleted" INTEGER NOT NULL DEFAULT 0,
    "last_cycle_completed_at" TIMESTAMPTZ(6),
    "next_run_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claim_id" UUID,
    "lease_until" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "media_reconcile_pkey" PRIMARY KEY ("resource_type")
);

ALTER TABLE "media_reconcile"
  ADD CONSTRAINT chk_media_reconcile_type CHECK (resource_type IN ('image', 'video', 'raw')),
  -- an idle row carries no cycle bookkeeping; a cursor exists only inside a running cycle
  ADD CONSTRAINT chk_media_reconcile_cycle CHECK (
    cycle_pages >= 0 AND cycle_scanned >= 0 AND cycle_deleted >= 0 AND attempts >= 0
    AND (cycle_started_at IS NOT NULL OR (cursor IS NULL AND cycle_pages = 0 AND cycle_scanned = 0 AND cycle_deleted = 0))),
  ADD CONSTRAINT chk_media_reconcile_lease CHECK ((claim_id IS NULL) = (lease_until IS NULL));
