# Find Your Match

Football matchmaking platform. Requirements: [PROJECT_REQUIREMENTS.md](PROJECT_REQUIREMENTS.md) · Database: [DATABASE_DESIGN.md](DATABASE_DESIGN.md), [DATABASE_ERD.md](DATABASE_ERD.md) · DB layer: [backend/prisma/README.md](backend/prisma/README.md)

## Run with Docker (recommended)

Requires Docker Desktop running.

```bash
docker compose up -d --build
```

| Service | What it does | URL / port |
|---|---|---|
| `db` | PostgreSQL 16 (data in volume `pgdata`) | `localhost:5433` (user `fym`, db `fym`) |
| `migrate` | One-shot: `prisma migrate deploy` (tables + constraints/triggers) | — |
| `api` | TypeScript API, hot reload (`tsx watch`) | http://localhost:3000/health , `/health/db` |
| `adminer` | Optional DB UI (`--profile tools`) | http://localhost:8080 |

```bash
docker compose logs -f api            # follow API logs
docker compose --profile tools up -d  # add Adminer
docker compose down                   # stop, keep data
docker compose down -v                # stop and WIPE the database
```

Override defaults by copying `.env.example` to `.env` (never commit it).

## Run without Docker for the API

```bash
docker compose up -d db               # just the database
cd backend
cp .env.example .env
npm install
npm run db:migrate                    # apply migrations
npm run dev                           # http://localhost:3000
```

## Scripts (`backend/`)

| Script | Purpose |
|---|---|
| `npm run dev` | API with hot reload |
| `npm run build` / `npm start` | Compile to `dist/` and run |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest |
| `npm run db:migrate` | `prisma migrate deploy` |
| `npm run db:migrate:dev` | Create/apply a dev migration |

## Layout

```
docker-compose.yml        db, migrate, api, adminer
backend/
  Dockerfile              targets: dev (hot reload) and prod (compiled, non-root)
  prisma/                 schema, migrations (constraints + triggers), DB tests
  src/
    app.ts  server.ts     app wiring (routers mounted in app.ts), HTTP + Socket.IO start
    config/env.ts         validated environment (zod)
    lib/                  shared utilities: prisma, logger, errors + db-errors (deadlock retry), jwt, mailer, time, blocks
    middleware/           authenticate (+ actorOf), validate (zod), rate-limit, error-handler
    types/                shared types (Actor, Express request typing)
    jobs/                 time-driven sweepers (match start / close, booking and offer expiry)
    modules/<name>/       one folder per business module (see below)
  tests/                  integration tests against a real Postgres database
```

### How a module is organized

Each layer has one job. Files exist only when the module needs them (a tiny module may have just routes + controller + service).

| File | Responsibility | Must NOT contain |
|---|---|---|
| `<name>.routes.ts` | HTTP endpoints; attaches `authenticate`, role / verified-e-mail guards, rate limiters and `validate(...)`; connects each endpoint to a controller function | logic, queries |
| `<name>.controller.ts` | reads validated input (`valid(req, ...)`) and the caller (`actorOf(req)`), calls the service, sets the HTTP status and response | Prisma, business rules |
| `<name>.service.ts` | business rules, Prisma queries, transactions, ownership and permission checks; takes plain arguments (`actor`, ids, validated input) | Express `req` / `res` |
| `<name>.schemas.ts` | Zod validation of params, query and body | logic |

Shared pieces live outside the modules: `Actor` and request typing in `types/`, `authenticate` / `actorOf` / `validate` in `middleware/`, and cross-cutting helpers (`areBlocked`, `withDeadlockRetry`, time zones) in `lib/`.
Dependencies between modules go one way and never in a circle: `matches -> bookings -> venues`, `teams / reviews -> matches`, `safety -> chat`, `auth -> users`, and every module that sends notifications -> `notifications`.

## Auth API (`/api/v1`)

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /auth/register` | – | email + password + fullName (+ locale `ar`/`en`); sends verification e-mail |
| `POST /auth/verify-email` | – | `{ token }` from the e-mail link (single use, 24h) |
| `POST /auth/resend-verification` | Bearer | new verification link |
| `POST /auth/login` | – | returns `accessToken` (15 min JWT) + `refreshToken` (30 days, opaque) |
| `POST /auth/refresh` | – | rotates the refresh token; reusing an old one revokes the whole session family |
| `POST /auth/logout` / `logout-all` | – / Bearer | end this device / every device |
| `POST /auth/forgot-password` | – | always answers 202 (no account discovery); link valid 1h |
| `POST /auth/reset-password` | – | `{ token, newPassword }`; revokes all sessions |
| `POST /auth/change-password` | Bearer | needs current password; returns a fresh session |
| `GET /users/me` | Bearer | current user |
| `PATCH /users/me` | Bearer | fullName, avatarUrl (https), locale, timezone |
| `GET /cities` | – | seeded cities (Arabic + English) |
| `PUT /players/me` | Bearer | create/replace my player profile: positions[], primaryPosition, skillLevel, preferredFoot, dateOfBirth, bio, cityId, latitude/longitude |
| `GET /players/me` | Bearer | my profile (includes birth date and saved location) |
| `GET /players/:userId` | Bearer | public profile: age, city, positions, skill, derived stats; no birth date/coordinates/e-mail; 404 if blocked |

Send `Authorization: Bearer <accessToken>`. Errors look like `{ "error": { "code", "message" } }`.
E-mail goes out over any SMTP provider: set `SMTP_URL` (e.g. `smtps://user:pass@smtp.example.com:465`) and `MAIL_FROM` in `.env`. Without `SMTP_URL`, development prints e-mails in the API log (`docker compose logs api`) and production refuses to start. Mail is sent by a background worker from an outbox table, never inside a request (next section).

### Rate limits (authentication)

Each endpoint has its own limiter, and password guessing is limited per ACCOUNT as well as per IP (many users share one IP: mobile carriers, offices, proxies). Limits are in `backend/src/middleware/rate-limit.ts`.

| Endpoint | Limit |
|---|---|
| `POST /auth/login` | 100 / 15 min per IP, and 10 FAILED attempts / 15 min per e-mail (successful logins are not counted) |
| `POST /auth/register` | 30 / hour per IP |
| `POST /auth/refresh` | 120 / 15 min per IP |
| `POST /auth/verify-email`, `/reset-password` | 30 / 15 min per IP (shared) |
| `POST /auth/forgot-password` | 20 / hour per IP and 5 / hour per target e-mail |
| `POST /auth/resend-verification` | 5 / hour per user |
| `POST /auth/change-password` | 10 wrong passwords / 15 min per user |

**Whole API and creation endpoints.** On top of the table above, every request passes a global limiter (600 / minute per signed-in user, 300 / minute per anonymous IP; `/health` and `/health/db` are exempt), and the endpoints that create rows or send notifications have a per-user limit: matches 20 / hour, join requests 60 / hour, invitations (match and team) 60 / hour, venues 10 / hour, fields 60 / hour, bookings (in-app and external) 30 / hour, teams 10 / hour, challenges 20 / hour, opening direct chats 30 / hour, chat messages 60 / minute, device tokens 20 / hour. A refused request is `429 RATE_LIMITED` with `RateLimit-*` headers.

Counters live in memory per API instance: with several instances use a shared store (Redis), otherwise the effective limit is multiplied. **Behind a reverse proxy set `TRUST_PROXY=1`**, otherwise all clients share the proxy's IP (the API logs a warning at start-up in production when it is 0).

### Request ids, shutdown and production checks

- Every response carries `X-Request-Id` (a client may send its own, 8-64 characters of `A-Za-z0-9._-`); the same id is in the log line and in the `requestId` field of every JSON error, so a user's error report can be matched to the log. Health probes are not logged. Oversized (413), badly encoded (400, 415) and malformed JSON (400) bodies are client errors, never 500.
- On `SIGTERM` / `SIGINT` the API stops accepting connections, finishes requests in flight, disconnects websockets, waits for a sweeper run in progress and closes the database. If that takes longer than `SHUTDOWN_TIMEOUT_MS` (default 8000, keep it below the orchestrator's kill timeout, Docker's is 10 s) the remaining connections are cut and the exit code is 1. An unhandled rejection or uncaught exception is logged as fatal and shuts down the same way.
- With `NODE_ENV=production` the API refuses to start (listing every problem) if `JWT_ACCESS_SECRET` is one of the placeholders from this repo, the database password is the development one, `SMTP_URL` is missing, or the e-mail links would point at `localhost` (set `APP_URL`, or both `VERIFY_EMAIL_URL` and `RESET_PASSWORD_URL`).
- Websocket sessions end when the access token that opened them expires, and at once on suspension, logout-everywhere and password change or reset. After a disconnect the client reconnects with a fresh token and fetches history over REST.

### E-mail outbox (verification and password-reset mail)

Registration, `forgot-password` and `resend-verification` do not talk to SMTP. In ONE database transaction they create the one-time token and a row in `mail_outbox`; if anything fails, both are rolled back. A worker in every API instance (`MAIL_WORKER_ENABLED`, default `true`; polls every 5 s and is woken immediately after a request) sends the message. Consequences: a dead mail server cannot hold a request, a crash between "token created" and "mail sent" loses nothing, and the e-mail is rendered at send time, so the existing templates and `VERIFY_EMAIL_URL` / `RESET_PASSWORD_URL` apply to queued messages too. Only the newest link works, so a newer request cancels an older queued message (`CANCELLED`, `SUPERSEDED`).

| Status | Meaning |
|---|---|
| `PENDING` | waiting for `next_attempt_at` |
| `SENDING` | claimed by a worker under a 120 s lease |
| `SENT` | accepted by the mail server |
| `FAILED` | terminal: a refused recipient or message (SMTP 550-554), 6 failed attempts, a message that kept crashing its worker, or an undecryptable token |
| `CANCELLED` | terminal: superseded by a newer message, or the link had already expired |

- **Claiming.** `FOR UPDATE SKIP LOCKED`, one row at a time: workers never take the same row. A result is recorded only while the row is still the worker's own claim.
- **Crash recovery.** A row left in `SENDING` by a dead worker is claimed again when its lease expires. The attempt is counted at claim time, so a message that keeps killing the worker still ends as `FAILED`.
- **Retries.** Transient errors (timeouts, connection errors, SMTP 4xx, authentication problems that are our configuration) are retried after 30 s, 2 min, 10 min, 1 h, then 6 h (+-20 % jitter), 6 attempts in all. SMTP has connection, greeting, DNS and socket time limits plus a 45 s overall limit per send.
- **At-least-once, so duplicates are possible.** SMTP cannot give exactly-once delivery. If the mail server accepts a message and the worker dies (or the local time limit fires) before the result is recorded, the message is sent again. Every attempt for one row uses the same `Message-ID`, which lets mail systems and clients recognize a duplicate, but that is not guaranteed. For these two mails a duplicate is harmless: both links are the same token.
- **The token in the outbox, and its key.** The token table stores only a hash, so the outbox must not store the raw token in the clear: it is encrypted with AES-256-GCM (row id as associated data) and wiped (`NULL`, enforced by a CHECK constraint) as soon as the message is `SENT`, `FAILED` or `CANCELLED`. The key is a DEDICATED secret, `MAIL_OUTBOX_ENCRYPTION_KEY`: exactly 32 random bytes encoded as base64 (43 characters), used for nothing else and never derived from `JWT_ACCESS_SECRET`, so rotating the JWT signing secret does not affect queued mail. Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`. **It is required in production**: the API refuses to start if it is missing, is not exactly 32 bytes, is a development placeholder, or equals `JWT_ACCESS_SECRET`. Outside production an unset key means a fixed, public development key (never the JWT secret); a value that is set but malformed is refused in every environment. There is no fallback in production.
- **Rotating `MAIL_OUTBOX_ENCRYPTION_KEY`.** There is no key versioning: a message is readable only under the key it was queued with. After a rotation, messages still `PENDING` or `SENDING` cannot be decrypted; the worker ends them as `FAILED` (`DECRYPT_FAILED`, nothing is sent) and those users simply request a new link. Messages already `SENT` or finished are unaffected (they hold no secret). To rotate without losing anything: stop new mail from being queued (or accept the loss window), wait until no row is `PENDING` or `SENDING` (`SELECT count(*) FROM mail_outbox WHERE status IN ('PENDING','SENDING')` returns 0; a queued link is valid for at most 24 h), then switch the key on all instances. Rotating `JWT_ACCESS_SECRET` needs none of this.
- **Logs.** Worker logs carry the outbox id, kind, attempt and an error code: never an address, a token or a mail body. (In development without `SMTP_URL`, the message is printed so you can copy the link; that never happens in production.)
- **Retention.** Finished rows hold a recipient address: `SENT` rows are deleted after 7 days, `FAILED` and `CANCELLED` after 30.
- **`forgot-password` does not reveal accounts.** Same `202` answer for existing, unknown and suspended accounts; nothing is sent inside the request; every call takes at least 250 ms, which hides the small database work a real account needs; a failure while queueing is logged and not reported (an error that only real accounts could cause would reveal them), and the user can simply ask again. Per-IP and per-address rate limits apply to all cases alike. (`register` still answers `409` for an address that is taken; that is a separate, existing choice.)

**Deployment order.** Set `MAIL_OUTBOX_ENCRYPTION_KEY` on every instance first (production will not start without it), then run the migration (`migrate deploy` adds an empty table and two enums, nothing else changes), then start the new API. The old API keeps working on the new schema (it sends inline and ignores the table). The new API on an OLD schema fails every registration, so never deploy it before the migration. Tokens issued by the old version were already e-mailed inline, nothing needs converting.

**Rollback.** Roll the API back first (or together with the migration). Dropping the table (`DROP TABLE mail_outbox; DROP TYPE mail_status; DROP TYPE mail_kind;`) discards every message still queued; those users must request a new link, and tokens already created remain valid. If the API is rolled back but the table is kept, queued messages stay unsent until the new version runs again, and expire (they are cancelled, never sent, once their link has expired).

### E-mail links

Verification and password-reset e-mails contain a link. Set where it points with `VERIFY_EMAIL_URL` and `RESET_PASSWORD_URL`: a URL containing `{token}`, either a mobile deep link (`fym://verify-email?token={token}`) or a page of a web app. The app / page then calls `POST /auth/verify-email` or `POST /auth/reset-password` with the token. If unset, the link is `APP_URL/verify-email?token=...` (which only works once something serves that path).

### Dependency audit

`npm run audit:prod` (run in CI) fails on any HIGH or CRITICAL advisory in production dependencies unless it is listed with a reason and an expiry date in `backend/audit-allowlist.json`. Today the only exceptions are the Prisma CLI chain (`prisma`, `@prisma/config`, `deepmerge-ts`: not on the request path, fixed only by Prisma 7), valid until 2027-02-17.

## Matches API (`/api/v1/matches`, all need Bearer)

| Endpoint | Who | Purpose |
|---|---|---|
| `GET /` | any | search public open matches: cityId, from, to, format, skillLevel, position, maxPrice, minSpots, includeFull, suitableForMe, lat+lng+radiusKm (nearest first), page/pageSize |
| `GET /mine?role=organized\|playing\|requested&scope=upcoming\|past` | any | my matches |
| `POST /` | verified e-mail | create an OPEN match (capacity = players wanted via the app) |
| `GET /:id` | visible users | details, derived confirmedCount/availableSpots, myRelation, scheduleConflict warning |
| `PATCH /:id` | organizer/admin | edit; capacity never below confirmed; time only while nobody is confirmed |
| `POST /:id/cancel`, `POST /:id/complete` | organizer/admin | cancel (notifies, frees slots); confirm it took place |
| `POST /:id/requests` | verified + profile | ask to join (warns on an overlapping confirmed match) |
| `DELETE /:id/requests/me` | requester | withdraw |
| `GET /:id/requests`, `POST /:id/requests/:rid/accept` or `/reject` | organizer | manage pending requests |
| `GET /:id/participants`, `POST /:id/leave` | visible / participant | confirmed players; leave (under 12h = late cancellation) |
| `DELETE /:id/participants/:uid`, `PATCH /:id/participants/:uid/attendance` | organizer | remove; ATTENDED or NO_SHOW |
| `POST /:id/invitations` | organizer | invite a user (private matches are invite-only) |

A background job (every 60s, safe on several instances) moves matches to IN_PROGRESS at start time and to CLOSED_UNCONFIRMED 48h after the end if the organizer never confirmed. Disable with `JOBS_ENABLED=false`.

Note for Docker on Windows: file changes on the host do not always reach the container's watcher, so run `docker compose restart api` after editing source files.

## Venues and bookings API (all need Bearer)

| Endpoint | Who | Purpose |
|---|---|---|
| `POST /venues` | verified e-mail | register a venue (you become its owner); timezone defaults to Asia/Hebron |
| `GET /venues?q&cityId&format&lat&lng&radiusKm` | any | search active venues (nearest first with lat+lng) |
| `GET /venues/mine`, `GET /venues/:id`, `PATCH /venues/:id` | any / staff | my venues; details with fields + weekly hours; edit (EDIT_VENUE) |
| `POST /venues/:id/fields`, `PATCH /fields/:fieldId` | MANAGE_FIELDS | add a field (format, price/hour, slotMinutes); change price or deactivate |
| `PUT /fields/:fieldId/opening-hours` | MANAGE_AVAILABILITY | replace weekly hours (local HH:mm, several ranges per day) |
| `GET /fields/:fieldId/availability?date=YYYY-MM-DD` | any | bookable slots in the venue's local time (minus blocks, holds, bookings) |
| `POST /fields/:fieldId/blocks`, `GET /fields/:fieldId/blocks`, `DELETE /blocks/:id` | MANAGE_AVAILABILITY | block time (maintenance, phone customers); `allFields: true` blocks the whole venue |
| `GET/POST /venues/:id/staff`, `DELETE /venues/:id/staff/:userId` | MANAGE_STAFF | per-venue staff and permissions |
| `POST/DELETE /venues/:id/images` | EDIT_VENUE | https image URLs (upload comes later) |

Staff management cannot be used to escalate: nobody edits their own access, you can only grant permissions you hold yourself (a role's default permissions count as grants), only the owner (or an admin) grants `MANAGE_STAFF`, and staff who hold `MANAGE_STAFF` cannot be changed or removed by anyone but the owner. Anyone can remove themselves.
| `POST /bookings` | verified e-mail | request a slot (PENDING, held 2h); price is snapshotted |
| `POST /bookings/external` | verified e-mail | record a booking made outside the app (self-reported, never blocks a registered field) |
| `GET /bookings/mine`, `GET /bookings/:id` | requester / venue staff | my bookings; details |
| `POST /bookings/:id/cancel` | requester, or staff for CONFIRMED | cancel; frees the slot, notifies the other side and linked matches |
| `GET /venues/:id/bookings`, `POST /bookings/:id/confirm`, `/reject` | MANAGE_BOOKINGS | venue inbox; answer requests (not your own) |

Matches accept `bookingId` (your CONFIRMED booking) on create/edit; `POST /matches/:id/cancel` takes `releaseBooking: true` to also free the slot. A match whose booking was cancelled stays open and shows `venueConfirmed: false`.

## Teams and challenges API (all need Bearer)

| Endpoint | Who | Purpose |
|---|---|---|
| `POST /teams` | verified e-mail | create a team (you become captain) |
| `GET /teams?q&cityId`, `GET /teams/mine`, `GET /teams/:id` | any | search, my teams, details with members |
| `PATCH /teams/:id` | captain / vice | name, description, logo (https), city |
| `POST /teams/:id/invitations`, `GET /teams/:id/invitations` | captain / vice | invite a player (valid 7 days, max 30 players); list pending |
| `GET /teams/invitations/mine`, `POST /teams/invitations/:id/accept` / `decline` | invitee | answer an invitation |
| `POST /teams/invitations/:id/cancel` | captain / vice | withdraw an invitation |
| `POST /teams/:id/leave`, `DELETE /teams/:id/members/:userId` | member / staff | leave or remove (the captain cannot be removed or leave) |
| `PATCH /teams/:id/members/:userId` `{role}`, `POST /teams/:id/transfer-captaincy` | captain | VICE_CAPTAIN or MEMBER; hand over the captaincy (old captain becomes vice) |
| `POST /teams/:id/challenges`, `GET /teams/:id/challenges?direction=incoming\|outgoing` | captain / vice; members read | challenge another team (format, `proposedStartAt`); offer lapses after 7 days or before kick-off; both teams need at least the format size in players |
| `POST /challenges/:id/accept` / `reject` | challenged team's staff | accept creates ONE TEAM_CHALLENGE match (SCHEDULED, 90 min) with sides HOME = challenger, AWAY = challenged; the challenger's captain is the organizer |
| `POST /challenges/:id/cancel` | challenger's staff | withdraw a pending challenge |
| `GET/POST /teams/:id/matches/:matchId/roster`, `DELETE .../roster/:userId` | team staff (GET: members) | pick players from your own team; capped at the format size; a player cannot be confirmed in two overlapping matches |

A team match has no join requests or capacity. `GET /matches/:id` shows `sides` with roster counts; `/participants` shows each player's `side` and `teamId`. Cancelling is done by the organizer through `POST /matches/:id/cancel`. Leaving a team drops the player from that team's upcoming rosters.

## Notifications API (all need Bearer)

| Endpoint | Purpose |
|---|---|
| `GET /notifications?unread=true&page&pageSize` | my notifications (`type`, `params` data to render in my language, `resource`, `read`) plus `unreadCount` |
| `GET /notifications/unread-count` | badge number |
| `POST /notifications/:id/read`, `POST /notifications/read-all` | mark read (idempotent) |
| `POST /notifications/devices` `{token, platform}`, `DELETE /notifications/devices/:token` | register / remove a push token (delivery is not wired yet) |

## Reviews API (all need Bearer)

| Endpoint | Purpose |
|---|---|
| `POST /matches/:id/reviews` | verified e-mail; `{reviewedId, sportsmanshipScore, skillScore, reliabilityScore (1-5), comment?}`; both must have ATTENDED a COMPLETED match, within 7 days, once per pair, not with blocked users |
| `GET /matches/:id/reviews/pending` | players I can still review, and when the window closes |
| `GET /players/:userId/reviews?page` | reviews a player received, with category averages |

The player profile shows `rating` (average of the three scores, count) and `reliabilityScore` (0-100, derived from attendance only: attended / (attended + 2 x no-shows + late cancellations)).

## Blocking and reports API (all need Bearer)

| Endpoint | Purpose |
|---|---|
| `GET/POST /users/me/blocks` `{userId}`, `DELETE /users/me/blocks/:userId` | block / list / unblock (idempotent). The two users no longer see each other's profiles or matches, cannot request, invite or review each other; pending join requests between them are dropped. The blocked user is never told |
| `POST /reports` | `{targetType: USER|MATCH|VENUE|TEAM, targetId, reason: SPAM|HARASSMENT|FAKE_PROFILE|NO_SHOW|INAPPROPRIATE_CONTENT|SAFETY|OTHER, details?}`; one open report per target; 20 per day |
| `GET /reports/mine` | my reports and their status |
| `GET /admin/reports?status&targetType`, `PATCH /admin/reports/:id` `{status}` | admin only: work the queue (OPEN > IN_REVIEW > RESOLVED or DISMISSED); the reporter is notified when it closes |

## Chat API (all need Bearer)

| Endpoint | Purpose |
|---|---|
| `GET /chats?limit&before=<messageId>` | my inbox, newest activity first: last message and unread count per chat, plus `totalUnread` over ALL chats; `limit` 1-50 (default 30); pass `nextBefore` as `before` for the next page (null at the end) |
| `POST /chats/match/:matchId`, `POST /chats/team/:teamId`, `POST /chats/direct` `{userId}` | open (get-or-create) a conversation and get its id; non-members get 404. Match chat = organizer + confirmed players; team chat = members; a DM needs a shared match or team and a verified e-mail |
| `GET /chats/:id/messages?limit&before=<messageId>` | history, newest first; `nextBefore` pages back; messages from blocked users are hidden; `canWrite` |
| `POST /chats/:id/messages` `{body}` | send (1-2000 chars, 20 per minute); a match chat is read-only after cancel or 7 days after the end |
| `POST /chats/:id/read` | mark read |

Realtime: connect Socket.IO to the API origin with `auth: { token: <accessToken> }`; members receive `message:new` `{id, conversationId, conversationType, senderId, body, createdAt}`. It is best-effort; REST is the source of truth, so after a reconnect fetch history. Messages can be reported (`targetType: MESSAGE`).

## Admin API (platformRole ADMIN only)

| Endpoint | Purpose |
|---|---|
| `GET /admin/users?q&status&page`, `GET /admin/users/:id` | find users; counters (matches, no-shows, reports against, venues) |
| `POST /admin/users/:id/suspend` / `reactivate` | suspension is immediate (token stops working, sessions revoked, login refused); cannot suspend yourself or another admin |
| `GET /admin/venues?q&status`, `POST /admin/venues/:id/suspend` / `reactivate` | a suspended venue leaves search and takes no new bookings; existing bookings are untouched; the owner is notified |
| `GET /admin/stats` | counters |
| `GET /admin/audit-log` | read the audit log (filters below) |
| `GET/PATCH /admin/reports` | moderation queue (see Blocking and reports) |

**Audit log.** Every state-changing admin action writes one row to `admin_audit_log` in the SAME transaction as the action, so the two commit or roll back together: user suspend / reactivate, venue suspend / reactivate, every report status change, and admin overrides on matches (cancelling someone else's match, completing it, recovering a CLOSED_UNCONFIRMED one after the organizer's 7-day window, and editing it; an admin acting on their OWN match is an ordinary organizer action and is not logged). An admin edit records WHICH fields changed (`changedFields`); title, description, notes, place name, coordinates, booking and required positions are named only, while capacity, skill level, price, city and time carry before / after values. An edit that changes nothing leaves no record. A row holds the actor, action, target type and id, an optional `reason` (max 500 characters), a small `metadata` object (`fromStatus` / `toStatus`, plus `organizerId` for matches), the request id of the call and the time. A repeated suspension that changes nothing writes no row.

`GET /admin/audit-log?actorId&action&targetType&targetId&from&to&page&pageSize` (admin only, newest first, `pageSize` max 100; `from` inclusive, `to` exclusive, ISO date-times) returns those fields only, with ids rather than names or e-mails. There is no create, update or delete endpoint.

The table is append-only: database triggers refuse UPDATE, DELETE and TRUNCATE (truncating `"user"` is refused too, because it would empty this table). Targets have no foreign key, so a record outlives any later anonymization; the actor keeps a restricting foreign key (accounts are anonymized, never hard-deleted).

**Reasons must not contain personal data, passwords, tokens or secrets.** The reason is free text typed by the admin and the log can never be edited, so anything written there stays. Say what happened ("fake venue", "repeated harassment"), not who or how to reach them.

**Known gaps, not audited yet (separate follow-up).** Admins can also, through the normal organizer routes, act on matches they do not organize without leaving a record. Planned priority, because they change participation history and reliability: (1) attendance / no-show marking, (2) accepting or rejecting join requests, (3) removing a participant; then private invitations and the booking released by a cancel with `releaseBooking`. Venue management by admins (venue edits, fields, hours, blocks, staff, booking approvals and cancellations; admins hold every venue permission) is to be considered separately. Admins cannot change team rosters at all.

**Known limitation.** A database superuser can still disable or drop the triggers, or the table, and the API currently connects as a superuser. Separate runtime and migration roles (Phase 3, finding OPS-08) will close this. Until then the log is protected against application code and ordinary roles, not against someone with full database privileges. Rollback of the migration drops the table and all records (see the comments in `20261117000400_admin_audit_log`).

Make the first admin by hand: `UPDATE "user" SET platform_role = 'ADMIN' WHERE email = 'you@example.com';`

## Tests

```bash
cd backend && npm test      # needs the db running; uses a separate `fym_test` database (created automatically)
```
