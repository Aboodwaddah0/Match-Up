-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "citext";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "cube";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "earthdistance";

-- CreateEnum
CREATE TYPE "platform_role" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "account_status" AS ENUM ('ACTIVE', 'SUSPENDED', 'DELETED');

-- CreateEnum
CREATE TYPE "locale" AS ENUM ('ar', 'en');

-- CreateEnum
CREATE TYPE "token_type" AS ENUM ('EMAIL_VERIFY', 'PASSWORD_RESET');

-- CreateEnum
CREATE TYPE "position" AS ENUM ('GOALKEEPER', 'DEFENDER', 'MIDFIELDER', 'WINGER', 'STRIKER');

-- CreateEnum
CREATE TYPE "skill_level" AS ENUM ('BEGINNER', 'INTERMEDIATE', 'ADVANCED', 'PROFESSIONAL');

-- CreateEnum
CREATE TYPE "preferred_foot" AS ENUM ('RIGHT', 'LEFT', 'BOTH');

-- CreateEnum
CREATE TYPE "match_format" AS ENUM ('F5', 'F7', 'F11');

-- CreateEnum
CREATE TYPE "match_type" AS ENUM ('OPEN_MATCH', 'TEAM_CHALLENGE');

-- CreateEnum
CREATE TYPE "match_visibility" AS ENUM ('PUBLIC', 'PRIVATE');

-- CreateEnum
CREATE TYPE "match_status" AS ENUM ('OPEN', 'FULL', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'CLOSED_UNCONFIRMED');

-- CreateEnum
CREATE TYPE "request_status" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'WITHDRAWN', 'EXPIRED');

-- CreateEnum
CREATE TYPE "participant_status" AS ENUM ('CONFIRMED', 'LEFT', 'REMOVED', 'MATCH_CANCELLED');

-- CreateEnum
CREATE TYPE "attendance_status" AS ENUM ('UNKNOWN', 'ATTENDED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "match_side" AS ENUM ('HOME', 'AWAY');

-- CreateEnum
CREATE TYPE "booking_source" AS ENUM ('IN_APP', 'EXTERNAL');

-- CreateEnum
CREATE TYPE "booking_status" AS ENUM ('PENDING', 'CONFIRMED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "payment_status" AS ENUM ('UNPAID', 'PAID', 'REFUNDED');

-- CreateEnum
CREATE TYPE "venue_status" AS ENUM ('ACTIVE', 'INACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "venue_staff_role" AS ENUM ('MANAGER', 'STAFF');

-- CreateEnum
CREATE TYPE "venue_permission" AS ENUM ('MANAGE_BOOKINGS', 'MANAGE_FIELDS', 'MANAGE_AVAILABILITY', 'EDIT_VENUE', 'MANAGE_STAFF', 'VIEW_REPORTS');

-- CreateEnum
CREATE TYPE "block_reason" AS ENUM ('MAINTENANCE', 'PRIVATE_EVENT', 'OFFLINE_BOOKING', 'OTHER');

-- CreateEnum
CREATE TYPE "team_role" AS ENUM ('CAPTAIN', 'VICE_CAPTAIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "invitation_status" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "challenge_status" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "favorite_target" AS ENUM ('PLAYER', 'TEAM', 'VENUE', 'MATCH');

-- CreateEnum
CREATE TYPE "report_target" AS ENUM ('USER', 'MATCH', 'VENUE', 'TEAM', 'MESSAGE');

-- CreateEnum
CREATE TYPE "report_status" AS ENUM ('OPEN', 'IN_REVIEW', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "conversation_type" AS ENUM ('MATCH', 'TEAM', 'DIRECT');

-- CreateTable
CREATE TABLE "city" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name_ar" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Hebron',

    CONSTRAINT "city_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" CITEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "avatar_url" TEXT,
    "locale" "locale" NOT NULL DEFAULT 'ar',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Hebron',
    "platform_role" "platform_role" NOT NULL DEFAULT 'USER',
    "status" "account_status" NOT NULL DEFAULT 'ACTIVE',
    "email_verified_at" TIMESTAMPTZ(6),
    "last_login_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_token" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "type" "token_type" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_token" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_token" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blocked_user" (
    "blocker_id" UUID NOT NULL,
    "blocked_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blocked_user_pkey" PRIMARY KEY ("blocker_id","blocked_id")
);

-- CreateTable
CREATE TABLE "player_profile" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "date_of_birth" DATE,
    "bio" TEXT,
    "city_id" UUID,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "primary_position" "position",
    "skill_level" "skill_level" NOT NULL DEFAULT 'BEGINNER',
    "preferred_foot" "preferred_foot",
    "rating_avg" DECIMAL(3,2),
    "rating_count" INTEGER NOT NULL DEFAULT 0,
    "reliability_score" DECIMAL(5,2),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "player_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "player_position" (
    "player_profile_id" UUID NOT NULL,
    "position" "position" NOT NULL,

    CONSTRAINT "player_position_pkey" PRIMARY KEY ("player_profile_id","position")
);

-- CreateTable
CREATE TABLE "venue" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "owner_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "city_id" UUID NOT NULL,
    "address" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "contact_phone" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Hebron',
    "status" "venue_status" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "venue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "venue_staff" (
    "venue_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "venue_staff_role" NOT NULL DEFAULT 'STAFF',
    "permissions" "venue_permission"[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "venue_staff_pkey" PRIMARY KEY ("venue_id","user_id")
);

-- CreateTable
CREATE TABLE "venue_image" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "venue_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "venue_image_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "venue_field" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "venue_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "format" "match_format" NOT NULL,
    "capacity" INTEGER NOT NULL,
    "price_per_hour" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'ILS',
    "slot_minutes" INTEGER NOT NULL DEFAULT 60,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "venue_field_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "venue_opening_hours" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "field_id" UUID NOT NULL,
    "weekday" SMALLINT NOT NULL,
    "open_time" TIME(0) NOT NULL,
    "close_time" TIME(0) NOT NULL,

    CONSTRAINT "venue_opening_hours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "venue_block" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "venue_field_id" UUID NOT NULL,
    "start_at" TIMESTAMPTZ(6) NOT NULL,
    "end_at" TIMESTAMPTZ(6) NOT NULL,
    "time_range" tstzrange,
    "reason" "block_reason" NOT NULL DEFAULT 'OTHER',
    "note" TEXT,
    "group_id" UUID,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "venue_block_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "source" "booking_source" NOT NULL,
    "status" "booking_status" NOT NULL DEFAULT 'PENDING',
    "created_by_id" UUID NOT NULL,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "cancelled_by_id" UUID,
    "cancel_reason" TEXT,
    "venue_field_id" UUID,
    "start_at" TIMESTAMPTZ(6) NOT NULL,
    "end_at" TIMESTAMPTZ(6) NOT NULL,
    "time_range" tstzrange,
    "hold_expires_at" TIMESTAMPTZ(6),
    "total_price" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'ILS',
    "payment_status" "payment_status" NOT NULL DEFAULT 'UNPAID',
    "notes" TEXT,
    "ext_venue_name" TEXT,
    "ext_venue_address" TEXT,
    "ext_venue_phone" TEXT,
    "ext_field_info" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_event" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "booking_id" UUID NOT NULL,
    "actor_id" UUID,
    "from_status" "booking_status",
    "to_status" "booking_status" NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "match" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizer_id" UUID NOT NULL,
    "booking_id" UUID,
    "type" "match_type" NOT NULL,
    "visibility" "match_visibility" NOT NULL DEFAULT 'PUBLIC',
    "format" "match_format" NOT NULL,
    "status" "match_status" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "notes" TEXT,
    "start_at" TIMESTAMPTZ(6) NOT NULL,
    "end_at" TIMESTAMPTZ(6) NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Hebron',
    "city_id" UUID,
    "location_name" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "required_skill_level" "skill_level",
    "price_per_player" DECIMAL(10,2),
    "currency" TEXT NOT NULL DEFAULT 'ILS',
    "capacity" INTEGER,
    "completed_at" TIMESTAMPTZ(6),
    "completed_by_id" UUID,
    "closed_unconfirmed_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "cancelled_by_id" UUID,
    "cancel_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "match_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "match_required_position" (
    "match_id" UUID NOT NULL,
    "position" "position" NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "match_required_position_pkey" PRIMARY KEY ("match_id","position")
);

-- CreateTable
CREATE TABLE "match_request" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "match_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "request_status" NOT NULL DEFAULT 'PENDING',
    "message" TEXT,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "match_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "match_participant" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "match_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "request_id" UUID,
    "match_team_id" UUID,
    "status" "participant_status" NOT NULL DEFAULT 'CONFIRMED',
    "position_played" "position",
    "joined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMPTZ(6),
    "is_late_cancellation" BOOLEAN NOT NULL DEFAULT false,
    "attendance_status" "attendance_status" NOT NULL DEFAULT 'UNKNOWN',
    "attendance_confirmed_by_id" UUID,
    "attendance_confirmed_at" TIMESTAMPTZ(6),
    "time_range" tstzrange,

    CONSTRAINT "match_participant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "match_team" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "match_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "side" "match_side" NOT NULL,

    CONSTRAINT "match_team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "match_invitation" (
    "match_id" UUID NOT NULL,
    "invitee_id" UUID NOT NULL,
    "invited_by_id" UUID NOT NULL,
    "status" "invitation_status" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "match_invitation_pkey" PRIMARY KEY ("match_id","invitee_id")
);

-- CreateTable
CREATE TABLE "match_event" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "match_id" UUID NOT NULL,
    "actor_id" UUID,
    "from_status" "match_status",
    "to_status" "match_status" NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "match_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "description" TEXT,
    "logo_url" TEXT,
    "city_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_member" (
    "team_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "team_role" NOT NULL DEFAULT 'MEMBER',
    "joined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_member_pkey" PRIMARY KEY ("team_id","user_id")
);

-- CreateTable
CREATE TABLE "team_invitation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_id" UUID NOT NULL,
    "invitee_id" UUID NOT NULL,
    "invited_by_id" UUID NOT NULL,
    "status" "invitation_status" NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_challenge" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "challenger_team_id" UUID NOT NULL,
    "challenged_team_id" UUID NOT NULL,
    "format" "match_format" NOT NULL,
    "proposed_start_at" TIMESTAMPTZ(6) NOT NULL,
    "message" TEXT,
    "status" "challenge_status" NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "resulting_match_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_challenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "match_id" UUID NOT NULL,
    "reviewer_id" UUID NOT NULL,
    "reviewed_id" UUID NOT NULL,
    "sportsmanship_score" SMALLINT NOT NULL,
    "skill_score" SMALLINT NOT NULL,
    "reliability_score" SMALLINT NOT NULL,
    "comment" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "params" JSONB NOT NULL DEFAULT '{}',
    "resource_type" TEXT,
    "resource_id" UUID,
    "read_at" TIMESTAMPTZ(6),
    "push_sent_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "favorite" (
    "user_id" UUID NOT NULL,
    "target_type" "favorite_target" NOT NULL,
    "target_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "favorite_pkey" PRIMARY KEY ("user_id","target_type","target_id")
);

-- CreateTable
CREATE TABLE "report" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "reporter_id" UUID NOT NULL,
    "target_type" "report_target" NOT NULL,
    "target_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "details" TEXT,
    "status" "report_status" NOT NULL DEFAULT 'OPEN',
    "resolved_by_id" UUID,
    "resolved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "type" "conversation_type" NOT NULL,
    "match_id" UUID,
    "team_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_participant" (
    "conversation_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "last_read_at" TIMESTAMPTZ(6),

    CONSTRAINT "conversation_participant_pkey" PRIMARY KEY ("conversation_id","user_id")
);

-- CreateTable
CREATE TABLE "message" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "conversation_id" UUID NOT NULL,
    "sender_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "city_name_en_key" ON "city"("name_en");

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "user_token_token_hash_key" ON "user_token"("token_hash");

-- CreateIndex
CREATE INDEX "user_token_user_id_type_idx" ON "user_token"("user_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_token_token_hash_key" ON "refresh_token"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_token_user_id_idx" ON "refresh_token"("user_id");

-- CreateIndex
CREATE INDEX "refresh_token_family_id_idx" ON "refresh_token"("family_id");

-- CreateIndex
CREATE UNIQUE INDEX "device_token_token_key" ON "device_token"("token");

-- CreateIndex
CREATE INDEX "device_token_user_id_idx" ON "device_token"("user_id");

-- CreateIndex
CREATE INDEX "blocked_user_blocked_id_idx" ON "blocked_user"("blocked_id");

-- CreateIndex
CREATE UNIQUE INDEX "player_profile_user_id_key" ON "player_profile"("user_id");

-- CreateIndex
CREATE INDEX "player_profile_city_id_idx" ON "player_profile"("city_id");

-- CreateIndex
CREATE INDEX "venue_owner_id_idx" ON "venue"("owner_id");

-- CreateIndex
CREATE INDEX "venue_city_id_idx" ON "venue"("city_id");

-- CreateIndex
CREATE INDEX "venue_staff_user_id_idx" ON "venue_staff"("user_id");

-- CreateIndex
CREATE INDEX "venue_image_venue_id_idx" ON "venue_image"("venue_id");

-- CreateIndex
CREATE INDEX "venue_field_venue_id_idx" ON "venue_field"("venue_id");

-- CreateIndex
CREATE UNIQUE INDEX "venue_opening_hours_field_id_weekday_open_time_key" ON "venue_opening_hours"("field_id", "weekday", "open_time");

-- CreateIndex
CREATE INDEX "venue_block_venue_field_id_start_at_idx" ON "venue_block"("venue_field_id", "start_at");

-- CreateIndex
CREATE INDEX "venue_block_group_id_idx" ON "venue_block"("group_id");

-- CreateIndex
CREATE INDEX "booking_venue_field_id_start_at_idx" ON "booking"("venue_field_id", "start_at");

-- CreateIndex
CREATE INDEX "booking_created_by_id_status_idx" ON "booking"("created_by_id", "status");

-- CreateIndex
CREATE INDEX "booking_event_booking_id_created_at_idx" ON "booking_event"("booking_id", "created_at");

-- CreateIndex
CREATE INDEX "match_organizer_id_start_at_idx" ON "match"("organizer_id", "start_at");

-- CreateIndex
CREATE INDEX "match_city_id_start_at_idx" ON "match"("city_id", "start_at");

-- CreateIndex
CREATE INDEX "match_booking_id_idx" ON "match"("booking_id");

-- CreateIndex
CREATE INDEX "match_request_match_id_status_idx" ON "match_request"("match_id", "status");

-- CreateIndex
CREATE INDEX "match_request_user_id_status_idx" ON "match_request"("user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "match_participant_request_id_key" ON "match_participant"("request_id");

-- CreateIndex
CREATE INDEX "match_participant_user_id_status_idx" ON "match_participant"("user_id", "status");

-- CreateIndex
CREATE INDEX "match_participant_match_id_status_idx" ON "match_participant"("match_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "match_participant_match_id_user_id_key" ON "match_participant"("match_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "match_team_match_id_side_key" ON "match_team"("match_id", "side");

-- CreateIndex
CREATE UNIQUE INDEX "match_team_match_id_team_id_key" ON "match_team"("match_id", "team_id");

-- CreateIndex
CREATE INDEX "match_invitation_invitee_id_status_idx" ON "match_invitation"("invitee_id", "status");

-- CreateIndex
CREATE INDEX "match_event_match_id_created_at_idx" ON "match_event"("match_id", "created_at");

-- CreateIndex
CREATE INDEX "team_city_id_idx" ON "team"("city_id");

-- CreateIndex
CREATE INDEX "team_member_user_id_idx" ON "team_member"("user_id");

-- CreateIndex
CREATE INDEX "team_invitation_invitee_id_status_idx" ON "team_invitation"("invitee_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "team_challenge_resulting_match_id_key" ON "team_challenge"("resulting_match_id");

-- CreateIndex
CREATE INDEX "team_challenge_challenged_team_id_status_idx" ON "team_challenge"("challenged_team_id", "status");

-- CreateIndex
CREATE INDEX "team_challenge_challenger_team_id_status_idx" ON "team_challenge"("challenger_team_id", "status");

-- CreateIndex
CREATE INDEX "review_reviewed_id_idx" ON "review"("reviewed_id");

-- CreateIndex
CREATE UNIQUE INDEX "review_match_id_reviewer_id_reviewed_id_key" ON "review"("match_id", "reviewer_id", "reviewed_id");

-- CreateIndex
CREATE INDEX "notification_user_id_created_at_idx" ON "notification"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "report_status_created_at_idx" ON "report"("status", "created_at");

-- CreateIndex
CREATE INDEX "report_target_type_target_id_idx" ON "report"("target_type", "target_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_match_id_key" ON "conversation"("match_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_team_id_key" ON "conversation"("team_id");

-- CreateIndex
CREATE INDEX "conversation_participant_user_id_idx" ON "conversation_participant"("user_id");

-- CreateIndex
CREATE INDEX "message_conversation_id_created_at_idx" ON "message"("conversation_id", "created_at");

-- AddForeignKey
ALTER TABLE "user_token" ADD CONSTRAINT "user_token_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_token" ADD CONSTRAINT "refresh_token_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_token" ADD CONSTRAINT "device_token_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blocked_user" ADD CONSTRAINT "blocked_user_blocker_id_fkey" FOREIGN KEY ("blocker_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blocked_user" ADD CONSTRAINT "blocked_user_blocked_id_fkey" FOREIGN KEY ("blocked_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_profile" ADD CONSTRAINT "player_profile_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_profile" ADD CONSTRAINT "player_profile_city_id_fkey" FOREIGN KEY ("city_id") REFERENCES "city"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_position" ADD CONSTRAINT "player_position_player_profile_id_fkey" FOREIGN KEY ("player_profile_id") REFERENCES "player_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue" ADD CONSTRAINT "venue_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue" ADD CONSTRAINT "venue_city_id_fkey" FOREIGN KEY ("city_id") REFERENCES "city"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_staff" ADD CONSTRAINT "venue_staff_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_staff" ADD CONSTRAINT "venue_staff_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_image" ADD CONSTRAINT "venue_image_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_field" ADD CONSTRAINT "venue_field_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_opening_hours" ADD CONSTRAINT "venue_opening_hours_field_id_fkey" FOREIGN KEY ("field_id") REFERENCES "venue_field"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_block" ADD CONSTRAINT "venue_block_venue_field_id_fkey" FOREIGN KEY ("venue_field_id") REFERENCES "venue_field"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_block" ADD CONSTRAINT "venue_block_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking" ADD CONSTRAINT "booking_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking" ADD CONSTRAINT "booking_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking" ADD CONSTRAINT "booking_cancelled_by_id_fkey" FOREIGN KEY ("cancelled_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking" ADD CONSTRAINT "booking_venue_field_id_fkey" FOREIGN KEY ("venue_field_id") REFERENCES "venue_field"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_event" ADD CONSTRAINT "booking_event_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_event" ADD CONSTRAINT "booking_event_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match" ADD CONSTRAINT "match_organizer_id_fkey" FOREIGN KEY ("organizer_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match" ADD CONSTRAINT "match_completed_by_id_fkey" FOREIGN KEY ("completed_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match" ADD CONSTRAINT "match_cancelled_by_id_fkey" FOREIGN KEY ("cancelled_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match" ADD CONSTRAINT "match_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match" ADD CONSTRAINT "match_city_id_fkey" FOREIGN KEY ("city_id") REFERENCES "city"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_required_position" ADD CONSTRAINT "match_required_position_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_request" ADD CONSTRAINT "match_request_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "match"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_request" ADD CONSTRAINT "match_request_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_request" ADD CONSTRAINT "match_request_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_participant" ADD CONSTRAINT "match_participant_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "match"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_participant" ADD CONSTRAINT "match_participant_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_participant" ADD CONSTRAINT "match_participant_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "match_request"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_participant" ADD CONSTRAINT "match_participant_match_team_id_fkey" FOREIGN KEY ("match_team_id") REFERENCES "match_team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_participant" ADD CONSTRAINT "match_participant_attendance_confirmed_by_id_fkey" FOREIGN KEY ("attendance_confirmed_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_team" ADD CONSTRAINT "match_team_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "match"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_team" ADD CONSTRAINT "match_team_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_invitation" ADD CONSTRAINT "match_invitation_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "match"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_invitation" ADD CONSTRAINT "match_invitation_invitee_id_fkey" FOREIGN KEY ("invitee_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_invitation" ADD CONSTRAINT "match_invitation_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_event" ADD CONSTRAINT "match_event_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "match"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_event" ADD CONSTRAINT "match_event_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team" ADD CONSTRAINT "team_city_id_fkey" FOREIGN KEY ("city_id") REFERENCES "city"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_member" ADD CONSTRAINT "team_member_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_member" ADD CONSTRAINT "team_member_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_invitation" ADD CONSTRAINT "team_invitation_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_invitation" ADD CONSTRAINT "team_invitation_invitee_id_fkey" FOREIGN KEY ("invitee_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_invitation" ADD CONSTRAINT "team_invitation_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_challenge" ADD CONSTRAINT "team_challenge_challenger_team_id_fkey" FOREIGN KEY ("challenger_team_id") REFERENCES "team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_challenge" ADD CONSTRAINT "team_challenge_challenged_team_id_fkey" FOREIGN KEY ("challenged_team_id") REFERENCES "team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_challenge" ADD CONSTRAINT "team_challenge_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_challenge" ADD CONSTRAINT "team_challenge_resulting_match_id_fkey" FOREIGN KEY ("resulting_match_id") REFERENCES "match"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review" ADD CONSTRAINT "review_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "match"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review" ADD CONSTRAINT "review_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review" ADD CONSTRAINT "review_reviewed_id_fkey" FOREIGN KEY ("reviewed_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "favorite" ADD CONSTRAINT "favorite_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report" ADD CONSTRAINT "report_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report" ADD CONSTRAINT "report_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "match"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_participant" ADD CONSTRAINT "conversation_participant_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_participant" ADD CONSTRAINT "conversation_participant_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message" ADD CONSTRAINT "message_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message" ADD CONSTRAINT "message_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

