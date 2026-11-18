-- ============================================================================
-- AUD-02: audit actions for admin overrides on match participation.
--
-- Additive only: six values are appended to the existing enum. The table, its constraints, its
-- indexes and its append-only triggers (UPDATE / DELETE / TRUNCATE refused) are not touched, and no
-- existing row is changed.
--
-- Rollback: PostgreSQL cannot drop a value from an enum. Records that use these values would have to be
-- kept, and the audit table refuses UPDATE and DELETE, so there is no data rollback: leave the values
-- in place (unused values are harmless) and roll the API back instead.
-- ============================================================================

ALTER TYPE "admin_audit_action" ADD VALUE IF NOT EXISTS 'PARTICIPANT_ATTENDED_BY_ADMIN';
ALTER TYPE "admin_audit_action" ADD VALUE IF NOT EXISTS 'PARTICIPANT_NO_SHOW_BY_ADMIN';
ALTER TYPE "admin_audit_action" ADD VALUE IF NOT EXISTS 'JOIN_REQUEST_ACCEPTED_BY_ADMIN';
ALTER TYPE "admin_audit_action" ADD VALUE IF NOT EXISTS 'JOIN_REQUEST_REJECTED_BY_ADMIN';
ALTER TYPE "admin_audit_action" ADD VALUE IF NOT EXISTS 'PARTICIPANT_REMOVED_BY_ADMIN';
ALTER TYPE "admin_audit_action" ADD VALUE IF NOT EXISTS 'MATCH_INVITATION_SENT_BY_ADMIN';
