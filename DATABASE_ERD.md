# Find Your Match — ERD (draft v0.3)

Companion to `DATABASE_DESIGN.md` (constraints, indexes, concurrency rules live there). Mermaid renders in GitHub/VS Code. Columns shown are the structurally important ones only. Status: draft — only Q-B (match rescheduling policy) is open and it does not change any table.

## 1. Identity and Players

```mermaid
erDiagram
    CITY ||--o{ USER_PROFILE_LOCATION : "city_id"
    USER ||--o| PLAYER_PROFILE : has
    PLAYER_PROFILE ||--o{ PLAYER_POSITION : prefers
    USER ||--o{ USER_TOKEN : "verify/reset"
    USER ||--o{ REFRESH_TOKEN : sessions
    USER ||--o{ BLOCKED_USER : blocker
    USER ||--o{ BLOCKED_USER : blocked

    USER {
        uuid id PK
        citext email UK
        string password_hash
        timestamptz email_verified_at
        string locale "ar|en"
        string timezone "Asia/Hebron"
        enum platform_role "USER|ADMIN"
        enum status
    }
    PLAYER_PROFILE {
        uuid id PK
        uuid user_id UK
        uuid city_id FK
        float latitude
        float longitude
        enum primary_position
        enum skill_level
        enum preferred_foot
        int late_cancellations
        int no_shows
        decimal avg_rating
    }
    PLAYER_POSITION {
        uuid player_profile_id PK
        enum position PK
    }
    USER_TOKEN {
        uuid id PK
        enum type
        string token_hash
        timestamptz expires_at
        timestamptz used_at
    }
    REFRESH_TOKEN {
        uuid id PK
        uuid family_id
        string token_hash
        timestamptz revoked_at
    }
```
(`USER_PROFILE_LOCATION` above stands for PlayerProfile/Venue/Match/Team each referencing `CITY`.)

## 2. Venues, Availability, Blocks, Bookings (D1, D2, D11)

```mermaid
erDiagram
    USER ||--o{ VENUE : owns
    VENUE ||--o{ VENUE_STAFF : has
    USER ||--o{ VENUE_STAFF : "works at"
    VENUE ||--o{ VENUE_IMAGE : has
    VENUE ||--o{ VENUE_FIELD : contains
    VENUE_FIELD ||--o{ VENUE_OPENING_HOURS : "weekly hours"
    VENUE_FIELD ||--o{ VENUE_BLOCK : "unavailable periods"
    USER ||--o{ VENUE_BLOCK : "created by staff"
    VENUE_FIELD |o--o{ BOOKING : "in-app only"
    USER ||--o{ BOOKING : "requests (created_by)"
    USER |o--o{ BOOKING : "decides (decided_by)"
    BOOKING ||--o{ BOOKING_EVENT : history

    VENUE {
        uuid id PK
        uuid owner_id FK
        uuid city_id FK
        float latitude
        float longitude
        string timezone "Asia/Hebron"
        enum status
    }
    VENUE_STAFF {
        uuid venue_id PK
        uuid user_id PK
        enum role "MANAGER|STAFF"
        enum[] permissions
    }
    VENUE_FIELD {
        uuid id PK
        uuid venue_id FK
        enum format
        int capacity
        decimal price_per_hour
        int slot_minutes
        bool is_active
    }
    VENUE_OPENING_HOURS {
        uuid field_id FK
        int weekday
        time open_time "local wall-clock"
        time close_time
    }
    VENUE_BLOCK {
        uuid id PK
        uuid venue_field_id FK
        tstzrange time_range "EXCLUDE per field"
        enum reason
        uuid group_id
        uuid created_by_id FK
    }
    BOOKING {
        uuid id PK
        enum source "IN_APP|EXTERNAL"
        enum status "PENDING|CONFIRMED|REJECTED|CANCELLED|EXPIRED|COMPLETED"
        uuid created_by_id FK
        uuid decided_by_id FK
        uuid venue_field_id FK "NULL if EXTERNAL"
        tstzrange time_range "EXCLUDE per field, PENDING+CONFIRMED"
        timestamptz hold_expires_at
        decimal total_price
        string ext_venue_name "EXTERNAL snapshot"
        string ext_venue_address
        string ext_venue_phone
        string ext_field_info
        enum payment_status
    }
```
Cross-table rule: BOOKING and VENUE_BLOCK never overlap on the same field (field-row lock + constraint trigger; see DATABASE_DESIGN.md §3 Booking).

## 3. Matches, Requests vs Participants, Teams (D3–D8)

```mermaid
erDiagram
    USER ||--o{ MATCH : organizes
    CITY ||--o{ MATCH : located_in
    BOOKING |o--o| MATCH : "optional link (CONFIRMED, creator = organizer)"
    MATCH ||--o{ MATCH_REQUIRED_POSITION : needs
    MATCH ||--o{ MATCH_REQUEST : "pending asks"
    USER ||--o{ MATCH_REQUEST : submits
    MATCH ||--o{ MATCH_PARTICIPANT : "confirmed members"
    USER ||--o{ MATCH_PARTICIPANT : plays
    MATCH_REQUEST |o--o| MATCH_PARTICIPANT : "origin of"
    MATCH ||--o{ MATCH_INVITATION : "private access"
    USER ||--o{ MATCH_INVITATION : invited
    MATCH ||--o{ MATCH_TEAM : "2 sides (challenge)"
    TEAM ||--o{ MATCH_TEAM : plays_as
    MATCH_TEAM |o--o{ MATCH_PARTICIPANT : roster
    MATCH ||--o{ MATCH_EVENT : history

    TEAM ||--o{ TEAM_MEMBER : has
    USER ||--o{ TEAM_MEMBER : joins
    TEAM ||--o{ TEAM_INVITATION : sends
    TEAM ||--o{ TEAM_CHALLENGE : challenger
    TEAM ||--o{ TEAM_CHALLENGE : challenged
    TEAM_CHALLENGE |o--o| MATCH : "accepted creates"

    MATCH {
        uuid id PK
        uuid organizer_id FK
        uuid booking_id FK "NULL, partial unique"
        enum type "OPEN_MATCH|TEAM_CHALLENGE"
        enum visibility "PUBLIC|PRIVATE"
        enum format
        enum status "OPEN|FULL (OPEN_MATCH) ; SCHEDULED (TEAM_CHALLENGE) ; IN_PROGRESS|COMPLETED|CANCELLED|CLOSED_UNCONFIRMED"
        timestamptz start_at
        timestamptz end_at
        string timezone
        float latitude
        float longitude
        enum required_skill_level
        decimal price_per_player "informational"
        int capacity "OPEN_MATCH only: players wanted via the app; NULL for TEAM_CHALLENGE"
    }
    MATCH_REQUEST {
        uuid id PK
        uuid match_id FK
        uuid user_id FK
        enum status "PENDING|ACCEPTED|REJECTED|WITHDRAWN|EXPIRED"
        uuid decided_by_id FK
    }
    MATCH_PARTICIPANT {
        uuid id PK
        uuid match_id FK "UK with user_id"
        uuid user_id FK
        uuid request_id FK
        uuid match_team_id FK "team matches only"
        enum status "CONFIRMED|LEFT|REMOVED|MATCH_CANCELLED"
        tstzrange time_range "EXCLUDE per user where CONFIRMED"
        bool is_late_cancellation
        enum attendance_status "UNKNOWN|ATTENDED|NO_SHOW"
        uuid attendance_confirmed_by FK
    }
    MATCH_TEAM {
        uuid id PK
        uuid match_id FK
        uuid team_id FK
        enum side "HOME|AWAY"
    }
    MATCH_INVITATION {
        uuid match_id PK
        uuid invitee_id PK
        enum status
    }
    TEAM {
        uuid id PK
        uuid city_id FK
        string name
    }
    TEAM_MEMBER {
        uuid team_id PK
        uuid user_id PK
        enum role "CAPTAIN|VICE_CAPTAIN|MEMBER"
    }
    TEAM_CHALLENGE {
        uuid id PK
        uuid challenger_team_id FK
        uuid challenged_team_id FK
        enum status
        timestamptz expires_at
        uuid resulting_match_id FK
    }
```
`MATCH_REQUEST` (pending) and `MATCH_PARTICIPANT` (confirmed) are deliberately separate tables; only `MATCH_PARTICIPANT` rows with status CONFIRMED count. `confirmed_count` and `available_spots` are **derived** (view `match_availability`), never stored. A team's captain is the `TEAM_MEMBER` row with role CAPTAIN (one per team, partial unique index) — there is no `captain_id` column to drift.

## 4. Platform: Reviews, Notifications, Favorites, Reports, Chat

```mermaid
erDiagram
    MATCH ||--o{ REVIEW : "after COMPLETED"
    USER ||--o{ REVIEW : reviewer
    USER ||--o{ REVIEW : reviewed
    USER ||--o{ NOTIFICATION : receives
    USER ||--o{ FAVORITE : saves
    USER ||--o{ REPORT : files
    CONVERSATION ||--o{ CONVERSATION_PARTICIPANT : has
    CONVERSATION ||--o{ MESSAGE : contains
    USER ||--o{ MESSAGE : sends
    MATCH |o--o| CONVERSATION : "match chat"
    TEAM |o--o| CONVERSATION : "team chat"

    REVIEW {
        uuid id PK
        uuid match_id FK "UK(match,reviewer,reviewed)"
        uuid reviewer_id FK
        uuid reviewed_id FK
        int attendance_score
        int sportsmanship_score
        int skill_score
    }
    NOTIFICATION {
        uuid id PK
        uuid user_id FK
        string type
        jsonb params "locale-independent"
        string resource_type
        uuid resource_id
        timestamptz read_at
        timestamptz push_sent_at
    }
    FAVORITE {
        uuid user_id PK
        enum target_type PK
        uuid target_id PK
    }
    REPORT {
        uuid id PK
        uuid reporter_id FK
        enum target_type
        uuid target_id
        enum status
        uuid resolved_by FK
    }
```
`FAVORITE`/`REPORT` targets are polymorphic (type + id); integrity is enforced in the service layer, not by FKs. Acceptable for MVP; revisit if reporting volume grows.

## 5. Cascade policy (summary)
- Default `RESTRICT`; users are anonymized (status DELETED), never hard-deleted.
- `CASCADE` only for pure children: PlayerPosition, VenueImage, VenueOpeningHours, UserToken, RefreshToken, ConversationParticipant.
- Venue/Field with any Booking or Match history: deactivate (`is_active`/status), never delete.
- `Match.booking_id`: `SET NULL` is **not** used; the link is kept so history shows the booking's final status.
