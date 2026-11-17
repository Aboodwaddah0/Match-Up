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
  prisma/                 schema, migrations, DB tests
  src/
    config/env.ts         validated environment (zod)
    lib/                  prisma client, logger
    middleware/           error handling
    modules/              one folder per business module (health so far)
    app.ts  server.ts
  tests/
```

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
E-mail goes out over any SMTP provider: set `SMTP_URL` (e.g. `smtps://user:pass@smtp.example.com:465`) and `MAIL_FROM` in `.env`. Without `SMTP_URL`, development prints e-mails in the API log (`docker compose logs api`) and production sends nothing. A failed send is logged and never breaks registration or reset; the user can request a new link.

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
| `GET /chats` | my inbox: last message and unread count per chat, plus `totalUnread` |
| `POST /chats/match/:matchId`, `POST /chats/team/:teamId`, `POST /chats/direct` `{userId}` | open (get-or-create) a conversation and get its id; non-members get 404. Match chat = organizer + confirmed players; team chat = members; a DM needs a shared match or team and a verified e-mail |
| `GET /chats/:id/messages?limit&before=<messageId>` | history, newest first; `nextBefore` pages back; messages from blocked users are hidden; `canWrite` |
| `POST /chats/:id/messages` `{body}` | send (1-2000 chars, 20 per minute); a match chat is read-only after cancel or 7 days after the end |
| `POST /chats/:id/read` | mark read |

Realtime: connect Socket.IO to the API origin with `auth: { token: <accessToken> }`; members receive `message:new` `{id, conversationId, conversationType, senderId, body, createdAt}`. It is best-effort; REST is the source of truth, so after a reconnect fetch history. Messages can be reported (`targetType: MESSAGE`).

## Tests

```bash
cd backend && npm test      # needs the db running; uses a separate `fym_test` database (created automatically)
```
