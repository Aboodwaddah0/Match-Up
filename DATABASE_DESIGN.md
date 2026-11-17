# Find Your Match — Database Design (pre-ERD, v0.2)

Status: design discussion, **not final**. No Prisma schema yet. Based on `PROJECT_REQUIREMENTS.md` including Addendum D1–D10.
Conventions: UUID primary keys, all timestamps `timestamptz` (UTC), money as `Decimal(10,2)` plus `currency`, soft-delete/anonymize users instead of hard delete (history must survive), FKs default to `RESTRICT` unless stated.

---

## 1. Entity Map (by domain)

| Domain | Entities |
|---|---|
| Identity | User, UserToken (email-verify / password-reset), RefreshToken, DeviceToken (push, later), BlockedUser |
| Player | PlayerProfile, PlayerPosition |
| Geo / i18n | City (name_ar, name_en, default timezone) |
| Venues | Venue, VenueStaff, VenueImage, VenueField, VenueOpeningHours, **VenueBlock** |
| Booking | Booking, BookingEvent |
| Matches | Match, MatchRequiredPosition, MatchRequest, MatchParticipant, MatchTeam, MatchInvitation, MatchEvent |
| Teams | Team, TeamMember, TeamInvitation, TeamChallenge |
| Social / trust | Review, Favorite, Report, Notification |
| Chat (later) | Conversation, ConversationParticipant, Message |

Changes vs the original list: `VenueBooking` -> `Booking` (external bookings have no venue); `VenueAvailability` -> `VenueOpeningHours` + `VenueClosure` (slots are computed, not stored); added VenueStaff, UserToken, RefreshToken, BlockedUser, City, MatchInvitation, MatchTeam, TeamInvitation, BookingEvent, MatchEvent, ConversationParticipant.

## 2. Enums

- `PlatformRole`: USER, ADMIN (global; nothing venue-related)
- `AccountStatus`: ACTIVE, SUSPENDED, DELETED
- `Position`: GOALKEEPER, DEFENDER, MIDFIELDER, WINGER, STRIKER
- `SkillLevel`: BEGINNER, INTERMEDIATE, ADVANCED, PROFESSIONAL
- `PreferredFoot`: RIGHT, LEFT, BOTH
- `Format`: F5, F7, F11 (keep as enum in MVP; a `Format` lookup table is the future path)
- `MatchType`: OPEN_MATCH (open recruitment, join requests), TEAM_CHALLENGE (team vs team fixture, no recruitment)
- `MatchVisibility`: PUBLIC, PRIVATE
- `MatchStatus`: OPEN, FULL (**OPEN_MATCH only** — recruitment states), **SCHEDULED** (**TEAM_CHALLENGE only** — confirmed fixture, no recruitment), IN_PROGRESS, COMPLETED, CANCELLED, **CLOSED_UNCONFIRMED** (proposed, see Q-C)
  - CHECK: OPEN_MATCH status in (OPEN, FULL, IN_PROGRESS, COMPLETED, CANCELLED, CLOSED_UNCONFIRMED); TEAM_CHALLENGE status in (SCHEDULED, IN_PROGRESS, COMPLETED, CANCELLED, CLOSED_UNCONFIRMED).
- `RequestStatus`: PENDING, ACCEPTED, REJECTED, WITHDRAWN (by player), EXPIRED (match started / cancelled)
- `ParticipantStatus`: CONFIRMED, LEFT, REMOVED (by organizer)
- `AttendanceStatus`: UNKNOWN, ATTENDED, NO_SHOW
- `MatchSide`: HOME, AWAY
- `BookingSource`: IN_APP, EXTERNAL (venue blocks are NOT bookings — see VenueBlock)
- `BlockReason`: MAINTENANCE, PRIVATE_EVENT, OFFLINE_BOOKING, OTHER
- `BookingStatus`: PENDING, CONFIRMED, REJECTED, CANCELLED, EXPIRED, COMPLETED
- `PaymentStatus`: UNPAID, PAID, REFUNDED (informational only in MVP)
- `VenueStaffRole`: MANAGER, STAFF; `VenuePermission`: MANAGE_BOOKINGS, MANAGE_FIELDS, MANAGE_AVAILABILITY, EDIT_VENUE, MANAGE_STAFF, VIEW_REPORTS
- `TeamRole`: CAPTAIN, VICE_CAPTAIN, MEMBER
- `InvitationStatus`: PENDING, ACCEPTED, DECLINED, CANCELLED, EXPIRED
- `ChallengeStatus`: PENDING, ACCEPTED, REJECTED, CANCELLED, EXPIRED
- `ReportStatus`: OPEN, IN_REVIEW, RESOLVED, DISMISSED

## 3. Key Entities (important columns and constraints only)

### User / auth
- `User`: email (**citext, unique**), password_hash, email_verified_at, locale (`ar`|`en`), timezone (default `Asia/Hebron`), platform_role, status, created_at.
- `UserToken`: user_id, type (EMAIL_VERIFY | PASSWORD_RESET), **token_hash** (never raw), expires_at, used_at.
- `RefreshToken`: user_id, token_hash, family_id (rotation + reuse detection), expires_at, revoked_at.
- Unverified users may browse only; creating matches, joining, and booking require `email_verified_at`.
- Phone is *not* an auth identifier in the MVP (D10); a contact phone may exist on Venue.

### PlayerProfile / PlayerPosition
- PlayerProfile 1:1 User (unique user_id). Fields per Module 2, `city_id`, `latitude`/`longitude` (double, range-checked), `primary_position`.
- Denormalized counters (rebuildable from participant rows): matches_played, late_cancellations, no_shows, avg_rating, rating_count, reliability_score.
- PlayerPosition: (player_profile_id, position) **unique**; exactly one primary position enforced by `primary_position` column that must exist in PlayerPosition (service check + composite FK).

### Venue / VenueStaff (D2)
- `Venue`: owner_id -> User, name, city_id, address, `latitude`/`longitude`, contact_phone, timezone (default `Asia/Hebron`), status.
- `VenueStaff`: venue_id, user_id, role, `permissions VenuePermission[]`; **unique(venue_id, user_id)**. The owner is `Venue.owner_id` (always full rights, cannot be removed). Authorization = owner OR staff row holding the needed permission, always checked per venue.
- `VenueField`: venue_id, name, format, capacity, price_per_hour, currency, `slot_minutes` (default 60: start-time granularity and minimum duration), is_active.
- `VenueOpeningHours`: field_id (or venue_id), weekday, open_time, close_time (**local wall-clock**, interpreted in `Venue.timezone`). Available slots are computed, not stored.
- `VenueBlock` (owner/staff-managed unavailable period; **not a booking**): venue_field_id, `start_at`, `end_at`, `time_range tstzrange` (generated), reason (BlockReason), note, `group_id` (shared by the rows created when blocking several/all fields at once), created_by_id (venue staff), created_at. CHECK `end_at > start_at`. Own exclusion constraint so blocks on one field never overlap each other: `EXCLUDE USING gist (venue_field_id WITH =, time_range WITH &&)`. Requires MANAGE_AVAILABILITY permission. Deleting a block frees the slot. Recurring blocks = future feature.

### Booking (D1)
- `Booking`: id, source, status, **created_by_id -> User**, `venue_field_id` NULL, `start_at`, `end_at` (UTC), `time_range tstzrange` (generated), `total_price`, `currency`, `payment_status`, notes, `hold_expires_at` NULL, decided_by_id / decided_at, cancelled_by_id / cancel_reason.
- External snapshot columns: `ext_venue_name`, `ext_venue_address`, `ext_venue_phone`, `ext_field_info`.
- CHECK by source:
  - IN_APP: `venue_field_id` NOT NULL, ext_* all NULL, `hold_expires_at` NOT NULL while PENDING.
  - EXTERNAL: `venue_field_id` NULL, `ext_venue_name` NOT NULL, status starts CONFIRMED (self-reported, never owner-approved).
  - `created_by_id` is always the requesting player/organizer; venue staff only ever appear in `decided_by_id`. Service rule: a user cannot decide their own booking (staff booking their own venue as a player must be approved by another authorized user).
  - `end_at > start_at`.
- **Overlap guarantee:** PostgreSQL exclusion constraint (needs `btree_gist`):
  `EXCLUDE USING gist (venue_field_id WITH =, time_range WITH &&) WHERE (status IN ('PENDING','CONFIRMED') AND venue_field_id IS NOT NULL)`
  Raw-SQL migration (Prisma cannot declare this). This makes double booking impossible even if application code has a bug.
- External bookings are exempt (no field) — they never block in-app inventory.
- **Booking vs VenueBlock overlap (cross-table):** a PostgreSQL exclusion constraint cannot span two tables, so this is enforced by (1) both writers (create booking, create block) taking `SELECT ... FROM venue_field WHERE id = $f FOR UPDATE` first, which serializes them per field, then checking the other table inside the same transaction, and (2) a `BEFORE INSERT/UPDATE` constraint trigger on both tables as a database-level backstop. Rules: a booking request overlapping a block is rejected ("slot unavailable"); creating a block over a PENDING/CONFIRMED booking is rejected with the list of conflicting bookings, and the owner must reject/cancel them first (no silent cancellation of a player's booking).
- Considered and rejected for the MVP: a unified "slot claim" table that both Booking and VenueBlock write to, which would give a single exclusion constraint but adds a synchronization table. Revisit if the trigger approach proves fragile.

### Match
- `Match`: organizer_id, title, description, type, visibility, format, status, `start_at`, `end_at`, `timezone`, city_id, location_name, `latitude`/`longitude`, **`booking_id` NULL** (FK, optional), required_skill_level, price_per_player, currency, `capacity` (players the organizer is looking for through the app; OPEN_MATCH only), notes, completed_at / completed_by_id, closed_unconfirmed_at, cancelled_at / cancelled_by_id / cancel_reason. **Neither `confirmed_count` nor `available_spots` is stored (D17):** both are derived from CONFIRMED `MatchParticipant` rows (`confirmed_count = COUNT(*)`, `available_spots = capacity - confirmed_count`).
- Match holds only a reference to Booking; no booking data is duplicated.
- CHECK (by type): **OPEN_MATCH** -> `capacity BETWEEN 1 AND total_players(format)` where total = 10 (5v5), 14 (7v7), 22 (11v11), via an immutable SQL function. `capacity >= COUNT(CONFIRMED)` is enforced by triggers (a CHECK cannot see other tables). **TEAM_CHALLENGE** -> `capacity` NULL (open-recruitment concepts do not apply). Always: `end_at > start_at`.
- `capacity` for OPEN_MATCH means *only* the players wanted through the app. Players arranged outside the app are never modeled and never part of capacity; it is not the total across both sides.
- **Capacity model (final, D13):** the organizer enters only how many players they want from the app (e.g., 7v7, looking for 6 -> capacity = 6). They never enter how many they already have. The organizer is not counted. `available_spots = capacity - confirmed_count`; the match becomes FULL when `confirmed_count = capacity` and returns to OPEN when a spot frees (leave/removal) before start.
- **Why derived, not stored (D17):** a stored counter is a second copy of the truth that can drift (missed decrement, crash between two statements, manual data fix). A match has at most ~22 participant rows, so `COUNT(*)` over a partial index `(match_id) WHERE status='CONFIRMED'` is trivial. Reads use the `match_availability` view (`confirmed_count`, `available_spots`) or a lateral count. Safety does **not** come from a counter: it comes from locking the match row, then counting, then inserting — and a database trigger repeats that check so even buggy application code cannot overfill a match. Denormalize later only if profiling proves discovery queries need it.
- **Editing capacity (OPEN_MATCH only), under the match row lock:** allowed only while status is OPEN or FULL **and** `start_at > now()` (DB time). Raise any time before start; lower only if `new_capacity >= confirmed_count`; never after the match started, completed or cancelled. In the same transaction recompute status: `confirmed_count = capacity` -> FULL, `confirmed_count < capacity` -> OPEN. Notify pending requesters when a FULL match reopens (optional).
- **TEAM_CHALLENGE is a separate concept:** no `capacity`, no `confirmed_count`, no `available_spots`, no OPEN/FULL, no `MatchRequest` rows (service guard + constraint trigger rejects requests for non-OPEN_MATCH matches). The *target player count* is derived from the format (`format size x 2`, e.g., 14 for 7v7), never stored. Each team's roster is `MatchParticipant` rows with `match_team_id`, at most `format size` per side (checked in the roster transaction under the match lock); a roster below the format size is allowed to be incomplete until start (captains decide). Status starts SCHEDULED when the challenge is accepted.
- If `booking_id` set: an IN_APP booking must be **CONFIRMED** to be linked (PENDING cannot be linked); service verifies match window is inside the booking window and the booking was created by the organizer (or the organizer's team captain / venue staff for challenge matches).
- A booking may link to **at most one non-cancelled match** (partial unique index on `booking_id` where status not CANCELLED) — proposed default.

### MatchRequest vs MatchParticipant (separate concepts — hard requirement)
- `MatchRequest` = the *ask*. Columns: match_id, user_id, status, message, decided_by_id, decided_at. Unique **partial** index `(match_id, user_id) WHERE status = 'PENDING'` blocks duplicate open requests while allowing history (e.g., re-request after leaving). Requests never count toward capacity. Requests exist only for OPEN_MATCH matches.
- `MatchParticipant` = *confirmed membership*. Columns: match_id, user_id, status (CONFIRMED/LEFT/REMOVED), `match_team_id` NULL, position_played NULL, joined_at, left_at, `is_late_cancellation`, attendance_status, attendance_confirmed_by/at, request_id (origin), **`time_range` (copy of match window)**.
  - One row per (match, user): `UNIQUE (match_id, user_id)`; rejoining after LEFT re-activates the same row via a new accepted request.
  - **Anti-overlap (D3):** `EXCLUDE USING gist (user_id WITH =, time_range WITH &&) WHERE (status = 'CONFIRMED')`. The match window is copied into the participant row (kept in sync inside the same transaction as any match reschedule — see Q-B).
- Accept = one transaction: lock match row -> verify status OPEN and COUNT(CONFIRMED) < capacity -> mark request ACCEPTED -> insert/reactivate participant (a DB trigger re-checks capacity under the same match-row lock and flips the match to FULL) -> write Notification + MatchEvent. Overlap violation raises a constraint error mapped to a generic "player has a scheduling conflict" (does **not** reveal the other match).
- Leave = one transaction: lock match -> verify match not started -> participant LEFT (trigger sets `left_at`, `is_late_cancellation = (start_at - now < 12h)` and flips FULL -> OPEN) -> notify organizer.
- No-show: organizer sets `attendance_status = NO_SHOW` (only after match start; only on CONFIRMED participants) — stored separately from leaving. Reliability counters derive from `is_late_cancellation` and `NO_SHOW`.

### MatchTeam / TeamChallenge (D7)
- `MatchTeam`: match_id, team_id, side. `UNIQUE (match_id, side)`, `UNIQUE (match_id, team_id)`. Only for `type = TEAM_CHALLENGE` (exactly 2 rows, enforced in the accept-challenge transaction).
- `TeamChallenge`: challenger_team_id, challenged_team_id, proposed_start_at, format, message, status, expires_at, resulting_match_id NULL, decided_by_id. CHECK teams differ. Accepting (by captain/vice) creates the Match + 2 MatchTeam rows atomically.
- Team-match rosters: captains select players from TeamMember; those become MatchParticipant rows with `match_team_id` set. Same overlap constraint applies.

### MatchInvitation (D8)
- `MatchInvitation`: match_id, invitee_id, invited_by_id, status. `UNIQUE (match_id, invitee_id)`.
- Invitation grants *visibility* and the right to request. It is **not** participation and does not reserve a spot.
- Visibility rule (one shared query predicate): public match, OR viewer is organizer, OR viewer has a participant/request/invitation row, OR admin.

### Notification
- user_id, type, `params jsonb` (not pre-rendered text, so it renders in the user's locale), resource_type, resource_id, read_at, created_at, `push_sent_at`. Created **inside the same transaction** as the state change (transactional outbox); a worker sends pushes later.

### Review
- match_id, reviewer_id, reviewed_id, scores, comment. `UNIQUE (match_id, reviewer_id, reviewed_id)`; CHECK reviewer <> reviewed. Service verifies match COMPLETED and both users ATTENDED. Review window proposed: 7 days after completion.

### Others
- `Favorite`: (user_id, target_type, target_id) unique. `BlockedUser`: (blocker_id, blocked_id) unique. `Report`: reporter, target_type/id, reason, status, resolved_by. `TeamMember`: UNIQUE(team_id, user_id), exactly one CAPTAIN per team (partial unique index).
- `BookingEvent` / `MatchEvent`: append-only status history (who, from, to, at, reason). Cheap, and essential for disputes (no-shows, cancellations).

## 4. Indexes (initial)
- Match: partial `(start_at) WHERE type='OPEN_MATCH' AND status IN ('OPEN','FULL') AND visibility='PUBLIC'`; GiST on `location`; `(organizer_id, start_at)`; `(city_id, start_at)`; `booking_id` (partial unique).
- Venue / PlayerProfile: GiST on `location`; `(city_id)`.
- Booking: `(venue_field_id, start_at)`; `(created_by_id, status)`; **`(hold_expires_at) WHERE status='PENDING'`** (sweeper); exclusion constraint's own GiST index.
- MatchRequest: `(match_id, status)`, `(user_id, status)`. MatchParticipant: `(user_id, status)`, `(match_id, status)`.
- Notification: `(user_id, read_at, created_at DESC)`.

## 5. Booking Expiry Design (reliable by construction)
Never rely on a timer for correctness. Three layers:
1. **Constraint layer:** only PENDING/CONFIRMED rows block the slot; status is the single source of truth.
2. **Lazy expiry on the write path:** before inserting a new IN_APP booking (and before an owner confirms), run in the same transaction:
   `UPDATE booking SET status='EXPIRED' WHERE status='PENDING' AND hold_expires_at <= now() AND venue_field_id = $field AND time_range && $range`. A stale hold can therefore never block a new booking, even if the sweeper is down.
3. **Sweeper (every ~1 min):** `UPDATE ... SET status='EXPIRED' WHERE status='PENDING' AND hold_expires_at <= now() RETURNING id` (atomic and idempotent, safe with multiple instances), then notify requester and venue. Optional reminder to the venue at 1h.
- **Owner confirm race:** confirm is a single guarded statement: `UPDATE ... SET status='CONFIRMED' WHERE id=$id AND status='PENDING' AND hold_expires_at > now()`; 0 rows -> "request expired or already handled".
- **Hold never outlives the start time:** `hold_expires_at = LEAST(created_at + 2h, start_at)`; bookings with `start_at` in the past are rejected.
- Per-user cap on simultaneous PENDING holds (proposed: 3) to prevent slot hoarding.
- Availability display = opening hours minus VenueBlocks minus (PENDING-with-unexpired-hold + CONFIRMED bookings), computed in `Venue.timezone` on `slot_minutes` boundaries. Booking creation re-validates the same rule inside the locked transaction; the UI list is never trusted.
- Linked-match effect: when a booking becomes REJECTED/CANCELLED/EXPIRED, the match is **not** auto-cancelled; the match keeps the link, flagged "venue not confirmed", and organizer + participants are notified.

## 6. Match Lifecycle Automation Design (D5)
- **Capacity transitions (OPEN <-> FULL; OPEN_MATCH only, never TEAM_CHALLENGE):** done synchronously inside the accept/leave/remove transactions (locked), never by a job.
- **Start transition:** sweeper (~1 min): `UPDATE match SET status='IN_PROGRESS' WHERE status IN ('OPEN','FULL','SCHEDULED') AND start_at <= now() RETURNING id`; same transaction expires that match's PENDING requests and invitations. Lazy enforcement too: every join/leave/accept path re-checks `start_at > now()` regardless of stored status.
- **COMPLETED:** only by organizer action (`IN_PROGRESS` -> `COMPLETED`), at which point attendance is finalized, counters recomputed, reviews opened.
- **CLOSED_UNCONFIRMED (final, D16):**
  - *When:* a match in `IN_PROGRESS` whose `end_at + 48h` has passed with no organizer action. Never directly from OPEN/FULL/SCHEDULED: every match first passes through IN_PROGRESS at its start time, so this status always means "it was scheduled, the time passed, nobody confirmed it happened". The 48h grace is a constant in one DB function.
  - *Both match types:* yes (OPEN_MATCH and TEAM_CHALLENGE).
  - *Versus CANCELLED:* CANCELLED is an explicit human decision ("it will not / did not happen"), notifies participants as a cancellation, and may release the linked booking. CLOSED_UNCONFIRMED is a system outcome meaning *unknown*: no cancellation notices and no booking release. Neither produces stats, reviews or reliability changes.
  - *Recovery:* the organizer may, within **7 days** after closure, move it to COMPLETED (it did happen) or CANCELLED (it did not). After 7 days only an admin can. Both enforced by the status-transition trigger, the organizer/admin distinction by the service. Reviews open from the moment of COMPLETED.
  - Reminders go to the organizer at `end_at` and again before the 48h grace ends.
- **Cancel:** organizer/admin, from OPEN/FULL/IN_PROGRESS? (proposed: OPEN/FULL only; IN_PROGRESS cancel by admin). One transaction: status CANCELLED, expire pending requests, notify participants, apply booking handling below.
- **Cancel + linked booking:** match cancel never silently cancels a booking. The cancel flow asks `release_booking: true|false`. If true and booking is IN_APP and not used by another match -> booking CANCELLED (slot freed, venue notified). EXTERNAL bookings are only unlinked (the app can't cancel them).
- **Job infrastructure:** `node-cron` (or `pg_cron`) is fine for MVP *because* jobs are idempotent sweeps. Rules: DB time (`now()`), atomic `UPDATE ... RETURNING`, `FOR UPDATE SKIP LOCKED` for batches, log every run, health alert if the sweeper hasn't run for 5 min. Moving to BullMQ later changes nothing in correctness.

## 7. Time Zones and i18n (D9)
- Store UTC. Opening hours are local wall-clock + `Venue.timezone`; slot generation converts per date (never store local datetimes). Palestine's DST rules change by decree: keep the IANA tz database up to date in deployment.
- Match gets its own `timezone` (venue's or city's) so display is stable for travelling users.
- User-facing strings: API returns codes and params; clients translate. Notifications store `type + params`. Enum labels live in the client.
- `City` lookup table with `name_ar`/`name_en` avoids the "نابلس" vs "Nablus" free-text search problem. User-written text (venue names, bios) is stored as typed (single language per field in MVP). Arabic search needs normalization (strip tashkeel, unify alef/ya/ta-marbuta forms) — design the search column accordingly.
- Dates in API: ISO-8601 UTC; clients render locale + Asia/Hebron (or user timezone).

## 8. Edge Cases and Conflicts Found

**Conflicts with earlier text (now resolved by the addendum):**
1. Original "no overlapping *confirmed* bookings" vs 2-hour hold -> constraint now covers PENDING+CONFIRMED; expired holds flip to EXPIRED (new status).
2. Original 5 booking statuses -> 6 (EXPIRED added). Match gets CLOSED_UNCONFIRMED (proposed).
3. Original "prevent confirming overlapping matches" -> now exactly "only CONFIRMED participation blocks"; requests only warn.
4. "Total required players" was ambiguous -> see Q-A.

**Edge cases and designed answers:**
- Two organizers accept the same player simultaneously: participant exclusion constraint serializes; loser gets a generic conflict error.
- Player accepted into match A while having pending requests for overlapping match B: B's requests stay pending, but accepting them fails; UI shows a conflict badge. No silent auto-withdrawal.
- Conflict warning must not leak other matches: warn "you have a match at this time" only to the player themself; organizers see only "scheduling conflict".
- Match becomes FULL with pending requests outstanding: stay PENDING; if someone leaves, organizer may accept. All expire at start or cancel.
- Player leaves then re-requests: allowed (history preserved, one participant row reactivated). Repeated late cancellations lower reliability (formula to be defined).
- Organizer removing a player: REMOVED, not a late cancellation, no reliability penalty for the player.
- Leaving an IN_PROGRESS match: not allowed (absence is handled via NO_SHOW).
- False no-show accusations: only organizer can mark; player can dispute through Report; counters are derived so admin correction is possible.
- Owner confirms exactly as the hold expires: guarded UPDATE decides; user always gets a deterministic message.
- Venue closes/changes hours with existing CONFIRMED bookings: closures never auto-cancel; they list conflicting bookings for the owner to resolve.
- Field price changes after a request: `total_price` is snapshotted on the booking.
- External booking naming a *registered* venue: not allowed to reserve that field (no overlap protection) -> either link to the registered venue as IN_APP, or it stays a self-reported snapshot. Shown to participants as "reported by organizer" (unverified), never as "confirmed by venue".
- Booking window vs match window mismatch: match window must be inside booking window; editing either re-validates.
- Organizer account suspended/deleted with future matches: matches cancelled (or admin-reassigned) with notifications; users are anonymized, not hard-deleted, to preserve history.
- Blocked users: cannot request, be invited to, or message each other's matches; existing shared matches unaffected.
- Private match leakage: one shared visibility predicate used by detail, search, chat and notifications; covered by tests.
- Team match: a user cannot be on both sides (unique participant per match); roster changes after the challenge-match is created follow the same leave/remove rules.
- Challenge acceptance after proposed time passed or teams changed: challenge `expires_at`; re-validate at accept.
- Clock/skew: all comparisons use database `now()`, never application server time.
- Replay/duplicate API calls (mobile retries): accept/leave/confirm endpoints must be idempotent (state-guarded updates return the current state, not a 500).

## 9. Open Questions (decide before the final ERD)

Blocking (change the schema):
- **Q-A Capacity model — RESOLVED, final (D13):** `capacity` = number of players the organizer wants through the app. No `reserved_by_organizer` column (dropped). `available_spots` is derived. Only CONFIRMED participants count toward `confirmed_count`. See the Match section.
- **Q-B Rescheduling — RESOLVED (2026-11-17):** an organizer may change a match's date/time only while it has 0 CONFIRMED participants; otherwise cancel and recreate. Enforced in the update transaction under the match row lock (so it can't race with an accept). Pending requests/invitations are kept but the organizer's change notifies those users. If a booking is linked, the new window must stay inside the booking window. Because time can't change once anyone is confirmed, `MatchParticipant.time_range` never needs re-syncing.
- **Q-D Venue-created blocks — RESOLVED (2026-11-17, D11):** venue staff block slots using a separate `VenueBlock` entity, never a Booking. Bookings are only ever created by players/organizers.

Non-blocking (I will use these defaults unless you object):
- **Q-C — RESOLVED (D16):** see "CLOSED_UNCONFIRMED" in §6.
- **Q-E** Currency: single `ILS` default stored per record.
- Slot granularity: 60-minute starts, venue-configurable later; minimum lead time = 2h hold window.
- Max 3 simultaneous PENDING booking holds per user.
- Review window: 7 days after COMPLETED.
- Venue cancellation policy for CONFIRMED bookings (deadlines, fees): deferred; MVP allows cancel with notification only.

## 10. Next Steps
1. You answer Q-A, Q-B, Q-D (and veto any default above).
2. I produce the ERD (Mermaid) per domain, then we review constraints, indexes and cascade rules.
3. Prisma schema plus raw-SQL migration for: `btree_gist`, `citext`, `cube` + `earthdistance` (instead of PostGIS for the MVP: plain latitude/longitude columns with a GiST index on `ll_to_earth(...)`; PostGIS remains a later option), exclusion constraints, partial unique indexes, CHECKs.
4. A small concurrency test plan (parallel accept, parallel booking, expiry race) before building the services.
