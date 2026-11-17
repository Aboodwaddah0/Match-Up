-- ============================================================================
-- AUD-01: append-only audit log of administrative actions.
--
-- Written by the API in the SAME transaction as the action it records, so an action
-- and its record commit or roll back together.
--
-- Design:
--  * target_id has no foreign key: the record must survive any later change to the
--    target (anonymization, deactivation) and must never block it. The actor does
--    have one (RESTRICT): users are anonymized in place and never hard-deleted (D18),
--    so the actor's history stays attached to the same row.
--  * Nothing personal is stored by the system: `metadata` holds small state facts only
--    (e.g. {"fromStatus": "ACTIVE", "toStatus": "SUSPENDED"}), never tokens or secrets.
--    `reason` is free text TYPED BY THE ADMIN (max 500 characters, enforced here and by
--    the API). Admins must not put personal data, passwords, tokens or secrets in it:
--    the log is append-only, so anything written there can never be removed.
--  * UPDATE, DELETE and TRUNCATE are refused by triggers, for every database role. TRUNCATE
--    of "user" is refused as well (it cannot run without also truncating this table).
--    KNOWN LIMITATION: a database superuser (the application currently connects as one,
--    audit finding OPS-08) can disable or drop these triggers, or drop the table. Closing that
--    needs separate runtime and migration roles (Phase 3); until then the guarantee holds against
--    application code and ordinary roles, not against someone with full database privileges.
--
-- Rollback: DROP TABLE admin_audit_log (this also drops its triggers); DROP TYPE admin_audit_target;
-- DROP TYPE admin_audit_action; DROP FUNCTION fym_audit_immutable();  -- the records are lost.
-- Test setup that must empty the database disables trg_admin_audit_no_truncate for its own transaction.
-- ============================================================================

CREATE TYPE "admin_audit_action" AS ENUM ('USER_SUSPENDED', 'USER_REACTIVATED', 'VENUE_SUSPENDED', 'VENUE_REACTIVATED', 'REPORT_STATUS_CHANGED', 'MATCH_CANCELLED_BY_ADMIN', 'MATCH_COMPLETED_BY_ADMIN', 'MATCH_RECOVERED_BY_ADMIN', 'MATCH_EDITED_BY_ADMIN');
CREATE TYPE "admin_audit_target" AS ENUM ('USER', 'VENUE', 'REPORT', 'MATCH');

CREATE TABLE "admin_audit_log" (
    "id"          UUID                 NOT NULL DEFAULT gen_random_uuid(),
    "actor_id"    UUID                 NOT NULL,
    "action"      "admin_audit_action" NOT NULL,
    "target_type" "admin_audit_target" NOT NULL,
    "target_id"   UUID                 NOT NULL,
    "reason"      TEXT,
    "metadata"    JSONB                NOT NULL DEFAULT '{}',
    "request_id"  TEXT,
    "created_at"  TIMESTAMPTZ(6)       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_log_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "admin_audit_log_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT chk_admin_audit_reason_length CHECK (reason IS NULL OR char_length(reason) <= 500),
    CONSTRAINT chk_admin_audit_metadata_object CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX "admin_audit_log_target_type_target_id_created_at_idx" ON "admin_audit_log"("target_type", "target_id", "created_at");
CREATE INDEX "admin_audit_log_actor_id_created_at_idx" ON "admin_audit_log"("actor_id", "created_at");
CREATE INDEX "admin_audit_log_created_at_idx" ON "admin_audit_log"("created_at");

CREATE FUNCTION fym_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'FYM_AUDIT_IMMUTABLE' USING ERRCODE = 'P0001', HINT = 'admin_audit_log is append-only';
END $$;

CREATE TRIGGER trg_admin_audit_immutable BEFORE UPDATE OR DELETE ON "admin_audit_log"
  FOR EACH ROW EXECUTE FUNCTION fym_audit_immutable();

CREATE TRIGGER trg_admin_audit_no_truncate BEFORE TRUNCATE ON "admin_audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION fym_audit_immutable();
