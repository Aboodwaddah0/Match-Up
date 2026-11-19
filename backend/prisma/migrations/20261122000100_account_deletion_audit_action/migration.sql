-- ============================================================================
-- PRIV-01 / D18: audit action for a self-service account deletion.
--
-- Additive only: one value is appended to the existing enum. The table, its constraints, its indexes and its
-- append-only triggers (UPDATE / DELETE / TRUNCATE refused) are not touched, and no existing row is changed.
--
-- Rollback: PostgreSQL cannot drop a value from an enum. Records that use it would have to be kept, and the audit
-- table refuses UPDATE and DELETE, so leave the value in place (an unused value is harmless) and roll the API back.
-- ============================================================================

ALTER TYPE "admin_audit_action" ADD VALUE IF NOT EXISTS 'ACCOUNT_DELETED';
