import { AppError } from './errors';

/**
 * The database is the last line of defence (triggers / constraints raise FYM_* errors and standard
 * SQLSTATEs). This turns them into proper API errors, so a race that slips past a service-level
 * check still returns a clean 409 instead of a 500.
 */
const FYM: Record<string, [status: number, code: string, message: string]> = {
  FYM_MATCH_FULL: [409, 'MATCH_FULL', 'The match is full'],
  FYM_MATCH_NOT_OPEN: [409, 'MATCH_NOT_OPEN', 'This match is not accepting join requests'],
  FYM_MATCH_NOT_ACCEPTING: [409, 'MATCH_NOT_ACCEPTING', 'This match is not accepting players'],
  FYM_MATCH_STARTED: [409, 'MATCH_STARTED', 'The match has already started'],
  FYM_MATCH_IN_PAST: [400, 'DATE_IN_PAST', 'The match must start in the future'],
  FYM_ORGANIZER_CANNOT_REQUEST: [400, 'ORGANIZER_CANNOT_REQUEST', 'You organize this match'],
  FYM_ALREADY_PARTICIPANT: [409, 'ALREADY_PARTICIPANT', 'You are already confirmed in this match'],
  FYM_PRIVATE_NOT_INVITED: [403, 'NOT_INVITED', 'This match is invite-only'],
  FYM_BLOCKED: [403, 'NOT_ALLOWED', 'You cannot interact with this match'],
  FYM_MATCH_TIME_LOCKED: [409, 'MATCH_TIME_LOCKED', 'Time cannot change once players are confirmed or the match has started'],
  FYM_CAPACITY_LOCKED: [409, 'CAPACITY_LOCKED', 'Capacity cannot change after the match has started'],
  FYM_CAPACITY_BELOW_CONFIRMED: [409, 'CAPACITY_BELOW_CONFIRMED', 'Capacity cannot be lower than the number of confirmed players'],
  FYM_MATCH_BAD_TRANSITION: [409, 'INVALID_STATE', 'This action is not allowed in the current match status'],
  FYM_TOO_EARLY: [409, 'TOO_EARLY', 'This is not possible yet'],
  FYM_RECOVERY_WINDOW_EXPIRED: [403, 'RECOVERY_WINDOW_EXPIRED', 'Only an administrator can resolve this match now'],
  FYM_ATTENDANCE_TOO_EARLY: [409, 'ATTENDANCE_TOO_EARLY', 'Attendance can be recorded once the match has started'],
  FYM_ATTENDANCE_NOT_CONFIRMED_PARTICIPANT: [409, 'NOT_A_PARTICIPANT', 'Only confirmed players have attendance'],
  FYM_REQUEST_FINAL: [409, 'REQUEST_ALREADY_DECIDED', 'This request was already decided'],
  FYM_REQUESTS_NOT_ALLOWED: [400, 'REQUESTS_NOT_ALLOWED', 'This match does not take join requests'],
  FYM_PARTICIPANT_BAD_TRANSITION: [409, 'INVALID_STATE', 'This action is not allowed for this participant'],
  FYM_SLOT_BLOCKED: [409, 'SLOT_UNAVAILABLE', 'This time slot is not available'],
  FYM_BLOCK_CONFLICTS_BOOKING: [409, 'BLOCK_CONFLICTS_BOOKING', 'There are bookings in this period; reject or cancel them first'],
  FYM_TOO_MANY_PENDING: [429, 'TOO_MANY_PENDING_BOOKINGS', 'You have too many booking requests waiting for an answer'],
  FYM_HOLD_EXPIRED: [409, 'HOLD_EXPIRED', 'This booking request expired before it was answered'],
  FYM_HOLD_NOT_EXPIRED: [409, 'HOLD_NOT_EXPIRED', 'This booking request is still waiting for an answer'],
  FYM_FIELD_INACTIVE: [409, 'FIELD_INACTIVE', 'This field is not taking bookings'],
  FYM_BOOKING_IN_PAST: [400, 'DATE_IN_PAST', 'The booking must start in the future'],
  FYM_BOOKING_BAD_TRANSITION: [409, 'INVALID_STATE', 'This action is not allowed in the current booking status'],
  FYM_BOOKING_IMMUTABLE: [409, 'BOOKING_IMMUTABLE', 'A booking cannot be moved; cancel it and request a new one'],
  FYM_BOOKING_NOT_ENDED: [409, 'BOOKING_NOT_ENDED', 'The booking has not ended yet'],
  FYM_BOOKING_NOT_CONFIRMED: [409, 'BOOKING_NOT_CONFIRMED', 'Only a confirmed booking can be linked to a match'],
  FYM_BOOKING_NOT_OWNED: [403, 'BOOKING_NOT_OWNED', 'You can only link your own booking'],
  FYM_MATCH_OUTSIDE_BOOKING: [400, 'MATCH_OUTSIDE_BOOKING', 'The match must fit inside the booked time'],
  FYM_MATCH_LINK_LOCKED: [409, 'MATCH_LINK_LOCKED', 'The booking can no longer be linked to this match'],
  FYM_NOT_TEAM_MEMBER: [409, 'NOT_A_TEAM_MEMBER', 'This player is not a member of the team'],
  FYM_ROSTER_FULL: [409, 'ROSTER_FULL', 'The roster already has the full number of players for this format'],
  FYM_REVIEWER_NOT_ATTENDEE: [403, 'NOT_AN_ATTENDEE', 'Only players who attended the match can review'],
  FYM_REVIEWED_NOT_ATTENDEE: [400, 'REVIEWED_NOT_ATTENDEE', 'That player did not attend this match'],
  FYM_REVIEW_WINDOW_CLOSED: [409, 'REVIEW_WINDOW_CLOSED', 'The review window has closed'],
  FYM_MATCH_NOT_COMPLETED: [409, 'MATCH_NOT_COMPLETED', 'Reviews open after the match is completed'],
};

function textOf(err: unknown): string {
  if (!(err instanceof Error)) return '';
  const meta = (err as { meta?: unknown }).meta;
  return `${err.message} ${meta ? JSON.stringify(meta) : ''}`;
}

export function toAppError(err: unknown): AppError | null {
  // Prisma: update/delete of a row that does not exist
  if (err instanceof Error && (err as { code?: string }).code === 'P2025') {
    return new AppError(404, 'NOT_FOUND', 'Resource not found');
  }
  const text = textOf(err);

  // Unique violation (Prisma P2002): the partial unique index is invisible to Prisma, so match by table.
  if (err instanceof Error && (err as { code?: string }).code === 'P2002') {
    if (/booking_?id/i.test(text)) return new AppError(409, 'BOOKING_ALREADY_LINKED', 'This booking is already linked to another match');
    if (/reviewer_id/i.test(text)) return new AppError(409, 'ALREADY_REVIEWED', 'You already reviewed this player for this match');
    if (/team_invitation|invitee_id/i.test(text)) return new AppError(409, 'DUPLICATE_INVITATION', 'This player already has a pending invitation');
    if (/team_challenge|challenger_team_id/i.test(text)) return new AppError(409, 'DUPLICATE_CHALLENGE', 'You already have a pending challenge against this team');
    if (/match_?request/i.test(text)) return new AppError(409, 'DUPLICATE_REQUEST', 'You already have a pending request for this match');
    return new AppError(409, 'CONFLICT', 'This resource already exists');
  }

  const fym = text.match(/FYM_[A-Z_]+/)?.[0];
  if (fym && FYM[fym]) {
    const [status, code, message] = FYM[fym];
    return new AppError(status, code, message);
  }
  // Overlap: never reveal WHICH other match/booking conflicts.
  if (text.includes('participant_no_overlap')) {
    return new AppError(409, 'SCHEDULE_CONFLICT', 'This player has another confirmed match at the same time');
  }
  if (text.includes('booking_no_overlap')) {
    return new AppError(409, 'SLOT_UNAVAILABLE', 'This time slot is not available');
  }
  if (text.includes('venue_block_no_overlap')) {
    return new AppError(409, 'BLOCK_OVERLAP', 'This period overlaps an existing block');
  }
  if (text.includes('uq_match_one_active_per_booking')) {
    return new AppError(409, 'BOOKING_ALREADY_LINKED', 'This booking is already linked to another match');
  }
  if (text.includes('uq_team_one_captain')) return new AppError(409, 'CAPTAIN_CONFLICT', 'A team has exactly one captain');
  if (text.includes('uq_team_invitation_one_pending')) return new AppError(409, 'DUPLICATE_INVITATION', 'This player already has a pending invitation');
  if (text.includes('uq_team_challenge_one_pending')) return new AppError(409, 'DUPLICATE_CHALLENGE', 'You already have a pending challenge against this team');
  if (text.includes('uq_match_request_one_pending')) {
    return new AppError(409, 'DUPLICATE_REQUEST', 'You already have a pending request for this match');
  }
  if (text.includes('chk_match_type_shape')) {
    return new AppError(400, 'INVALID_CAPACITY', 'Capacity must be between 1 and the total players of the format');
  }
  return null;
}
