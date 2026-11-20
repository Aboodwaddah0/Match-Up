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

`npm run audit:prod` (run in CI) fails on any HIGH or CRITICAL advisory in production dependencies unless it is listed with a reason and an expiry date in `backend/audit-allowlist.json`. Today the only exceptions are the Prisma CLI chain (`prisma`, `@prisma/config`, `deepmerge-ts`, `effect`: not on the request path, fixed only by Prisma 7), valid until 2027-02-17.

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
| `POST /notifications/devices` `{token, platform: ios|android}`, `DELETE /notifications/devices/:token` | register / remove an Expo push token (see Push notifications); web push tokens are refused |

## Push notifications (Expo)

Every notification stays in the in-app center. Some also become a push to the user's devices, delivered through the Expo Push Service by a background worker (`PUSH_WORKER_ENABLED`, default `true`, safe on several instances). Business code is unchanged: `notify()` still only writes the notification row.

**Which types push (11).** `MATCH_REQUEST_RECEIVED`, `MATCH_REQUEST_ACCEPTED`, `MATCH_REQUEST_REJECTED`, `MATCH_CANCELLED`, `MATCH_TIME_CHANGED`, `MATCH_INVITATION`, `BOOKING_CONFIRMED`, `BOOKING_REJECTED`, `TEAM_INVITATION`, `CHALLENGE_RECEIVED`, `CHALLENGE_ACCEPTED`. The other 20 types (including `REVIEW_RECEIVED` and `REPORT_RESOLVED`) never push; chat is not a notification and has its own realtime channel. The policy is `PUSH_POLICY` in `src/modules/notifications/push-policy.ts`: the compiler and a test refuse a type that is not classified, and a value that is not in the table is not pushed. Recipients are exactly the recipients of the notification rows (challenges: the captain and vice captains of the challenged / challenging team; time changes: confirmed participants and pending requesters). One push per notification per registered device, no throttling or quiet hours. Texts are Arabic or English by the user's locale and never include free text typed by users (cancel reasons, booking notes).

**Mobile contract (the app, not the backend, talks to Expo to get a token).**
1. Ask the user's permission for notifications.
2. Call `Notifications.getExpoPushTokenAsync({ projectId })`, where `projectId` is the Expo project id from the app config (`extra.eas.projectId`, as in Expo's setup guide). The backend has no setting for it and cannot check which project a token came from.
3. `POST /notifications/devices` with `{ token, platform }` on every app start and login (the token can change, for example after a reinstall on Android), and `DELETE /notifications/devices/:token` on logout.
The backend only checks that the token LOOKS like an Expo token (`ExponentPushToken[...]` / `ExpoPushToken[...]`) and the platform is `ios` or `android`. That filters junk; it does not replace the registration with Expo. `device_token` holds push tokens only; sessions are refresh tokens, so refusing web push tokens does not touch web login.

**How a push is delivered.** A pass of the worker (every 5 s) does four things: (1) *fan-out*: one statement turns notifications that have not been fanned out into one `PENDING` `push_delivery` per device of an ACTIVE user, marks them done, and can be repeated or interrupted safely (`UNIQUE (notification, device)`); (2) *send*: claims deliveries under a 120 s lease and sends them in batches of up to 100; (3) *receipts*: asks Expo what happened; (4) housekeeping. A delivery goes `PENDING` → `SENDING` → `ACCEPTED` (Expo returned a **ticket**; this does not mean the user got it) → `DELIVERED` (the **receipt** says ok). Other end states: `FAILED` (permanent error or attempts used up), `CANCELLED` (device removed or reassigned, user suspended, notification older than 24 h), `UNCONFIRMED` (accepted, but no receipt ever appeared: neither delivered nor failed).

| Situation | What happens |
|---|---|
| Transient error (timeout, network, HTTP 5xx, unusable answer) | the batch goes back to `PENDING` with backoff 10 s, 1 min, 5 min, 30 min, 1 h, 3 h, 6 h (±20 %), 8 attempts, then `FAILED` |
| Ticket / receipt `DeviceNotRegistered` | `FAILED`, the device token is deleted (only if it is still that token), the device's other waiting pushes are cancelled |
| `MessageTooBig`, unknown receipt error | `FAILED` with the code |
| Receipt `MessageRateExceeded` | the ONE case that sends again: the provider refused it, so the ticket is cleared and the push is requeued |
| `MismatchSenderId`, `InvalidCredentials`, `InvalidProviderToken` | `FAILED` (visible, error-logged); requeue after fixing the credentials (below) |
| Receipt not available | asked again 15 min after the ticket (Expo's recommendation), then 45 min, 1 h 45, 3 h 45, 7 h 45, 15 h 45, 23 h; receipts are cleared by Expo after 24 h, so after that `UNCONFIRMED` |
| Notification older than 24 h when it would go out | `CANCELLED` (`STALE`); the push `ttl` is also 24 h |

**Authentication failures (Enhanced Push Security).** The API cannot tell whether Enhanced Push Security is on in your Expo account, so `EXPO_ENHANCED_SECURITY` says so; with `true`, production refuses to start without `EXPO_ACCESS_TOKEN`. The token is sent only as `Authorization: Bearer ...` and never logged. If Expo answers `UNAUTHORIZED` (or HTTP 401/403; Expo's documentation names the error code but not the HTTP status), the SEND and RECEIPT channels are handled separately and shared by all instances in `push_provider_state`:
- **Sending:** the batch returns to `PENDING` WITHOUT consuming attempts, the channel pauses (5, 15, 30, then 60 minutes), one error is logged per pause, and notifications keep fanning out into pending deliveries. When the pause ends, ONE instance sends ONE pending delivery as a probe; success resumes everything, failure lengthens the pause. If the outage lasts longer than 24 hours, the oldest pushes are cancelled as stale (logged and counted); the in-app notifications are never affected.
- **Receipts:** the deliveries stay `ACCEPTED`, only the next receipt check is postponed, nothing is consumed, and the probe is a read-only `getReceipts` request for one ticket. An accepted push is never sent again because receipts could not be read (a database constraint also forbids moving an `ACCEPTED` push back to `PENDING` without clearing its ticket).
- Fix the credentials and nothing else: the next probe finds them working and the work resumes from where it stopped.

**Send rate.** Expo allows 600 notifications per second per project. All instances share a token bucket in PostgreSQL (`push_rate_bucket`, database clock, no extra service): at most 300 messages per second combined, burst 300. If Expo answers "too many requests" the bucket is blocked for 15 s for every instance.

**Duplicates are possible.** Expo has no idempotency key: if Expo accepts a push and the worker dies before the ticket is saved, the push is sent again. `collapseId` and `tag` (both the notification id) let the device merge such copies; this reduces duplicates but is not a guarantee.

**Retention.** Finished deliveries are deleted after 14 days (`DELIVERED`, `CANCELLED`) or 30 days (`FAILED`, `UNCONFIRMED`). `PENDING` (also retrying), `SENDING` and `ACCEPTED` deliveries are never deleted. In-app notifications have no retention yet (audit finding OPS-06); when that is added it must delete finished deliveries first (the foreign key forbids deleting a notification that still has deliveries).

**Operations.**
```sql
-- is a channel paused? (SEND / RECEIPT)
SELECT channel, status, paused_until, consecutive_failures, last_error_code, last_error_at FROM push_provider_state;
-- what is the queue doing?
SELECT status, last_error, count(*), min(created_at) FROM push_delivery GROUP BY 1, 2 ORDER BY 1, 2;
```
```sql
-- requeue-credential-failures: after fixing FCM / APNs credentials in Expo, requeue pushes that failed with a credential
-- error, only while the notification is younger than 24 hours (older ones would be cancelled as stale anyway)
UPDATE push_delivery p
   SET status = 'PENDING', attempts = 0, next_attempt_at = now(), finished_at = NULL, last_error = NULL,
       ticket_id = NULL, ticket_at = NULL, next_receipt_at = NULL, receipt_attempts = 0, expo_token = dt.token
  FROM device_token dt, notification n
 WHERE p.status = 'FAILED' AND p.last_error IN ('MismatchSenderId', 'InvalidCredentials', 'InvalidProviderToken')
   AND dt.id = p.device_token_id AND n.id = p.notification_id AND n.created_at > now() - interval '24 hours';
```

**Deployment order.** Run the migration, then deploy the API: the old API ignores the new tables and the new column. The migration marks every existing notification as fanned out, so deploying never pushes old events. To roll back, roll the API back first; dropping the new tables discards pending pushes only (in-app notifications are unaffected).

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
| `POST /reports` | `{targetType: USER|MATCH|VENUE|TEAM|MESSAGE|MEDIA, targetId, reason: SPAM|HARASSMENT|FAKE_PROFILE|NO_SHOW|INAPPROPRIATE_CONTENT|SAFETY|OTHER, details?}`; one open report per target; 20 per day |
| `GET /reports/mine` | my reports and their status |
| `GET /admin/reports?status&targetType`, `PATCH /admin/reports/:id` `{status}` | admin only: work the queue (OPEN > IN_REVIEW > RESOLVED or DISMISSED); the reporter is notified when it closes |

## Media API (photos and videos of players and teams, all need Bearer)

Files live at **Cloudinary**; PostgreSQL keeps only the reference (`provider` + `storage_key`, so S3 can be added later) and the metadata the server **verified**. The API never receives the binary: the app uploads straight to Cloudinary with parameters the API signed.

| Endpoint | Purpose |
|---|---|
| `POST /media/uploads` | `{owner: {type: PLAYER} \| {type: TEAM, teamId}, mimeType, sizeBytes, caption?}` (verified e-mail, 30 per hour). Creates a PENDING slot with a server-chosen key (`<folder>/media/<id>`) and returns `{media, upload: {url, method, fields, expiresAt}}`: POST `fields` + the `file` as multipart to `url`. 400 `MEDIA_TOO_LARGE`, 409 `MEDIA_LIMIT_REACHED`, 403 (not team staff), 503 `MEDIA_NOT_CONFIGURED` |
| `POST /media/:id/confirm` | after the upload: the server asks Cloudinary about THAT key and publishes the item (READY) with the provider's size, type, dimensions and duration. Only the uploader may confirm. 422 `MEDIA_REJECTED` (`details.reason`), 503 `MEDIA_PROVIDER_UNAVAILABLE` (nothing changed, retry) |
| `PATCH /media/:id` | `{caption?, sortOrder?}` (READY items; `caption: null` removes it) |
| `DELETE /media/:id` | removes it from view at once; the file is deleted by the worker |
| `GET /players/:userId/media`, `GET /teams/:teamId/media` | READY items in display order (`canManage` for teams). Players: 404 when blocked or not ACTIVE |
| `POST /admin/media/:id/remove` | admin only, `{reason?}`; audited as `MEDIA_REMOVED_BY_ADMIN` (409 when already being removed) |
| `POST /reports` with `targetType: MEDIA` | report a READY item you can see; moderation = reports + admin removal (no approval before publishing) |

**Rules.** Photos JPEG, PNG, WebP, HEIC (max 10 MB); videos MP4, QuickTime/MOV (max 100 MB and 60 s). Caption up to 300 characters. 30 items per player, 50 per team (database trigger, race-safe). Player media: its owner only. Team media: captain and vice captain (any item of the team); members read only. Team staff is re-checked when a confirmation or a deletion commits. HEIC keeps its original type in the row; the delivery URL uses `f_auto` so phones and browsers receive JPEG / WebP / AVIF (a transformed delivery also drops most embedded metadata, location included). Videos are delivered as H.264 MP4 with a JPEG poster thumbnail. Delivery URLs are **public** (anyone who has one can open it, including a blocked user, until the file is deleted); the API only hides items from lists.

**Lifecycle.** `PENDING -> READY -> DELETING -> row deleted`. A rejected confirmation, a user delete, an admin removal, an account deletion (the player's own media; team media stays, its uploader shows as "Deleted user") or a slot never confirmed within 2 hours all lead to `DELETING`. The media worker (`MEDIA_WORKER_ENABLED`, every instance) deletes the file at Cloudinary under **every** resource type (image, video, raw; "not found" counts as deleted) and only then the row, with exponential backoff (1 min up to 12 h, never abandoned). `GET /admin/stats` reports `mediaDeletionStuck` (hidden for more than 24 h but not yet deleted); failures are logged (ERROR from the 3rd attempt).

**Why every resource type.** The upload signature covers the key, the allowed formats, `overwrite=false` and `type=upload`, but **not the resource type** (it is part of the URL) and **not size or duration**. A client can therefore upload to another resource type, and a `raw` upload is stored as `<key>.<extension>`. Confirmation looks only under the expected type (anything else is "not found" and the slot is rejected), verifies size, format and duration itself, and the worker sweeps all three namespaces (raw by prefix). **Upload window (verified against the live service).** A signature is accepted while its timestamp is at most about 3,600 s old and refused after that ("Stale request"). The timestamp is checked when the request has been **received in full**, not when it starts: an upload that began 20 s before the expiry and took 153 s was refused and created no asset. So a slow or interrupted upload cannot complete after the window; only a request whose body had fully arrived before the expiry can still be creating its asset afterwards, i.e. only the provider's own processing time can reach past it (not published). Nothing stronger is claimed: that is why the last sweep is a day out, not 70 minutes.

**Stray cleanup after a successful confirmation.** Every READY item has three idempotent sweeps scheduled by its confirmation (`stray_sweeps_left`): one due at once, one when the upload window has closed (70 minutes after the slot was created: the signature lifetime plus 10 minutes of grace), and a last one 24 hours after it, as insurance against a request that was still being processed when the window closed. A sweep deletes the object under every resource type **except the verified canonical one** (a photo is swept under video and raw, a video under image and raw; the raw sweep matches `<key>` and `<key>.*` only, and a key carries the row's own UUID, so no other row's file can match). A failure never touches the READY item: the sweep keeps its step and is retried with backoff (1 min up to 12 h, never abandoned; bad credentials wait 30 min), and whatever is left when the item is deleted is removed by the deletion path. Cost per item: three upload-API deletes and three Admin-API raw listings over its lifetime (plus the one Admin-API lookup of the confirmation); a worker pass runs at most 10 sweeps and stops at the first rate-limit / network / credential failure, so an outage costs one request per pass.

**A deleted row is kept until the window has closed.** The signature that created a slot stays valid after the slot is deleted (or after a failed confirmation), so a client could still upload and create an asset with no row, which nothing would ever clean up. The worker therefore removes the files at once but keeps the hidden row (`DELETING`) until 70 minutes after its slot was created, sweeps the provider once more, and only then deletes the row. Rows older than that are deleted immediately.

**Existing items.** The media feature has never been deployed: no commit, release or deployed database contains the media tables (the development database has no `media_item` table, and the real Cloudinary account holds no assets under the media folder), so on a fresh deployment there are no READY items and no outstanding signatures when `20261125000100_media_stray_sweep` runs. As a safety net the migration backfills any database that already applied `20261124000200_media_items`: READY items get 3 / 2 / 1 sweeps by age (younger than 70 min / younger than 24 h / older), due at once, so each needs only the sweeps it still lacks and the worker handles at most 10 per pass. Signatures issued before the migration expire within the hour; a stray created by one of them in that hour is removed by the deletion path when the item is deleted.

**Daily reconciliation (`jobs/media-reconcile.ts`).** The per-item sweeps end 24 hours after a slot was created, and nobody can prove the provider never finishes processing an upload later than that, so a job walks the provider's own listing of `<folder>/media/` (Admin API, 500 assets per page, **image, video and raw each with their own cursor and cycle**) and removes what should not be there. Per listed asset (the id is the UUID of the key; a raw file is `<key>.<ext>`):

| Asset | Action |
|---|---|
| its id is not exactly `<folder>/media/<uuid>` (an extension only in the raw namespace), or its row has another provider / another stored key | **ignored** (counted as foreign) |
| created by the **provider** less than `MEDIA_RECONCILE_GRACE_HOURS` (24) ago | **kept** (too young to judge) |
| the verified canonical file of a READY item (photo = `image`, video = `video`, the exact key) | **never deleted** |
| its row is PENDING (an upload in flight) or DELETING (the deletion worker owns it) | **left alone** |
| its row is READY and the asset is anything else (another resource type, a raw `<key>.<ext>`) | deleted (a stray) |
| there is no row | deleted (an orphan: a row always exists before a signature for its key does) |

Immediately before each delete the row is read again and the decision repeated; anything that changed is skipped. Deletes use the upload API's destroy by exact public id (not an Admin API call) and are idempotent.

*Cursors and cycles.* A page is validated as a whole before anything is done with it (one unreadable entry rejects the page), and its cursor is saved only after **every** action on it is finished: a failure (provider, database, lost lease) leaves the saved cursor where it was, the page is fetched again and nothing is skipped; deletions already done are not undone and are idempotent on the retry. A cycle is complete only when the last page of a namespace (no next cursor) was processed without a failure; the next cycle starts one interval (`MEDIA_RECONCILE_INTERVAL_HOURS`, 24) after this one **started**, or at once if the cycle took longer. An asset that appears behind the cursor while a cycle runs is found by the next cycle. Progress (`media_reconcile`, one row per namespace: cursor, cycle start, counters, lease) survives restarts; one runner per namespace under a lease, every write conditional on its claim. If the provider ever refuses a saved cursor the walk restarts from the first page (the cycle start is kept, so the reported age keeps growing). A single asset that cannot be deleted holds its namespace at that page, **visibly** (stats and ERROR logs from the 3rd attempt); it is never skipped silently.

*Cost.* A run fetches at most `MEDIA_RECONCILE_MAX_PAGES` pages (25, all namespaces together, round-robin so a huge namespace cannot starve the others) and deletes at most 100 assets; a run that stops with work left pauses 30 minutes, so a running cycle uses at most 25 Admin API calls per 30 minutes and an idle system none. With fewer than 500 assets per namespace a cycle is **3 Admin API calls a day** (plus one delete call per stray, upload API). The Admin API allows 500 calls per hour on this plan and reports how many are left; below 100 the run stops and waits for the reset, so confirmations and sweeps are never starved.

*What is and is not guaranteed.* There is **no fixed maximum**; the bound is a formula. With `R = ceil((pages of image + video + raw) / MAX_PAGES)` runs per cycle and a cycle duration `D = (R - 1) x 30 min` (+ run time), a stray that exists is deleted by the first cycle that reaches it once it is older than the grace period; a cycle starts within one interval of the previous start, so the worst case is about **grace + interval + D** after the asset was created (24 h + 24 h + D; D is minutes while the whole folder fits in 25 pages, i.e. up to 12,500 files). It holds only while the provider and the database are reachable: during an outage nothing is deleted and the run retries with backoff (1 min up to 12 h; bad credentials 30 min), the listing may lag (the next cycle catches it), and a namespace with an undeletable asset is held at that page. The canonical file of a READY item is never touched. The assumption behind the "created by the provider" age is the provider's own `created_at` (second precision, UTC).

*Monitoring.* `GET /admin/stats` carries `mediaReconcile`: `oldestUnprocessedSeconds` (the age of the oldest running cycle, or how overdue an idle namespace is), `stuck` (namespaces with 3 or more consecutive failed runs) and, per namespace, `running`, `cycleAgeSeconds`, `overdueSeconds`, `pages`, `scanned`, `deleted`, `attempts`, `lastError`, `lastCompletedAt`, `nextRunAt`.

*Verified against the live service:* the listing is ordered by public id and its cursor is a position in that order (deleting listed assets shifts nothing; a cursor was still valid 20 s later; an unknown cursor is refused with HTTP 400 `Invalid next_cursor`); entries carry `created_at`; the Admin API reports `x-featureratelimit-remaining` (limit 500 per hour); a raw file is deleted by its exact id `<key>.<ext>` through the upload API and a second delete answers "not found". *Not verified:* how long a cursor stays valid (hours or days); that is why a refused cursor restarts the walk instead of failing.

**Configuration (production refuses to start without it).** `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`; optional `CLOUDINARY_FOLDER` (default `fym`), `MEDIA_WORKER_ENABLED` (default `true`), `MEDIA_RECONCILE_ENABLED` (default `true`), `MEDIA_RECONCILE_INTERVAL_HOURS` (24), `MEDIA_RECONCILE_GRACE_HOURS` (24, at least 2), `MEDIA_RECONCILE_MAX_PAGES` (25), `CLOUDINARY_API_BASE_URL` / `CLOUDINARY_DELIVERY_BASE_URL` (https in production). Without credentials the endpoints answer 503 `MEDIA_NOT_CONFIGURED`.

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

**Audit log.** Every state-changing admin action writes one row to `admin_audit_log` in the SAME transaction as the action, so the two commit or roll back together: user suspend / reactivate, venue suspend / reactivate, every report status change, and admin overrides on matches (cancelling someone else's match, completing it, recovering a CLOSED_UNCONFIRMED one after the organizer's 7-day window, and editing it) and on match PARTICIPATION (accepting or rejecting a join request, removing a participant, marking a player attended or no-show, sending a private invitation); an admin acting on their OWN match is an ordinary organizer action and is not logged. An admin edit records WHICH fields changed (`changedFields`); title, description, notes, place name, coordinates, booking and required positions are named only, while capacity, skill level, price, city and time carry before / after values. An edit that changes nothing leaves no record. A participation record is recorded only when the state really changes (a repeated decision, the same attendance status by the same confirmer, or an invitation that is already pending from the same inviter leaves no row; an admin re-confirming the same attendance status replaces the confirmer, which is recorded), and its metadata is `fromStatus` / `toStatus`, `organizerId` and the affected player's id as `subjectUserId` (plus the join request id for request decisions). An admin cancellation that released the match's booking names it as `bookingId`. A row holds the actor, action, target type and id, an optional `reason` (max 500 characters), a small `metadata` object (`fromStatus` / `toStatus`, plus `organizerId` for matches), the request id of the call and the time. A repeated suspension that changes nothing writes no row.

`GET /admin/audit-log?actorId&action&targetType&targetId&from&to&page&pageSize` (admin only, newest first, `pageSize` max 100; `from` inclusive, `to` exclusive, ISO date-times) returns those fields only, with ids rather than names or e-mails. There is no create, update or delete endpoint.

The table is append-only: database triggers refuse UPDATE, DELETE and TRUNCATE (truncating `"user"` is refused too, because it would empty this table). Targets have no foreign key, so a record outlives any later anonymization; the actor keeps a restricting foreign key (accounts are anonymized, never hard-deleted).

**Reasons must not contain personal data, passwords, tokens or secrets.** The reason is free text typed by the admin and the log can never be edited, so anything written there stays. Say what happened ("fake venue", "repeated harassment"), not who or how to reach them.

**Known gap, not audited yet (separate follow-up).** Venue management by admins (venue edits, fields, hours, blocks, staff, booking approvals and cancellations; admins hold every venue permission). Admins cannot change team rosters at all.

**Known limitation.** A database superuser can still disable or drop the triggers, or the table, and the API currently connects as a superuser. Separate runtime and migration roles (Phase 3, finding OPS-08) will close this. Until then the log is protected against application code and ordinary roles, not against someone with full database privileges. Rollback of the migration drops the table and all records (see the comments in `20261117000400_admin_audit_log`).

Make the first admin by hand: `UPDATE "user" SET platform_role = 'ADMIN' WHERE email = 'you@example.com';`

## Error tracking (Sentry)

Unexpected errors can be reported to Sentry (D20 / OBS-01). It is **off by default**: with `SENTRY_DSN` empty or unset the SDK is never initialised, nothing is patched and nothing leaves the process. The API starts and behaves identically with or without it.

**Set it up (one Sentry project for the API).**
1. In Sentry create a project, platform **Node.js** (Express is covered by it). One project for all environments.
2. Copy its DSN: *Settings > Projects > (project) > Client Keys (DSN)*.
3. Put it in `SENTRY_DSN` (root `.env` for Docker Compose, `backend/.env` without Docker, or the hosting provider's secret store). Never commit it. Restart the API; the start-up log says `Sentry error tracking is on` (the DSN is never logged). To switch it off again, empty `SENTRY_DSN` and restart.
4. After adding the dependency to an existing Docker setup, rebuild the image once: `docker compose up -d --build api`.

**Environment names.** `development`, `staging` or `production`. `SENTRY_ENVIRONMENT` sets it; when unset it is `production` if `NODE_ENV=production`, otherwise `development`. `NODE_ENV` keeps its three values: a staging deployment runs `NODE_ENV=production` with `SENTRY_ENVIRONMENT=staging`. Any other value stops the API at start-up.

**What is reported.** Only errors the API did not expect (the 500 `INTERNAL_ERROR` branch of `middleware/error-handler.ts`, one call to `captureUnexpected`, so an error is never reported twice) and process-level crashes (uncaught exception, unhandled rejection; the last events are flushed before the process exits). Errors the API chose to return are never reported: `AppError` (even a deliberate 5xx such as 503 `MEDIA_PROVIDER_UNAVAILABLE`), validation errors, malformed requests, mapped database errors. Errors are never sampled (100%). The SDK's own Express capture is switched off because it fires before our handler and would report `ZodError` too. Each event carries the `request_id` tag so it can be matched to the log line. Failures inside background jobs are logged but not reported (a later step).

**Tracing.** `tracesSampleRate: 0.1` (10% of requests), constant in `src/lib/sentry.ts`.

**Privacy (nothing below ever reaches Sentry).** Passwords and hashes, access / refresh tokens and JWTs, Authorization, Cookie and Set-Cookie headers, request bodies, query strings, the Cloudinary secret and upload signatures, connection strings, other keys, e-mail addresses, user ids and IP addresses. Three layers: (1) the SDK is configured to collect no request data (`dataCollection`: no headers, cookies, bodies, query strings or user info; `includeLocalVariables: false`; the old `sendDefaultPii` option no longer exists in SDK 11); (2) `beforeSend` removes the request block (only method and path stay), the user and `extra`, redacts sensitive key names and token-, JWT-, e-mail- and connection-string-like text in messages, tags, contexts and breadcrumbs, and leaves the stack frames readable; (3) breadcrumbs drop console output and URL queries, spans drop queries, headers, bodies, client addresses and SQL text. `tests/sentry.test.ts` asserts on the envelopes the SDK would send (fake transport, no network). Kept on purpose: the stack trace with a few lines of source around each frame, the host name, OS and Node version. The text of an error message is sent after redaction, so do not put personal data in messages on purpose.

**Setting list.** `SENTRY_DSN` (empty = off), `SENTRY_ENVIRONMENT` (optional).

## Tests

```bash
cd backend && npm test      # needs the db running; uses a separate `fym_test` database (created automatically)
```
