-- ============================================================================
-- AUD-07: audit actions for administrator changes to venues they do not own.
--
-- Additive only: fourteen values are appended to the existing enum. The table, its constraints, its
-- indexes and its append-only triggers (UPDATE / DELETE / TRUNCATE refused) are not touched, and no
-- existing row is changed.
--
-- Rollback: PostgreSQL cannot drop a value from an enum. Records that use these values would have to be
-- kept, and the audit table refuses UPDATE and DELETE, so there is no data rollback: leave the values
-- in place (unused values are harmless) and roll the API back instead.
-- ============================================================================

ALTER TYPE "admin_audit_action" ADD VALUE IF NOT EXISTS 'VENUE_UPDATED_BY_ADMIN';
ALTER TYPE "admin_audit_action" ADD VALUE IF NOT EXISTS 'VENUE_STAFF_ADDED_BY_ADMIN';
ALTER TYPE "admin_audit_action" ADD VALUE IF NOT EXISTS 'VENUE_STAFF_UPDATED_BY_ADMIN';
ALTER TYPE "admin_audit_action" ADD VALUE IF NOT EXISTS 'VENUE_STAFF_REMOVED_BY_ADMIN';
ALTER TYPE "admin_audit_action" ADD VALUE IF NOT EXISTS 'VENUE_IMAGE_ADDED_BY_ADMIN';
ALTER TYPE "admin_audit_action" ADD VALUE IF NOT EXISTS 'VENUE_IMAGE_REMOVED_BY_ADMIN';
ALTER TYPE "admin_audit_action" ADD VALUE IF NOT EXISTS 'VENUE_FIELD_CREATED_BY_ADMIN';
ALTER TYPE "admin_audit_action" ADD VALUE IF NOT EXISTS 'VENUE_FIELD_UPDATED_BY_ADMIN';
ALTER TYPE "admin_audit_action" ADD VALUE IF NOT EXISTS 'VENUE_HOURS_REPLACED_BY_ADMIN';
ALTER TYPE "admin_audit_action" ADD VALUE IF NOT EXISTS 'VENUE_BLOCK_CREATED_BY_ADMIN';
ALTER TYPE "admin_audit_action" ADD VALUE IF NOT EXISTS 'VENUE_BLOCK_DELETED_BY_ADMIN';
ALTER TYPE "admin_audit_action" ADD VALUE IF NOT EXISTS 'BOOKING_CONFIRMED_BY_ADMIN';
ALTER TYPE "admin_audit_action" ADD VALUE IF NOT EXISTS 'BOOKING_REJECTED_BY_ADMIN';
ALTER TYPE "admin_audit_action" ADD VALUE IF NOT EXISTS 'BOOKING_CANCELLED_BY_ADMIN';
