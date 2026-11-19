import type { AccountStatus } from '@prisma/client';

/**
 * The small user object shown next to content (author, requester, organizer, roster, ...). PRIV-01 / D18: a deleted account is anonymized in
 * place (name "Deleted user", no avatar), and every such object carries `deleted: true` so a client can show the label in the user's own
 * language. `status` is selected only to compute that flag and never leaves the API.
 */
export const userSummarySelect = { id: true, fullName: true, avatarUrl: true, status: true } as const;

export interface UserSummaryRow {
  id: string;
  fullName: string;
  avatarUrl: string | null;
  status: AccountStatus;
}

export function toUserSummary(u: UserSummaryRow) {
  return { id: u.id, fullName: u.fullName, avatarUrl: u.avatarUrl, deleted: u.status === 'DELETED' };
}
