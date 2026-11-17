# Find Your Match — Project Memory

Football matchmaking platform (players, organizers, venue owners, admins).
**Full requirements: [PROJECT_REQUIREMENTS.md](PROJECT_REQUIREMENTS.md) — read it before any design or code work.**

## Locked product decisions (don't change without asking)
- Football only
- Venue booking: in-app AND external (external may reference unregistered venues → store snapshot)
- Joining matches requires organizer approval
- Audience: players, teams, venue owners; local market first, extensible later

## Stack (proposed, review before implementing)
Node.js + TypeScript + Express + Prisma + PostgreSQL + JWT + Zod; React Native + Expo + Expo Router; Socket.IO; Cloudinary/S3; Docker. Modular monolith.

## How to work with me
- No code before requirements/architecture/ERD are agreed; never generate the whole project at once.
- Explain decisions and trade-offs; flag risks before implementing.
- Ask ONE focused question when a business rule is missing — don't invent rules.
- Separate MVP from future features; avoid over-engineering and unnecessary abstractions.
- Validate all input server-side; use transactions/constraints for capacity, booking overlap, duplicate requests.
- When giving code: exact file path, imports, validation, error handling, migration notes.
- Preserve my existing structure when reviewing my code.

## Resolved decisions (PROJECT_REQUIREMENTS.md §15, D1–D17)
2h booking hold then EXPIRED; venue permissions per-venue via VenueStaff; only CONFIRMED participation blocks overlapping matches (requests only warn); late cancel <12h, no-shows organizer-confirmed; hybrid match lifecycle (organizer confirms COMPLETED); price informational; team challenge → one Match + MatchTeam HOME/AWAY; private = invite-only; Arabic+English/RTL, UTC storage, default Asia/Hebron; email+password auth only.
Keep MatchRequest (pending) and MatchParticipant (confirmed) strictly separate. Jobs must be idempotent; DB is the source of truth.
Database design (pre-ERD): [DATABASE_DESIGN.md](DATABASE_DESIGN.md).

## Status (updated 2026-11-17)

**Design (done):** requirements D1–D17 in PROJECT_REQUIREMENTS.md §15; DB design + ERD (DATABASE_DESIGN.md, DATABASE_ERD.md); Prisma schema + hand-written SQL constraints/triggers in backend/prisma (see backend/prisma/README.md). Key rules: OPEN_MATCH (capacity = players wanted via the app; confirmed_count / available_spots are DERIVED, never stored) vs TEAM_CHALLENGE (no capacity or requests, starts SCHEDULED); CLOSED_UNCONFIRMED = IN_PROGRESS + 48h past end, organizer can recover within 7d then admin only; venue owners never create bookings (they approve/reject and use VenueBlock for offline time); match time editable only while nobody is confirmed.

**Built (backend/, TypeScript + Express 5 + Prisma 6, Docker Compose: db, migrate, api, adminer — see README.md):**
1. Auth: register, verify e-mail, login, rotating refresh tokens with reuse detection, logout, forgot/reset/change password.
2. Player profiles + cities (seeded).
3. Matches: create/edit/cancel/complete, search (filters + nearby), join requests + approval, participants, leave/remove/no-show, private invitations, lifecycle sweeper job.
4. Venues and bookings: venues, per-venue staff permissions, fields, weekly hours (local time zone), blocks, availability slots, booking requests with a 2h hold (approve/reject/cancel/expire), external bookings, match-to-booking link, booking expiry + completion jobs.
5. Teams and challenges: teams, captain/vice roles, invitations, captaincy transfer, challenges (accept creates one TEAM_CHALLENGE match with HOME/AWAY sides), per-side rosters, expiry job.
6. Notifications: list, unread count, mark read / read-all, device-token registration (push delivery NOT wired; rows are written as outbox by notify()). 7. Reviews and reputation: attendees of a COMPLETED match review each other once within 7 days (scores 1-5 for sportsmanship, skill, reliability + comment); rating cache on the profile; reliability 0-100 derived from attendance (no-show weighs 2x a late cancellation). The organizer is not a participant, so only players review.
8. Safety: user blocking (symmetric in effect, drops pending join requests), reports (USER/MATCH/VENUE/TEAM; one open report per target, 20/day) and an admin triage queue (OPEN > IN_REVIEW > RESOLVED/DISMISSED, reporter notified).
9. E-mail: SMTP via nodemailer (SMTP_URL, MAIL_FROM; provider-agnostic; failures logged, never fatal).
10. Chat: match / team / direct conversations (membership derived live from match participants / team members), message history with cursor, unread counts, read-only after cancel or 7 days post-match, Socket.IO push (message:new). DMs only between people sharing a match or team (my default, easy to loosen).
149 integration tests pass (run `cd backend && npm test`); verified in Docker.

**Not started:** push delivery, admin (beyond report triage), image upload, mobile app.

**Gotchas:** on Windows, run `docker compose restart api` after editing source (file watching does not reach the container). Heredocs with long text get truncated in the shell tool: write scripts to files instead.
