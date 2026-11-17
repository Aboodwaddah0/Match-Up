import type { AdminAuditAction, AdminAuditTarget, Prisma } from '@prisma/client';

export interface AdminAuditEntry {
  actorId: string;
  action: AdminAuditAction;
  targetType: AdminAuditTarget;
  targetId: string;
  /** Free text typed by the admin (max 500). Optional. */
  reason?: string | null;
  /** Small state facts only, e.g. { fromStatus, toStatus }. NEVER e-mails, names, tokens or secrets. */
  metadata?: Prisma.InputJsonObject;
  /** The request id of the HTTP call (`X-Request-Id`), so a record can be matched to the log line. */
  requestId?: string;
}

/**
 * Appends one audit record (AUD-01). It takes the caller's transaction on purpose: the record commits or rolls back together
 * with the administrative action, so there is never an action without a record or a record of an action that did not happen.
 * Call it AFTER the action has been validated and applied, inside the same `prisma.$transaction`.
 * The table is append-only (a trigger refuses UPDATE and DELETE), so there is no function here to change or remove a record.
 */
export async function recordAdminAudit(tx: Prisma.TransactionClient, e: AdminAuditEntry): Promise<void> {
  await tx.adminAuditLog.create({
    data: {
      actorId: e.actorId,
      action: e.action,
      targetType: e.targetType,
      targetId: e.targetId,
      reason: e.reason?.trim() ? e.reason.trim() : null,
      metadata: e.metadata ?? {},
      requestId: e.requestId ?? null,
    },
  });
}
