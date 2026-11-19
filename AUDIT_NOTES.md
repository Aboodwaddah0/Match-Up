# Production-readiness audit: notes and status

Last updated 2026-11-17 against commit `bea3c6c`. Evidence (experiments, plans, measurements) comes from throwaway scripts run against disposable databases; they are not in the repository. The "Missing tests" list says which of them should become permanent tests.

**Verdict:** the core business rules are enforced in PostgreSQL and hold under stress; the backend is **not yet production-ready**. No CRITICAL findings. Safe to connect a mobile app in development / staging; finish the P1 list before real users.

**State of this document:** decisions D18, D19 and D20 are recorded (final wording in PROJECT_REQUIREMENTS.md §15). **D18 (account deletion, PRIV-01) and D19 (team challenge control, BIZ-02) are implemented** (BIZ-02 committed, PRIV-01 awaiting review / commit; see the Phase 2 status table). **D20 is only PARTIALLY implemented**: Expo push (NOTIF-01) and configurable deep-link targets are done; **Sentry is not implemented** and C1-C3 below are still open. The sections that describe the gaps are kept as history of the audit.

## Decisions (final wording is in PROJECT_REQUIREMENTS.md §15)

* **D18, account deletion: block until clean, then anonymize.**
  * Refuse with **409** and a list of reasons while the user (1) organizes upcoming matches, (2) captains a team with other members, (3) owns venues (transfer ownership; if impossible, deactivate the venue and resolve future bookings first), or (4) is an **ordinary member of a team** (they must leave themselves; never removed automatically, not even with a notification).
  * Then erase or anonymize personal data in place; history shows "Deleted user".
  * **Chat messages and reviews are kept**; only the author's identity is anonymized.
  * Never auto-cancel other users' matches. **Data export is out of the MVP.**
* **D19, team challenge control.**
  * The captain of the challenging team **at the moment the challenge is created** is the organizer; a later captaincy change does not change it; the organizer changes only through an explicit transfer action, if supported.
  * Each team's captain **and vice captains** manage only their own roster; nobody manages the opposing roster.
  * The organizer alone cancels, reschedules (D12 rules) and confirms completion. D1–D17 are unchanged.
* **D20, technical configuration.** E-mail links are Expo-compatible deep links, targets configurable by environment variables; push = **Expo Push Notifications**; error tracking = **Sentry**.

## What the decisions resolved

| Earlier open point | Resolution |
|---|---|
| D18 (a) team membership of a non-captain | Must leave themselves first: it is a **fourth blocker** |
| D18 (c) messages and reviews | Kept; author anonymized |
| D18 (d) data export | Out of MVP scope (removed from PRIV-01) |
| D19 (a) vice captains | Keep roster rights: **today's behaviour is correct** |
| D19 (b) captain at creation or acceptance | **At creation** (today it is at acceptance: a change is needed) |
| D19 (c) organizer after a captaincy change | Unchanged: **today's behaviour is correct** |
| AUTH-03 e-mail link target | Expo deep links by env var; only the app's URL scheme value is still needed |
| Push provider / error tracking | Expo Push / Sentry |

## Remaining ambiguities (no rule has been assumed for any of them)

*Status: A1-A7 (D18) and B1-B2 (D19) were decided by the product owner and are implemented (PRIV-01, BIZ-02); they are kept below as history. Organizer transfer and venue ownership transfer are NOT supported. **C1-C3 (D20) are still OPEN.***

**D18**
* A1. What counts as "upcoming" for the organizer blocker (proposal, not adopted: OPEN, FULL, SCHEDULED, IN_PROGRESS, and CLOSED_UNCONFIRMED while the organizer can still recover it).
* A2. The user's own upcoming participations, pending join requests and own future bookings: blocker, clean-up, or left alone?
* A3. A team whose only member is the deleting captain (blocker 2 applies only when others exist).
* A4. Staff roles at other people's venues, and pending invitations.
* A5. Venue ownership transfer: who may receive it, must they accept, and who manages or reactivates a deactivated venue owned by a deleted user?
* A6. Other free text the user wrote besides messages and reviews (match notes and descriptions, booking notes, reports): kept or erased?
* A7. Re-registration with the same e-mail after deletion (technical default: allowed).

**D19**
* B1. If the captain who created the challenge is no longer on the challenging team (or is suspended or deleted) at acceptance, who is the organizer?
* B2. Is an explicit organizer transfer built at all ("if supported")? If not, D18 blocker 1 can only be resolved by cancelling matches. Recipient and acceptance rules if it is built.

**D20 (technical)**
* C1. The app's URL scheme value, and whether an https fallback page is wanted (many e-mail clients do not make custom-scheme links clickable; Expo Go uses a different URL form than release builds).
* C2. Sentry project / environment names and sampling rate; the rule that no e-mail, token, password or coordinates reach error reports.
* C3. Expo project id and access-token handling; which notification types trigger a push; push text must be produced in the user's language (notifications are stored as data, not text).

## Gap analysis against the current code

### D18, account deletion (no deletion endpoint exists)

*Historical gap analysis: the gaps below were closed by PRIV-01 (see the Phase 2 status table).*
| Requirement | Today | Work needed |
|---|---|---|
| 409 with reasons | None | New endpoint and a blocker query (code, count, resource ids per reason) |
| Blocker 1: organizer transfer | **No code path changes a match organizer** | Only needed if B2 says transfer is built; otherwise cancel is the only way out |
| Blocker 2: captaincy transfer | Exists (`POST /teams/:id/transfer-captaincy`) | Define "another member" (any member?) |
| Blocker 3: venue ownership transfer | **None** (owner is set once at creation); deactivation and per-booking reject / cancel exist | New capability, or the deactivate path; see A5 |
| Blocker 4: leaving teams | Members can leave (`POST /teams/:id/leave`); captains cannot | Check membership in the blocker query |
| Anonymize, keep history | Not built. Hard delete impossible: **21 foreign keys restrict**, 10 set null, 4 cascade (device_token, player_profile, refresh_token, user_token) | Anonymize in place: status DELETED, unique unusable e-mail placeholder, name "Deleted user", avatar removed, sessions revoked; erase profile, device tokens, e-mail tokens, notifications, blocks. **Keep messages and reviews** |
| "Deleted user" display | Name comes from the user row | Replace the name and expose a `deleted` flag for localization |
| Deleted users cannot act | `authenticate` already refuses any non-ACTIVE account | None |

### D19, team challenges
| Rule | Today | Gap |
|---|---|---|
| Organizer = captain of the challenging team **at creation** | Captain **at acceptance** (`challenges.service.ts` `acceptChallenge`) | Remember the organizer when the challenge is created (**schema change**); see B1 |
| Later captaincy change leaves the organizer alone | Already true | None |
| Captain and vice captains manage their own roster | Already true (`requireStaff`) | None |
| Nobody edits the opposing roster | **Verified** in the authorization sweep | None |
| Organizer cancels / completes | Yes; the opposing captain cannot | None |
| Organizer reschedules (D12) | **Not supported** (`updateMatch` only accepts open matches); the database trigger would allow it | Implement for team matches; tell both teams |
| Explicit organizer transfer | None | Only if B2 says yes |

## Findings

Severity: HIGH / MEDIUM / LOW / INFO. **Status**: confirmed = reproduced by an experiment; code = confirmed by reading the code.

### P0, done in `bea3c6c`
SEC-01 owner could lift an admin venue suspension; AUTH-01 shared auth rate limit; AUTH-03 e-mail links now configurable (see D20 and C1); BIZ-01 reliability ignored CANCELLED / CLOSED_UNCONFIRMED (D16); SEC-02 nodemailer 7 to 10.6.0 plus `npm run audit:prod`. The Prisma advisory `GHSA-ggr8-5vv4-36mx` (deepmerge-ts, CLI only) is an approved exception until **2027-02-17** (`backend/audit-allowlist.json`); the fix is Prisma 7.

### P1, before production (reassessed after D18-D20)
| ID | Sev | Status | Finding | Fix | Change after the decisions |
|---|---|---|---|---|---|
| CONC-01 | MEDIUM | confirmed | Cancel vs accept is a lock-order deadlock (`matches.service.ts:317`); **15 of 40** races gave a spurious 409 and the match stayed OPEN | Lock the match row first in both paths; retry cancel / complete / sweepers; race test | none |
| ERR-01 | MEDIUM | confirmed | Body over 1 MB, bad `Content-Encoding`, corrupt gzip return **500** | Map body-parser errors in `error-handler.ts` | none |
| OBS-01 | MEDIUM | confirmed | No request id; `/health/db` logged every probe; no error tracking | Request id; ignore both health routes; **Sentry** | tool decided (D20); needs a dependency approval |
| OPS-07 | MEDIUM | confirmed | `docker stop` with one live Socket.IO connection: 11 s, exit 1 | Close Socket.IO, await in-flight work, unhandled-error handlers | none |
| OPS-08 | MEDIUM | confirmed | One **superuser** role for app and migrations; `max_connections` 100; Prisma pool 25 per instance | Separate roles; explicit `connection_limit`; pooler | none (infrastructure) |
| OPS-01 | MEDIUM | code | Dev JWT secret passes `env.ts`; missing `SMTP_URL` only warns | Production guards | none |
| OPS-02 | MEDIUM | code | No backups, PITR or database timeouts. **Restore rehearsal passed** (12 of 12 object classes identical) | Backups, retention, PITR, restore drill, `statement_timeout` / `lock_timeout` | none (infrastructure) |
| MAIL-01 | MEDIUM | confirmed | Mail sent inline: dead SMTP held a request **30 s** | Outbox table and worker with retries; nodemailer timeouts | links are deep links (D20); needs a migration |
| AUTH-02 | MEDIUM | confirmed | `forgot-password` **981 ms** (existing) vs **16 ms** (unknown) | Enqueue the mail; constant-time path | follows MAIL-01 |
| NOTIF-01 | MEDIUM | code | Outbox rows never delivered; no retention | **Expo Push** delivery worker with retries, localized text, invalid-token cleanup, token-format validation | provider decided (D20); see C3 |
| SEC-03 | MEDIUM | code | Only auth, chat messages and reports are rate limited | Global limiter plus per-user limits on creation endpoints | none |
| OPS-03 | MEDIUM | code | Socket.IO rooms and rate-limit counters are per instance | Redis adapter and shared limiter store | none (infrastructure, dependency) |
| AUTHZ-01 | MEDIUM | confirmed | Staff with only `MANAGE_STAFF` granted themselves everything | Forbid self-edits; only the owner grants `MANAGE_STAFF` | none |
| AUTH-04 | MEDIUM | confirmed | A suspended or logged-out user's socket keeps receiving chat | Disconnect on suspension / logout-all; enforce token expiry | none |
| AUD-01 | MEDIUM | code | Admin actions leave no record | Audit-log table | needs a migration |
| PRIV-01 | MEDIUM | decided | Account deletion absent | Implement D18 (four blockers, anonymize, keep messages and reviews) | **narrower**: export removed; scope depends on A1-A5 and B2 |
| JOB-01 | MEDIUM | code | Sweepers run in sequence with no isolation | Per-job error handling, batch limits, failure metrics | none |
| BIZ-03 | MEDIUM | confirmed | Start is not lazy: with the sweeper behind, a started match can still be cancelled | Transition lazily when a match is touched | none |
| PERF-01 | MEDIUM | confirmed | Inbox for a heavy user: **1,423 SQL statements, 337 ms, 228 KB** | One aggregated query and pagination | none |
| BIZ-02 | **LOW** (was MEDIUM) | decided | First audit: organizer fixed, opposing team without control, no minimum roster | Now **decisions**, not defects. Remaining work: remember the organizer at creation (schema change), reschedule team matches | resolved by D19; see B1, B2 |

### P2
PERF-02 (list endpoints run 7-10 statements; ~58-75 req/s per process at ~3 cores on a shared dev machine; no overload protection); PERF-03 (50 km geo search 264 ms at 20,000 open matches); PERF-04 (case-insensitive text search is a sequential scan; trigram indexes); CONC-02 (team size cap 30 exceeded: **36** members after 8 simultaneous accepts); AUTHZ-02 (a suspended organizer's match stays public and joinable); PRIV-02 (team member lists and player stats visible to every signed-in user; blocks ignored); OPS-09 (Node keep-alive 5 s vs a load balancer; not verified); TIME-01 (about 14 comparisons use the app clock against database time); OPS-06 (no retention for tokens, notifications, messages, events); API-01 (`listPendingRequests` unbounded); API-02 (changing opening hours ignores existing bookings); SEC-04 (recipient e-mail and lat/lng in logs); SEC-05 (CORS open); DB-01 (opening hours, slot alignment, venue ACTIVE only checked in the service); AUTH-05 (access token valid up to 15 min after logout); AUTHZ-03 (`openMatchChat` writes before it authorizes).

### Closed, refuted or moved out of scope
DB-03 migration drift: `prisma migrate diff` is empty. Block-check scaling: refuted. IDOR: **198-call sweep found no unexpected access**. Concurrency invariants (capacity, overlaps, booking vs block, reschedule and capacity vs approval, captaincy): 0 violations. Sweepers: four at once did each item exactly once. Production image: builds, non-root, healthy, `migrate status` works. **Data export: out of MVP scope (D18).**

## Phase 1 status (committed `60e7cd4`; no schema, dependency or Prisma change)

| Item | Result |
|---|---|
| CONC-01 | `lib/locks.ts` `lockMatch`: every path locks the match row first (several matches in ascending id order); cancel / complete / update / leave / remove / attendance / roster changes use `withDeadlockRetry`. Race tests in `concurrency.test.ts` (0 deadlocks) |
| ERR-01 | Oversized (413), unsupported / bad encoding (415 / 400) and invalid JSON (400) are client errors; `tests/errors.test.ts` |
| BIZ-03 | `startMatchIfDue` runs when a due match is read, so a started match cannot be cancelled and attendance / completion work without the sweeper; `tests/lazy-start.test.ts` |
| JOB-01 | Sweepers: per-row transactions, bounded batches, per-job isolation, failing rows quarantined for 10 min, async stop; `tests/job-isolation.test.ts` |
| OPS-07 / OPS-01 | `lib/shutdown.ts` (`SHUTDOWN_TIMEOUT_MS`, default 8000), fatal handlers for unhandled errors, production start-up guards (`config/production-checks.ts`); `tests/shutdown.test.ts`, `tests/production-checks.test.ts` |
| AUTHZ-01 | `assertCanDelegate` in `venues.service.ts`: no self-edit, only held permissions can be granted (role defaults included), only the owner / admin grants `MANAGE_STAFF` or touches staff holding it; `tests/staff-rules.test.ts` |
| AUTH-04 | Socket handshake checks the token and ACTIVE status; the socket is dropped at token expiry and on suspension, logout-all, password change / reset (`lib/realtime.ts`); tests in `chat.test.ts` |
| SEC-03 | Global limiter (600 / min per user, 300 / min per anonymous IP, health exempt) and per-user creation limits (see README); `tests/rate-limit-api.test.ts` |
| PERF-01 | `GET /chats` is one aggregate query plus two batched reads (constant statements), keyset pagination (`limit`, `before`, `nextBefore`), `totalUnread` over all chats; tests in `chat.test.ts` |
| OBS-01 (part) | `X-Request-Id` in header, log and error bodies; health probes not logged. **Sentry stays in Phase 3** (new dependency) |

Still open from Phase 1's scope: none. Behaviour changes to note: `GET /chats` accepts `limit` / `before` and returns `nextBefore`; error bodies gain `requestId`; a conversation whose only messages come from blocked users no longer appears in the inbox.

## Phase 2 status

| Item | State |
|---|---|
| AUD-01 admin audit log | committed (`49bc01f`) |
| AUD-02 admin participation overrides | **completed**: the audit log now also records an admin's overrides on a match they do not organize: join request accepted / rejected, participant removed, attendance / no-show marked, private invitation sent (six new `admin_audit_action` values, migration `20261119000100_admin_audit_participation_actions`), and the released booking id is named in the existing `MATCH_CANCELLED_BY_ADMIN` record. Same transaction as the action, only when the state really changes (for attendance: the status or the confirmer), no record for the organizer or for an admin on their own match; an invitation that has not changed is not announced twice and a join request is announced only by the transaction that really decides it; the join-request status and the invitation are read under the match lock, so concurrent decisions leave one record; `tests/admin-audit-participation.test.ts`. Remaining audit gap: admin venue management (AUD-07 in the status review) |
| AUD-07 admin venue management | **completed**: the audit log now records an ADMIN's changes to a venue they do not own, written in the same transaction as the change (migration `20261120000100_admin_audit_venue_actions`, 14 new `admin_audit_action` values, all `*_BY_ADMIN`). Venue: `updateVenue` (names of the changed fields, plus the status transition when the status changes), `addStaff` (added / updated), `removeStaff`, `addImage`, `removeImage`. Fields: `createField`, `updateField`, `setOpeningHours`. Blocks: `createBlock` (one record naming every block of an all-fields block), `deleteBlock`. Bookings: confirm, reject and cancel by an admin (target = the venue, the booking id is in the metadata). Recorded ONLY when an ADMIN acts on a venue they do not own AND the operation really changes something; NOT recorded: venue owners, venue staff, an admin on their own venue (or cancelling their own booking), failed operations, no-ops (same value, same schedule, same staff grant sent again). `createExternalBooking` is not audited: it belongs to no registered venue and an admin creates it as their own booking. Venue suspend / reactivate were already audited and are not duplicated. The audit record commits or rolls back with the change; the before-state is read under a venue row lock (`lockVenue`) or, for bookings, a booking row lock, so simultaneous identical changes leave one record. Metadata holds only entity ids, changed field NAMES, roles, permissions and status transitions: never names, phone numbers, image URLs, block notes or other personal / contact data. `tests/admin-audit-venues.test.ts` |
| BOOK-01 simultaneous booking answers | **completed**: two simultaneous confirmations, rejections or cancellations of the same booking could both return 200 and both notify (found during AUD-07). Root cause: the status was checked on a read taken BEFORE the transaction, and the DB trigger `fym_booking_guard` only validates a status CHANGE, so CONFIRMED -> CONFIRMED and CANCELLED -> CANCELLED passed silently for the second caller. Fix (`bookings.service.ts`, no migration): `decide` and `cancelBooking` read the status under a booking row lock (`lockedStatus`, `FOR NO KEY UPDATE`) as the first statement of the transaction and decide on the status found after the lock (confirm / reject need PENDING, cancel needs PENDING or CONFIRMED, otherwise 409 `INVALID_STATE`); the transition, event row, notification and audit record only follow a successful check. Lock order is unchanged (the same booking row lock the UPDATE took anyway, now taken first). Verified: of simultaneous callers exactly one gets 200 and the others 409, with one transition, one notification and, for an admin on a venue they do not own, one audit record; sequential duplicates are 409 too; a failure while notifying still rolls everything back. `tests/bookings.test.ts`, `tests/admin-audit-venues.test.ts` |
| BOOK-02 releaseBookingForMatch | **completed** (no migration): cancelling a match with `releaseBooking: true` read the booking status without a lock, so a direct cancellation (requester, venue or admin) running at the same moment could be followed by a second CANCELLED -> CANCELLED update (the DB trigger only validates a status CHANGE): a duplicate event and notification, and an admin audit record crediting the match cancellation with a booking it did not release. Fix (`bookings.service.ts`): `releaseBookingForMatch` reads the facts that never change first (source, owner), then the STATUS under the booking row lock (`lockedStatus`, as in BOOK-01), and leaves a booking that is no longer PENDING / CONFIRMED alone (returns false: nothing released, no event, notification or audit mention). **Lock order analysed:** match cancel = match row, participant rows, then booking row (this fix keeps that order); requester / venue / admin cancel, confirm and reject = booking row first, then only inserts (event, notifications) and plain READS of matches (`notifyLinkedMatches`), never a match lock; the sweepers (expire, complete) use `FOR UPDATE SKIP LOCKED` and never wait; the DB booking check for a match link is a plain read and a match's foreign key takes only a key-share lock. Nothing that holds a booking row ever waits for a match row, so there is no cycle and no other workflow needed a new lock order. Verified with real concurrent requests (match cancel vs requester / venue / admin booking cancel, repeated) and a deterministic ordering (a booking cancellation held open in a second transaction; a slowed booking update): exactly one transition, one event, one notification and, for an admin, exactly one audit mention; sequential repeats are 409 / no-ops. `tests/booking-release-race.test.ts` |
| MAIL-01 / AUTH-02 e-mail outbox | committed (`7c2c63e`): `mail_outbox` table and migration `20261118000100_mail_outbox`; token and queued message created in the same transaction as register / resend / forgot-password; worker with `SKIP LOCKED` claiming, leases, retries with backoff, terminal failures and retention; token stored encrypted under the dedicated `MAIL_OUTBOX_ENCRYPTION_KEY` (required in production, never derived from the JWT secret) and wiped after use; nodemailer time limits; forgot-password answers and times the same for every account. Duplicate delivery remains possible (SMTP is at-least-once). D20 C1 (deep-link scheme, https fallback) is untouched |
| NOTIF-01 Expo push delivery | committed (`65f300b`): `push_delivery`, `push_provider_state`, `push_rate_bucket`, `notification.push_fanout_at` (migration `20261118000200_push_delivery`); idempotent fan-out, leased sending, receipts (a ticket is not a delivery, `UNCONFIRMED` when no receipt), separate SEND / RECEIPT authentication channels with a single-instance probe, a PostgreSQL token bucket shared by all instances, device handling, 24 h staleness, retention of finished deliveries only. In-app notification retention (OPS-06) is NOT part of it |
| BIZ-02 team challenge organizer and control (D19) | **completed** (migration `20261121000100_team_challenge_organizer`, nullable `team_challenge.organizer_id`): only the CAPTAIN of the challenging team can create a challenge (vice captain, plain member, outsider: 403) and that captain is recorded as the organizer; acceptance makes the RECORDED creator the match organizer, so a later captaincy change does not matter. B1: if the creator is no longer an ACTIVE member of the challenging team (left, removed, suspended or deleted) acceptance is refused with 409 `CHALLENGE_ORGANIZER_UNAVAILABLE`, the challenge stays PENDING, no match is created and nobody is assigned instead. A creator who is still an active member but no longer captain stays the organizer. Legacy challenges (NULL) keep the old rule (captain at acceptance). B2: **no organizer transfer exists and none is built**. **Race (serialized):** acceptance reads the creator's membership row and account row with `FOR SHARE` in ONE statement as the first thing in its transaction, so a leave / removal / suspension still in flight makes acceptance wait and then be refused (or proceed if it rolled back), and one that starts later waits for acceptance, leaving the creator as organizer. Lock order analysed: leave / removal lock match rows then delete the member row, suspension locks the user row, a captaincy transfer locks member rows, acceptance only creates a NEW match, so there is no cycle (real-DB tests incl. a mixed storm: no 500, no deadlock). **Rescheduling (D12 + D19):** the recorded organizer (or an admin, audited) may reschedule a SCHEDULED team match only while neither roster has a confirmed player (the DB trigger `fym_match_guard` enforces it, so it holds under races); rosters are never touched; captain and vice captain of BOTH teams are notified (`MATCH_TIME_CHANGED`); only time, title, description and notes are editable on a team match (400 `NOT_EDITABLE_FOR_TEAM_MATCH` otherwise); a linked booking is untouched and the match may only move inside it. Unchanged and verified: the organizer alone cancels, edits and completes; each team's captain AND vice captains manage only their own roster. **Consequence for PRIV-01:** account deletion must resolve every upcoming match where the user is the organizer (the only way out is cancelling it, since there is no transfer) BEFORE anonymization / deletion. Open: editing location, price and booking link of a team match is undefined by any decision and is refused. `tests/team-challenge-organizer.test.ts`, `tests/team-challenge-reschedule.test.ts`, `tests/team-challenge-race.test.ts` |
| D19 roster removal (found by the documentation review, fixed) | The generic `DELETE /matches/:id/participants/:userId` (`removeParticipant`, `participation.service.ts`) checked only organizer-or-admin, so the organizer of a TEAM_CHALLENGE (the challenging team's captain at creation, possibly no longer team staff) could remove players of EITHER side, against D19 point 4. Fix: for a TEAM_CHALLENGE the endpoint is refused with 409 `USE_TEAM_ROSTER` unless it is an admin override (still audited as `PARTICIPANT_REMOVED_BY_ADMIN`); rosters are changed only through `DELETE /teams/:teamId/matches/:matchId/roster/:userId`, which requires captain / vice captain of THAT team and a player on THAT team's side. OPEN_MATCH behavior is unchanged; no migration. Attendance (no-show) marking by the organizer on both sides is part of the organizer's completion duty (D4 / D5) and was not changed. `tests/team-match-roster-permissions.test.ts` |
| PRIV-01 account deletion (D18) | **implemented, awaiting review / commit** (migrations `20261122000100_account_deletion_audit_action`, `20261122000200_account_deletion_guards`, `20261123000100_venue_block_deletion_guards`): `GET /users/me/deletion-blockers` and `POST /users/me/delete` (password re-check, rate-limited, 204). Blockers (all returned at once, same query for preview and deletion): `ORGANIZES_UPCOMING_MATCHES` (per match: cancel / complete / cancel_or_complete), `CAPTAINS_TEAM_WITH_MEMBERS`, `TEAM_MEMBERSHIP`, `OWNS_ACTIVE_VENUES`, `VENUE_FUTURE_PENDING_BOOKINGS`, `VENUE_FUTURE_CONFIRMED_BOOKINGS`, `VENUE_FUTURE_BLOCKS`. **Teams:** deletion itself never removes a membership; an ordinary MEMBER / VICE_CAPTAIN must leave first (D18 blocker 4, A3), a captain with members must hand over the captaincy, a sole captain's team and membership row stay. **Corrected domain rule:** an EXTERNAL booking is a self-reported snapshot that belongs to no venue (D11), so it can neither block nor be cancelled; the owner's offline reservations are `VenueBlock` rows, and future ones on owned venues are the blocker. Cleanup in ONE transaction: withdraw pending join requests, cancel own future in-app bookings (`releaseBookingForMatch`, reason 'account deleted': row lock, BOOK-01/02 safe), cancel own outgoing pending challenges (`cancelPendingChallengeInTx`), remove staff roles, expire match and team invitations addressed to the user, erase personal rows, anonymize in place (placeholder `deleted-<id>@deleted.invalid`, Argon2 hash of a random secret, name 'Deleted user'), one `ACCOUNT_DELETED` audit record (counts only). History, participations, memberships, reports, reviews, messages and the audit log are untouched. **Unsupported:** organizer transfer and venue ownership transfer. **Staff and admins keep managing a venue, and creating its blocks, after its owner's account is deleted** (the guards refuse only a DELETED creator; an admin can reactivate INACTIVE and SUSPENDED venues; deleted owners are not notified). **Concurrency (lock order user row -> venue row -> field row -> booking rows):** the deletion locks pending team invitations, then the user row `FOR NO KEY UPDATE`, then ONLY the venues the user owns (`FOR NO KEY UPDATE`, id order), then evaluates the blockers. `fym_active_user_guard` (BEFORE INSERT on match, booking, venue, venue_staff, match_request, team_member, team_challenge, venue_block(created_by_id), and on a team_member role change) takes `FOR SHARE` on the referenced user; `fym_booking_venue_active` and `fym_venue_block_venue_share` take `FOR SHARE` on the venue row, so bookings, blocks, deactivations and reactivations serialize with the deletion; `updateVenue` takes the venue row first on every status change and refuses a caller whose own account was deleted. The anonymizing UPDATE changes the unique email, so Postgres takes a FOR UPDATE-strength lock on the user row for it: it waits only for in-flight inserts that reference the user (they never wait for a row the deletion holds), and the notifications are therefore erased AFTER it. No cycle found; no lock added to the notification path (a `FOR SHARE` there would deadlock with a venue cancelling a booking while notifying its player). **Review fixes:** (1) future VenueBlock creation and owned-venue reactivation no longer race the deletion; (2) the mail worker never claims a DELETED recipient (finished as FAILED / `ACCOUNT_DELETED`), re-checks recipient and claim id right before the send without holding a lock across SMTP, and `verifyEmail` refuses non-ACTIVE accounts like reset-password; (3) lifecycle job `purgeDeletedUserNotifications` (bounded, idempotent, push deliveries first, no user-row lock) removes notifications inserted for a deleted account while the deletion held its locks. Residual (accepted): one mail already being handed to the mail server when the deletion commits is still sent once to the user's own former address (the token is erased, the link is dead; a database lock cannot be held across a network call); a stray notification exists for at most one job interval. `tests/account-deletion.test.ts`, `tests/account-deletion-race.test.ts`, `tests/account-deletion-limits.test.ts`, `tests/mail-deleted-recipient.test.ts`, `tests/notification-purge.test.ts` |

## Implementation plan (Phase 1 above is done; Phases 2 and 3 are not started)

Grouped by what each group needs approved first. Effort: S = hours, M = a day or two, L = several days.

**Phase 1: no schema or dependency change** (can start as soon as approved)
1. CONC-01 lock order and retry on cancel / complete / sweepers (M, with the race test)
2. ERR-01 body-parser errors to 4xx (S)
3. BIZ-03 lazy match start (M)
4. JOB-01 sweeper isolation and batch limits (M)
5. OPS-07 graceful shutdown and unhandled-error handlers (S); OPS-01 production config guards (S)
6. AUTHZ-01 staff escalation rules (S); AUTH-04 socket revalidation (M)
7. SEC-03 global and per-user rate limits (M)
8. PERF-01 inbox: one query plus pagination (M)
9. OBS-01 request id and health-log fix (S)

**Phase 2: needs a database migration approved**
10. AUD-01 audit-log table (M)
11. MAIL-01 and AUTH-02: e-mail outbox, worker, constant-time forgot-password, deep-link templates (L)
12. NOTIF-01: Expo push delivery worker, attempts / last-error columns, localized text, token validation and cleanup, retention (L). Needs C3
13. BIZ-02 remainder: organizer remembered at challenge creation; reschedule for team matches (M). Needs B1 **(done: BIZ-02)**
14. PRIV-01: deletion endpoint, four blockers, anonymization (L). Needs A1-A5; venue ownership transfer and organizer transfer only if decided (B2, A5) **(done: PRIV-01, awaiting commit; neither transfer exists)**

**Phase 3: needs a new dependency or infrastructure approved**
15. OBS-01: **Sentry** SDK (S-M, new dependency; needs C2)
16. OPS-03: Redis for the rate limiter and Socket.IO adapter (M, new dependency and service)
17. OPS-08: separate runtime and migration database roles, `connection_limit`, pooler (M, infrastructure)
18. OPS-02: automated backups, PITR, database timeouts, restore drill (M-L, infrastructure)

**Then P2** in the order PERF-02, CONC-02, AUTHZ-02, PRIV-02, retention, tests.

## Missing tests (to become permanent)
Cancel vs accept race; the same request accepted twice (currently `200 + 200`; whether two notifications result is not verified); team size cap race; the authorization sweep as a regression suite; staff self-escalation; suspended user's socket; oversized / bad-encoding requests; constant-time `forgot-password` and SMTP timeouts; graceful shutdown with a live socket; sweeper isolation; a scheduled database-consistency checker (the invariant queries); migration drift in CI (`prisma migrate diff --exit-code`); a staging load test; an automated restore drill; deletion blockers and anonymization once built.

## Not verified
Real SMTP delivery, behaviour behind a load balancer, production capacity (the load test shared one machine with the database), the CI workflow on GitHub, Expo deep-link and push behaviour (nothing built yet), client-side RTL.
