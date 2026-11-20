-- ============================================================================
-- Media (photos and videos of players and teams), part 1 of 2: enum values only.
--
-- WHY a separate migration: PostgreSQL does not let a transaction USE an enum value it has just added (the value is invisible until the
-- transaction commits), and Prisma runs a migration in one transaction. The second migration (media_items) may therefore refer to these
-- values, because they are committed by then. Same split as the earlier audit-action migrations.
--
-- Additive only: three values are appended. No table, constraint or row is touched.
-- Rollback: PostgreSQL cannot drop an enum value. report / audit rows may use them (the audit table refuses UPDATE and DELETE), so leave the
-- values in place (unused values are harmless) and roll the API back.
-- ============================================================================

ALTER TYPE "report_target" ADD VALUE IF NOT EXISTS 'MEDIA';
ALTER TYPE "admin_audit_action" ADD VALUE IF NOT EXISTS 'MEDIA_REMOVED_BY_ADMIN';
ALTER TYPE "admin_audit_target" ADD VALUE IF NOT EXISTS 'MEDIA';
