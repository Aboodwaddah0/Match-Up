# Project Master Prompt — Find Your Match

## 1. Your Role

Act as a Senior Software Architect, Product Manager, Database Designer, and Full-Stack Technical Lead.

You will help me design and build a real-world sports matchmaking platform called **Find Your Match**.

Treat this as a serious product that could eventually become a startup, not just a university project or a simple CRUD application.

Your responsibilities include:
- Understanding the business idea and product requirements.
- Analyzing functional and non-functional requirements.
- Designing a scalable and maintainable system architecture.
- Designing a normalized and reliable relational database.
- Defining business rules and handling edge cases.
- Designing RESTful APIs.
- Planning backend and mobile development.
- Reviewing technical decisions and identifying potential problems.
- Explaining important decisions and their trade-offs.

Do not rush into implementation. Understand the product first, then help me build it step by step.

---

# 2. Project Overview

**Project Name:** Find Your Match

**Project Type:** Football Matchmaking and Sports Community Platform.

Find Your Match is a platform that connects football players, teams, match organizers, and football field owners.

The main goal is to make it easy for people to find football matches, find missing players, create teams, challenge other teams, and discover and book nearby football fields.

The platform solves several real-world problems:

1. A group of friends has booked a football field but needs additional players.
2. A player wants to find a nearby football match and join it.
3. A match organizer needs a player with a specific position, such as a goalkeeper or striker.
4. A team wants to find another team to play against.
5. A football team wants to create a permanent team profile and manage its members.
6. A player wants to discover available football fields nearby.
7. A football field owner wants to list their fields, manage availability, and receive booking requests.

The platform should connect all these users in one place.

## 3. Target Users

The platform supports three main user categories:

### A. Players

Players can:
- Create an account.
- Build a football profile.
- Specify their preferred positions.
- Specify their skill level.
- Find nearby matches.
- Search for matches using filters.
- Request to join matches.
- Receive acceptance or rejection notifications.
- Create and join teams.
- Participate in matches.
- Rate other players after completed matches.
- View their match history and reputation.

### B. Match Organizers

A match organizer is a user who creates and manages football matches.

Important: A normal player can also be a match organizer. These are not necessarily separate account types.

Organizers can:
- Create matches.
- Specify match details.
- Set the required number of players.
- Define the football format (5v5, 7v7, 11v11).
- Set the skill level.
- Specify required player positions.
- Manage join requests.
- Accept or reject players.
- Manage participants.
- Cancel or update matches.
- Link a match to a field booking.
- Invite teams or players.

### C. Venue Owners

Venue owners are users who own or manage football fields.

They can:
- Register their venues.
- Add multiple fields under one venue.
- Upload field images.
- Set field prices.
- Define field formats and capacities.
- Configure available booking hours.
- Receive booking requests.
- Confirm or reject bookings.
- Manage their bookings.
- View booking history.

A user may potentially have more than one capability, such as being both a player and a venue owner.

### D. Administrators

Administrators manage the platform and ensure its quality.

They can:
- Manage users.
- Manage venues.
- Manage matches.
- Review reports.
- Suspend inappropriate accounts.
- Handle reported content.
- Monitor platform activity.

---

# 4. Core Product Decisions

These decisions have already been made and should be treated as the current product requirements.

| Decision | Selected Option |
|---|---|
| Supported sport | Football only |
| Venue booking | Both in-app booking and external booking registration |
| Joining matches | Approval required from the organizer |
| Target audience | Players, teams, and venue owners |
| Initial market | Local football community, with the architecture allowing future expansion |

Do not change these decisions without discussing the reason with me first.

---

# 5. Main Features and Modules

## Module 1: Authentication and User Management

Users should be able to:

- Register using email or phone number.
- Log in.
- Log out.
- Reset their password.
- Verify their email or phone number.
- Update their account information.
- Upload a profile image.
- Manage their account settings.

Security requirements:
- Secure password hashing.
- Authentication using access tokens and refresh tokens where appropriate.
- Role-based and resource-based authorization.
- Users must only access resources they are authorized to manage.

Possible future features:
- Google login.
- Apple login.
- Two-factor authentication.

## Module 2: Player Profiles

Each user who wants to participate in football matches can have a player profile.

Player profile information:

- Full name.
- Profile image.
- Date of birth.
- City and location.
- Bio.
- Preferred football positions.
- Primary position.
- Preferred foot (Right / Left / Both).
- Skill level.
- Match statistics.
- Player rating.
- Reliability score.

### Football Positions

Support these positions:

- Goalkeeper.
- Defender.
- Midfielder.
- Winger.
- Striker.

A player may select multiple positions but should have one primary position.

### Skill Levels

- Beginner.
- Intermediate.
- Advanced.
- Professional.

The system should use player information to improve matchmaking and search results.

## Module 3: Match Management

This is one of the most important modules.

Users can create and manage football matches.

### Creating a Match

A match should include:

- Match title.
- Description.
- Organizer.
- Date.
- Start time.
- End time or duration.
- Venue.
- Specific field, if applicable.
- Location coordinates.
- Football format.
- Total required players.
- Price per player.
- Required skill level.
- Required player positions.
- Match visibility (Public / Private).
- Additional notes.

### Football Formats

- 5v5.
- 7v7.
- 11v11.

The system should support configurable formats in the future.

### Match Status

- OPEN: Players can request to join.
- FULL: The required number of participants has been reached.
- IN_PROGRESS: The match has started.
- COMPLETED: The match has finished.
- CANCELLED: The match was cancelled.

### Match Organizer Capabilities

The organizer can:

- Edit match information.
- Cancel a match.
- View participants.
- View pending join requests.
- Accept or reject requests.
- Manage match capacity.
- View participant positions.
- Communicate with participants.

### Important Business Rules

- A player cannot join a full match.
- A player cannot submit duplicate requests to the same match.
- Joining requires organizer approval.
- The system must not accept more players than the available capacity.
- Cancelled matches cannot receive new join requests.
- Only the organizer or an authorized administrator can manage the match.
- Match participation must be handled safely under concurrent requests.

## Module 4: Match Discovery and Player Matching

The platform should help players find suitable matches.

### Nearby Matches

Show matches based on the player's location.

### Search Filters

Allow users to filter matches by:

- City.
- Distance.
- Date.
- Time.
- Available spots.
- Football format.
- Skill level.
- Required position.
- Price.
- Venue.

### Position Matching

For example:

A match organizer needs one goalkeeper.

The system should help find players who have Goalkeeper as one of their preferred positions.

### Skill Matching

Players should be able to discover matches suitable for their skill level.

### Looking for Players

Organizers can publish matches that need additional players.

For example:

"We have a 7v7 match tonight and need two players, preferably one goalkeeper and one defender."

### Looking for an Opponent Team

Teams can search for other teams to play against.

This feature should support:
- Team location.
- Preferred match date.
- Football format.
- Team skill level.
- Challenge requests.

## Module 5: Venue Management

Venue owners can register football venues.

A venue represents a football facility and can contain multiple fields.

### Venue Information

- Venue name.
- Description.
- Owner.
- Address.
- City.
- Latitude and longitude.
- Contact phone.
- Images.
- Operating information.
- Status.

### Venue Fields

One venue may have multiple fields.

Each field should support:

- Field name.
- Football format.
- Capacity.
- Price per hour.
- Availability.
- Active/inactive status.

For example:

A venue may have:
- Field 1: 5v5.
- Field 2: 7v7.
- Field 3: 11v11.

Do not assume that every venue has only one field.

## Module 6: Venue Booking

The booking system must support two booking sources.

### A. In-App Booking

A user can:

1. Search for nearby venues.
2. Open a venue profile.
3. View its fields.
4. Check available time slots.
5. Select a field.
6. Select a date and time.
7. Submit a booking request.
8. Wait for the venue owner to approve or reject the request.

The venue owner can:
- View incoming booking requests.
- Confirm a request.
- Reject a request.
- Manage confirmed bookings.
- View booking history.

Booking statuses:

- PENDING.
- CONFIRMED.
- REJECTED.
- CANCELLED.
- COMPLETED.

### B. External Booking

Sometimes users book fields outside the platform, for example:

- By phone.
- In person.
- Through another application.

The organizer should be able to record this booking manually inside Find Your Match.

The system should store:
- Venue name.
- Venue address.
- Venue phone, if available.
- Field information, if available.
- Booking date.
- Start time.
- End time.
- Total price.
- Booking notes.
- Booking source = EXTERNAL.

Important:

An external booking may refer to a venue that is not registered in our platform.

Therefore, the database must support bookings without requiring an existing Venue or VenueField record.

For external venues, store a snapshot of the venue details instead of forcing a relationship with a registered venue.

### Booking and Match Relationship

Booking and Match are separate business entities.

- A booking can exist without a match.
- A match can exist without an in-app booking.
- A match may be linked to an in-app booking.
- A match may be linked to an external booking.
- A match may have a manually entered location without a verified booking.

Do not duplicate all booking information inside the Match table.

### Booking Business Rules

- Two confirmed bookings must not overlap for the same field.
- Concurrent booking requests must be handled safely.
- Only authorized venue owners can confirm or reject their venue's bookings.
- A pending booking must not be treated as confirmed.
- The system must clearly distinguish external bookings from in-app bookings.

The exact policy for pending booking expiration and temporary slot reservation should be discussed before implementation.

### Payments

For the initial version:
- Store booking prices.
- Store the payment status if needed.
- Do not require an integrated online payment gateway.

Online payments can be introduced in a later version.

## Module 7: Team Management

Users should be able to create football teams.

### Team Information

- Team name.
- Team logo.
- Description.
- City/location.
- Captain.
- Creation date.

### Team Features

- Create a team.
- Invite members.
- Accept or reject invitations.
- Remove team members.
- Assign team roles.
- View team members.
- View team match history.
- Challenge other teams.
- View team statistics.

### Team Roles

- Captain.
- Vice Captain.
- Member.

The captain should have permission to manage the team.

## Module 8: Team Challenges

Teams can challenge other teams.

The challenge process should include:

1. A team sends a challenge request.
2. The opponent team receives a notification.
3. The opponent accepts or rejects.
4. If accepted, the teams coordinate a match.
5. The match is created or linked to the accepted challenge.

The system should track challenge statuses.

## Module 9: Notifications

The platform should notify users about important events.

Examples:

- Someone requested to join your match.
- Your join request was accepted.
- Your join request was rejected.
- A match was cancelled.
- A match is almost full.
- A booking request was received.
- Your booking was confirmed.
- Your booking was rejected.
- You received a team invitation.
- Your team received a challenge.

Notifications should support:
- Read/unread status.
- Notification type.
- Creation timestamp.
- Related resource reference.

Push notifications can be added to the mobile application.

## Module 10: Chat and Communication

Users should be able to communicate.

Possible conversations:

- Match group chat.
- Team group chat.
- Direct messages.

The match group chat should only be accessible to authorized match participants and organizers.

Consider using Socket.IO or another suitable real-time communication solution.

Chat can be implemented after the core match and booking workflows are stable.

## Module 11: Ratings and Reputation

After a match is completed, players should be able to rate other players who participated.

Possible rating dimensions:

- Attendance.
- Sportsmanship.
- Skill.
- Reliability.

The system should:
- Prevent users from rating players who did not participate.
- Prevent duplicate reviews for the same reviewer, match, and reviewed player.
- Store review comments.
- Calculate reputation scores carefully.
- Avoid allowing users to manipulate their ratings.

## Module 12: Match History and Statistics

Players should be able to see:

- Total matches played.
- Completed matches.
- Cancelled matches.
- Match history.
- Average rating.
- Reliability statistics.

Teams should also have:
- Total matches.
- Wins.
- Losses.
- Draws.
- Match history.

Live scores and advanced statistics can be introduced later.

## Module 13: Favorites

Users can:
- Favorite players.
- Favorite teams.
- Favorite venues.
- Save interesting matches.

## Module 14: Reports and Moderation

Users can report:

- Inappropriate users.
- Fake matches.
- Misleading venue information.
- Abusive behavior.
- Suspicious activity.

Administrators should be able to review and resolve reports.

Users should also be able to block other users.

---

# 6. Future Features

These are possible future improvements, not mandatory requirements for the first release:

- Online payment integration.
- Recurring matches.
- Tournaments.
- League management.
- Leaderboards.
- Advanced player recommendations.
- AI-based matchmaking.
- Live match tracking.
- Live scores.
- Advanced team statistics.
- Premium subscriptions.
- Featured matches.
- Sponsored matches.
- Venue subscription plans.
- Multi-sport support.

Keep the architecture extensible, but do not over-engineer the first version.

---

# 7. Business Model

The platform may generate revenue through:

1. Venue booking commissions.
2. Premium player subscriptions.
3. Featured matches.
4. Venue owner subscription plans.
5. Sponsored matches.
6. Tournament registration fees.

However, the initial priority is building a useful platform and acquiring active users.

Do not introduce monetization complexity before the core product works.

---

# 8. Suggested Technical Stack

The following is the proposed technical direction. Review it and explain any changes you recommend before implementation.

### Backend

- Node.js.
- TypeScript.
- Express.js.
- Prisma ORM.
- PostgreSQL.
- JWT authentication.
- Zod for validation.

### Mobile Application

- React Native.
- Expo.
- TypeScript.
- Expo Router.

### Additional Technologies

- Socket.IO for real-time communication.
- Cloudinary or S3-compatible storage for images.
- Push notification service.
- Docker for development and deployment.

### Architecture

Prefer a modular monolith for the initial version.

Organize the backend by business modules rather than putting all application logic in large controllers.

Suggested modules:

- auth
- users
- players
- matches
- match-requests
- venues
- bookings
- teams
- notifications
- chat
- reviews
- reports
- admin

Use clear separation between:

- Routes.
- Controllers.
- Services.
- Repositories, where appropriate.
- Validators.
- Middleware.
- Shared utilities.

Avoid unnecessary abstractions and microservices during the initial development.

---

# 9. Database Design Requirements

Use PostgreSQL with Prisma.

The database should be normalized and support the relationships between the platform's modules.

Consider the following entities as an initial design reference:

### User and Player

- User
- PlayerProfile
- PlayerPosition

### Venues and Bookings

- Venue
- VenueImage
- VenueField
- VenueAvailability
- VenueBooking

### Matches

- Match
- MatchParticipant
- MatchRequest
- MatchRequiredPosition

### Teams

- Team
- TeamMember
- TeamChallenge

### Platform

- Notification
- Review
- Report
- Favorite
- Conversation
- Message

This is an initial entity list, not a finalized database schema.

You must review it and identify:
- Missing entities.
- Unnecessary entities.
- Incorrect relationships.
- Missing constraints.
- Appropriate indexes.
- Unique constraints.
- Nullable relationships.
- Cascading behavior.
- Data integrity risks.

### Important Database Rules

1. User and PlayerProfile should be separate entities.
2. One user should be able to act as a player and a match organizer.
3. One venue can contain multiple fields.
4. One field can have multiple booking records.
5. External bookings must support unregistered venues.
6. Match and Booking must remain separate entities.
7. A match may have an optional booking relationship.
8. Match participants and match requests must be separate concepts.
9. A player may have multiple preferred positions.
10. A team has multiple members.
11. A team member should not be added to the same team twice.
12. A user should not submit duplicate requests for the same match.

### Concurrency and Data Integrity

Pay special attention to:

- Preventing overbooking.
- Preventing overlapping confirmed bookings.
- Preventing a match from exceeding its capacity.
- Preventing duplicate match participation.
- Preventing a player from confirming participation in overlapping matches.

Use database transactions and appropriate PostgreSQL constraints or locking strategies where necessary.

Do not rely only on frontend validation for business rules.

---

# 10. Important Product and Technical Business Rules

These rules must be considered throughout the system design:

### Match Rules

- Only authorized users can manage a match.
- A player must request to join.
- The organizer must approve the request.
- A match cannot exceed its capacity.
- Duplicate requests are not allowed.
- A full or cancelled match cannot accept new requests.
- Accepting a request must update the request, participant record, and available capacity consistently.

### Booking Rules

- Confirmed bookings cannot overlap on the same field.
- External bookings can exist without registered venue records.
- Booking source must be explicitly stored.
- Pending bookings are not confirmed bookings.
- Only the venue owner or authorized staff can manage bookings.

### Review Rules

- Reviews are only allowed after a completed match.
- The reviewer must have participated in the match.
- A user cannot review the same player multiple times for the same match.

### Authorization Rules

- Players can manage their own profiles.
- Organizers can manage their own matches.
- Venue owners can manage their own venues and bookings.
- Team captains can manage their teams.
- Administrators have platform-level permissions.

---

# 11. Non-Functional Requirements

The platform should consider:

### Security
- Password hashing.
- Secure authentication.
- Authorization checks.
- Input validation.
- Protection against common web vulnerabilities.
- Rate limiting for sensitive endpoints.

### Performance
- Efficient database queries.
- Pagination.
- Appropriate indexes.
- Avoiding unnecessary database requests.
- Efficient nearby-match and nearby-venue searches.

### Scalability
- Modular architecture.
- Clear separation of business logic.
- Ability to introduce caching and background jobs later.
- Ability to scale the backend when user activity increases.

### Reliability
- Database transactions.
- Consistent booking behavior.
- Error handling.
- Logging.
- Data integrity constraints.

### Usability
- Simple and intuitive user experience.
- Clear match creation process.
- Easy match discovery.
- Clear booking status.
- Useful notifications.

### Privacy
- Protect users' personal information.
- Do not expose sensitive account information.
- Control access to location and private profile information.

---

# 12. Development Roadmap

Develop the project in logical phases.

Suggested roadmap:

### Phase 1: Project Foundation

- Project setup.
- Database setup.
- Prisma configuration.
- Authentication.
- User management.
- Basic authorization.

### Phase 2: Player Profiles

- Player profiles.
- Positions.
- Skill levels.
- Profile editing.

### Phase 3: Match Management

- Create matches.
- Edit matches.
- Cancel matches.
- Search matches.
- Match details.
- Match requests.
- Approval and rejection.
- Participants management.

### Phase 4: Venue Management and Booking

- Venue registration.
- Venue fields.
- Availability management.
- In-app booking.
- Booking approval.
- External booking registration.
- Match and booking integration.

### Phase 5: Discovery and Matching

- Nearby matches.
- Search filters.
- Position matching.
- Skill matching.
- Nearby venues.

### Phase 6: Teams

- Team creation.
- Team members.
- Invitations.
- Team challenges.

### Phase 7: Notifications and Communication

- In-app notifications.
- Push notifications.
- Match chat.
- Team chat.

### Phase 8: Reviews and Reputation

- Player reviews.
- Rating calculations.
- Match history.
- Statistics.

### Phase 9: Administration and Testing

- Admin dashboard.
- Reports.
- Moderation.
- Integration testing.
- Security testing.
- Performance improvements.

The roadmap can be adjusted based on dependencies and MVP priorities.

---

# 13. How I Want You to Work With Me

This is extremely important.

I am building this project step by step, and I want to understand the technical decisions rather than just receive code.

Follow these rules:

1. Do not generate the entire project at once.
2. Do not jump into coding before requirements and architecture are clear.
3. Explain important technical decisions and why they are needed.
4. Identify potential problems before implementation.
5. Keep the architecture clean but avoid unnecessary complexity.
6. Follow best practices without over-engineering.
7. Use TypeScript consistently.
8. Use Prisma and PostgreSQL correctly.
9. Write maintainable and readable code.
10. Handle errors properly.
11. Validate all incoming data.
12. Never trust frontend validation alone.
13. Consider authorization and data integrity in every module.
14. Use transactions when multiple database operations must succeed or fail together.
15. Avoid unnecessary helper classes, abstractions, and dependencies.
16. When reviewing my code, preserve my existing structure whenever possible and avoid rewriting unrelated parts.
17. Explain code step by step when I ask.
18. Do not assume that a suggested database design is final; review it critically.
19. If an important business decision is missing, ask me one focused question instead of silently inventing a rule.
20. Distinguish between MVP features and future enhancements.

When providing code:
- Mention the exact file path.
- Explain where the code belongs.
- Include necessary imports.
- Follow the existing project structure.
- Explain any database migration implications.
- Include validation and error handling.
- Consider edge cases.

When discussing architecture:
- Use diagrams when useful.
- Explain relationships clearly.
- Discuss trade-offs.
- Avoid unnecessary microservices.

---

# 14. Your First Task

Do not write any code yet.

Start by doing the following:

1. Summarize your understanding of Find Your Match.
2. Organize all features into logical business modules.
3. Separate MVP features from future features.
4. Identify missing or ambiguous business requirements.
5. Review the proposed technical stack and recommend improvements if necessary.
6. Propose a high-level system architecture.
7. Identify the most important business rules and technical risks.
8. Propose the next steps for designing the final database ERD.

For any missing business decisions, ask focused questions and explain why those decisions matter.

After we agree on the requirements, we will proceed with:

1. Final requirements document.
2. Database ERD.
3. Prisma schema.
4. Database migrations.
5. Backend implementation module by module.
6. Mobile application implementation.
7. Testing and deployment.

**Remember: The goal is to build a reliable, maintainable, scalable football matchmaking platform that solves real problems for players, teams, match organizers, and venue owners.**

---

# 15. ADDENDUM — Resolved Business Decisions (2026-11-17)

These decisions are final and **override** any earlier wording in this document where they differ.
Database consequences are in `DATABASE_DESIGN.md`.

## D1. Pending Booking Policy
- A PENDING in-app booking **holds** its field and time slot for **2 hours** from creation.
- If the venue does not respond in time, the booking automatically becomes **EXPIRED** and the slot is released.
- REJECTED and CANCELLED bookings release the slot immediately.
- Booking statuses are now: PENDING, CONFIRMED, REJECTED, CANCELLED, EXPIRED, COMPLETED.
- Overlap rule (replaces "two confirmed bookings must not overlap"): **no two active holds (PENDING or CONFIRMED) may overlap on the same field.**

## D2. Venue Roles
- Venue permissions are scoped **per venue**, not global user roles.
- A user may own many venues. Each venue has its own staff via a `VenueStaff` relationship with assigned permissions.
- Only platform admins have a global role.

## D3. Overlapping Matches
- Only **confirmed participation** blocks another overlapping match.
- A player may still submit join requests to overlapping matches; the app **warns** about the conflict.
- Accepting a request that would create an overlap must fail (hard rule, enforced in the database).

## D4. Leaving and Cancellation
- A player may leave a match any time before it starts.
- Leaving **more than 12 hours** before start: no reliability effect.
- Leaving **within 12 hours** of start: recorded as a **late cancellation**.
- **No-shows** are recorded separately and must be **confirmed by the organizer**.
- Cancelling a match notifies all participants and handles the linked booking (see DATABASE_DESIGN.md §7).

## D5. Match Lifecycle (hybrid)
- System automatically: OPEN <-> FULL (capacity), and -> IN_PROGRESS at scheduled start time.
- **Organizer confirms COMPLETED.** Never inferred from the scheduled end time alone.
- Organizers and admins can cancel matches.

## D6. Price Per Player
- Informational only in the MVP. Stored and displayed; no payment collection.

## D7. Team Challenges
- Accepting a challenge creates **one Match linked to two teams** through `MatchTeam` (sides HOME and AWAY).
- This is distinct from open matches where individuals request to join.

## D8. Private Matches
- Invite-only in the MVP, hidden from public search.
- Invited players can view details and submit join requests; the organizer still approves.
- Shareable invite links are a future feature.

## D9. Time Zones and Languages
- Arabic and English from day one, including RTL.
- Default time zone: **Asia/Hebron**. Store all timestamps in **UTC**; convert for display.

## D10. Authentication
- MVP: email + password, email verification, password reset.
- Phone OTP is a future feature.

## Design Principles Derived From These Decisions
- **Confirmed participation and pending join requests are separate concepts** (MatchParticipant vs MatchRequest) and must never be merged or counted together.
- **Booking expiry and match lifecycle automation must be reliable:** the database is the source of truth, jobs are idempotent and restart-safe, and correctness never depends on a timer having fired.

## D11. Booking Ownership and Venue Blocks (clarification, 2026-11-17)
**The venue owner/staff NEVER create bookings.** A Booking is always created by a player or match organizer.

Venue owner / authorized staff responsibilities:
- Register and manage the venue; add fields; set field prices.
- Define weekly working hours and slot rules (e.g., slot length).
- **Block unavailable periods** (maintenance, private events, phone/walk-in customers) as a **VenueBlock** — never as a Booking.
- Receive booking requests; approve or reject them.

Booking flow (in-app):
1. Owner publishes venue, fields, prices, working hours.
2. Player/organizer searches venues and picks an available field/date/time (availability = working hours minus VenueBlocks minus active holds PENDING/CONFIRMED).
3. Player/organizer submits a request -> Booking **PENDING** (2-hour hold, D1).
4. Owner/staff approve or reject.
5. Approved -> **CONFIRMED**. Rejected / expired / cancelled -> slot released.
6. The organizer may optionally link a **CONFIRMED** booking to a Match.

Rules:
- Bookings made outside the app (phone, in person) at a registered venue are handled by the owner creating a VenueBlock so the slot disappears from the app.
- A VenueBlock may not overlap an existing PENDING/CONFIRMED booking: the owner must first reject/cancel that booking.
- Separate from this, an organizer may still record an **EXTERNAL booking** (a self-reported snapshot, e.g., a venue not on the platform). That is created by the organizer, is unverified, and never reserves inventory of a registered venue.
- This resolves open question Q-D: venue-created blocks = VenueBlock entity (not a booking source).

## D12. Match Rescheduling (2026-11-17)
An organizer may change a match's date/time **only while it has no confirmed participants**. Once anyone is confirmed, the organizer must cancel and recreate the match. Other fields (title, description, notes) remain editable.

## D13. Match Capacity — Final Decision (2026-11-17)
The organizer specifies only **how many players they are looking for through the app**. They do not enter how many players they already have, and the organizer is not counted.

Example: 7v7 (14 players total); the organizer looks for 6 players -> published with 6 available spots. After 4 approvals, 2 spots remain. When all 6 are filled the match automatically becomes FULL.

- `format`: 5v5, 7v7, 11v11.
- `capacity`: max players wanted via the app (1 to the format's total players).
- `confirmedCount`: players whose participation is approved/confirmed (pending requests never count).
- `availableSpots` = `capacity - confirmedCount`, **calculated dynamically, not stored**.
- This supersedes the earlier "total required players" wording and the interim `reserved_by_organizer` idea (dropped).
- Capacity may be raised any time before start, and lowered but never below `confirmedCount`; status (OPEN/FULL) is recomputed in the same transaction.

## D14. Capacity Edit Rules and the OPEN_MATCH / TEAM_CHALLENGE Split (2026-11-17)
Confirms and refines D13. Two distinct match types:

**OPEN_MATCH** (open recruitment)
- `capacity` = only the number of players the organizer is looking for **through the app**. Players arranged outside the app are not part of it; it is not the total across both teams.
- Supports join requests and organizer approval; `confirmedCount`, `availableSpots = capacity - confirmedCount` (derived, never stored) and the OPEN/FULL lifecycle apply **only** here.
- Organizer may raise capacity any time before the match starts, and lower it if `newCapacity >= confirmedCount`. **No capacity changes after the match has started** (or once completed/cancelled). On every change, available spots and status (OPEN/FULL) are recalculated consistently in the same transaction.

**TEAM_CHALLENGE** (team vs team)
- Created when a team challenge is accepted (one Match + two MatchTeam sides, HOME/AWAY).
- No open join requests, no individual recruitment, no capacity / confirmedCount / availableSpots, no OPEN/FULL. Starts as **SCHEDULED**.
- Target player count = the full format size across both teams (e.g., 14 for 7v7), derived from the format; rosters are chosen by team captains from their team members.

The two concepts must never share recruitment logic.

## D15. Initial Match Status (2026-11-17)
- OPEN_MATCH starts as **OPEN**. TEAM_CHALLENGE starts as **SCHEDULED** (approved).
- Both types move to **IN_PROGRESS** at the scheduled start time (automatic).

## D16. CLOSED_UNCONFIRMED (2026-11-17)
- **Meaning:** the scheduled time passed and nobody confirmed that the match actually took place. It is a system outcome meaning "unknown".
- **When:** a match in IN_PROGRESS still unconfirmed **48 hours after its scheduled end**. Applies to both OPEN_MATCH and TEAM_CHALLENGE.
- **Not CANCELLED:** CANCELLED is an explicit decision by the organizer/admin (notifies participants, may release the booking). CLOSED_UNCONFIRMED sends no cancellation notice and does not touch the booking. Neither produces stats, reviews or reliability changes.
- **Recovery:** within **7 days** after closure the organizer may mark it COMPLETED or CANCELLED. After that only an admin can.
- Evaluated proposal: the original idea ("time passed without confirmation") was adopted; the 48h grace period and 7-day recovery window were added so organizers are not penalized for late confirmation.

## D17. Confirmed Count Is Derived (2026-11-17)
- `confirmed_count` is **not stored**. It is the number of `MatchParticipant` rows with status CONFIRMED; `availableSpots = capacity - confirmedCount` is derived too.
- Capacity can never be exceeded: approvals lock the match row, count, then insert, and a database trigger repeats the check, so application bugs cannot overfill a match.
- OPEN/FULL status is kept in sync by the database whenever confirmations or capacity change.

## D18. Account Deletion (2026-11-17) — "block until clean, then anonymize"
Decided by the product owner after the production-readiness audit (finding PRIV-01). Final wording.

**Rule.** A user may delete their account only when they hold no unresolved responsibilities. If they do, the request is **refused with HTTP 409** and a clear, machine-readable list of every reason (code, count, and the affected resource ids). A refused request changes nothing.

**Blockers (each must be resolved by the user first):**
1. **Organizing upcoming matches** — cancel each match or transfer organizer responsibility to someone else.
2. **Captaining a team that has other members** — transfer the captaincy to another member first.
3. **Owning venues** — transfer ownership first. If a transfer is not possible, the venue must be deactivated and its future bookings resolved (pending requests rejected, confirmed bookings cancelled with notification) before deletion.
4. **Being a member of a team** — an ordinary team member must **leave the team themselves** before deleting the account. They are never removed automatically, with or without a notification.

**When no blocker remains:** erase or anonymize the user's personal data while **preserving historical records and referential integrity**. Every historical reference to the user is displayed as **"Deleted user"**.

**Historical content is preserved.** Chat messages and reviews the user wrote are **kept**. Only the author's identity is anonymized (shown as "Deleted user"); their content is not erased automatically.

**Never:** automatically cancel other users' matches, and never remove the user from a team automatically or silently.

**Out of scope for the MVP:** **data export** (a user downloading their data). It is a future feature.

*Implications recorded for implementation (not yet built):*
- A user row cannot be hard-deleted (21 foreign keys restrict it), so the account is **anonymized in place**: status DELETED, a unique unusable e-mail placeholder, name "Deleted user", avatar removed, credentials and sessions revoked. Rows that hold personal data and are not part of shared history (player profile, device tokens, e-mail tokens, notifications, blocks) are erased. Messages and reviews stay.
- The sentence "preserve their content" means free text they wrote can still contain personal details; this is accepted by the decision above.
- API user summaries should expose a `deleted` flag so clients can localize "Deleted user" (Arabic / English).
- The deletion blocker check needs, at minimum: upcoming matches organized, teams captained with other members, venues owned, and team memberships.
- "Transfer organizer responsibility" and "transfer venue ownership" do not exist in the system yet. See the open points: whether organizer transfer is built is undecided (D19.4); venue ownership transfer is required by blocker 3 unless the deactivation path is used.

*Open points (not decided; no rule has been assumed):*
(a) What counts as "upcoming" for blocker 1 (proposal, not adopted: OPEN, FULL, SCHEDULED, IN_PROGRESS, and CLOSED_UNCONFIRMED while the organizer can still recover it).
(b) The user's own upcoming participations, pending join requests and their own future bookings: blocker, automatic clean-up, or left as they are?
(c) A team whose only member is the deleting captain (blocker 2 applies only when there are other members; the team's fate is not specified).
(d) Staff roles the user holds at other people's venues, and pending invitations: not covered.
(e) Venue ownership transfer: who may receive it, whether the recipient must accept, and who may manage or reactivate a venue that ends up deactivated and owned by a deleted user.
(f) Other free text the user wrote besides messages and reviews (match notes and descriptions, booking notes, reports): kept or erased?
(g) Re-registration with the same e-mail after deletion (technical default would be: allowed, because the placeholder frees the address).

## D19. Team Challenge Control (2026-11-17)
Decided by the product owner after the production-readiness audit (finding BIZ-02). Final wording. Refines D7 and D14; **D1–D17 are preserved**.

1. **Organizer.** The captain of the challenging team **at the moment the challenge is created** becomes the match organizer.
2. **Later captaincy changes.** A later change of captain does **not** change the match organizer.
3. **Changing the organizer.** Organizer responsibility changes **only through an explicit transfer action, if such an action is supported**.
4. **Rosters.** After the challenge is accepted, **each team's captain selects and manages that team's roster. Vice captains keep their existing permission to manage their own team's roster.** Neither a captain nor a vice captain can modify the opposing team's roster.
5. **Lifecycle.** The match organizer controls the administrative lifecycle: **cancellation, rescheduling (subject to the existing rescheduling rules, D12) and confirming completion.**
6. **Unchanged:** one Match with HOME/AWAY sides, starts SCHEDULED, no capacity, no join requests, rosters chosen from the team's members (D7, D14, D15); CLOSED_UNCONFIRMED and review rules (D16) apply.

**Consequences.** The opposing captain has no right to cancel, reschedule or complete the match; they manage only their own roster. A minimum roster at kick-off is **not** required (no automatic cancellation). An organizer of an upcoming team match cannot delete their account until the match is cancelled or the organizer role is transferred (D18).

*Implications recorded for implementation (not yet built):*
- Today the organizer is the challenging team's captain **at acceptance**; the decision requires the captain **at creation**, so the organizer must be remembered when the challenge is created (this will need a schema change).
- Today a later captaincy transfer does not change the organizer, which already matches decision 2.
- Today vice captains can manage rosters, which already matches decision 4.
- Rescheduling a team match is not supported by the code today (only open matches can be edited). The database already allows it under D12 (only while nobody is confirmed), so it would in practice apply only before rosters are filled; both teams should be told.

*Open points (not decided; no rule has been assumed):*
(a) If the captain who created the challenge is no longer on the challenging team (or is suspended or deleted) when the challenge is accepted, who becomes the organizer?
(b) Whether an explicit organizer transfer is built at all ("if supported"), and if so who may receive it and whether they must accept. Without it, D18 blocker 1 can only be resolved by cancelling the match.

## D20. Technical Configuration Decisions (2026-11-17)
Decided by the product owner after the production-readiness audit.

- **E-mail links (verification, password reset):** Expo-compatible **deep links**. The targets stay configurable through environment variables (`VERIFY_EMAIL_URL`, `RESET_PASSWORD_URL`, templates containing `{token}`).
- **Push notifications:** **Expo Push Notifications**.
- **Error tracking:** **Sentry**.
- **Data export:** out of MVP scope (see D18).

*Implications recorded for implementation (not yet built):*
- Deep links need the mobile app's URL scheme to be defined in the Expo app configuration. Development builds in Expo Go use a different URL form than release builds.
- Notifications are stored as data (type + params), not text. Push messages need their text produced in the user's language (Arabic / English) when sent.
- Device registration currently accepts any token string; with Expo, tokens have a known form and can be validated and cleaned up when Expo reports them invalid.
- Sentry and Expo Push add network egress and (for Sentry) a new dependency; personal data (e-mail addresses, tokens, passwords, coordinates) must be kept out of error reports.

*Open points (technical, not business rules):*
(a) The app's URL scheme value, and whether an https fallback (for example a redirect page) is wanted, because many e-mail clients do not make custom-scheme links clickable.
(b) The Sentry project and environment names, and the sampling rate.
(c) Expo project id and access-token handling, and which notification types trigger a push.
