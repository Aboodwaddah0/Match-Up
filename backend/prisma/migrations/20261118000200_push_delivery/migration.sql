-- ============================================================================
-- NOTIF-01: push delivery of notifications through Expo.
--
-- The `notification` row stays the single thing business code writes (notify()); this migration only ADDS the
-- machinery that turns pushable notifications into pushes. Nothing existing changes shape or meaning.
--
-- push_delivery: one row per (notification, device). Lifecycle (see src/jobs/push-worker.ts):
--     PENDING --claim--> SENDING --ticket ok--> ACCEPTED --receipt ok--> DELIVERED
--                           |  \--transient error--> PENDING (backoff)        |  \--no receipt in 24 h--> UNCONFIRMED
--                           |  \--permanent error--> FAILED                    \--receipt error--> FAILED, or PENDING again
--                           \--device/user gone, too old--> CANCELLED                              (MessageRateExceeded only)
--  * UNIQUE (notification_id, device_token_id): fan-out can be repeated or crash half way without ever creating a second
--    delivery for the same notification and device.
--  * device_token_id is ON DELETE SET NULL: a device removed while a push is in flight must not block or break anything.
--    notification_id is ON DELETE RESTRICT: nobody can purge a notification that still has deliveries (retention of
--    notifications, a separate item, must delete finished deliveries first).
--  * chk_push_claim / chk_push_receipt_lease: the send lease exists exactly while a delivery is SENDING; the receipt check has its own
--    lease pair, so a lease column can never be left behind on a delivery in another state.
--  * chk_push_ticket_phase: a row that has not been accepted by Expo has no ticket, an accepted one has. So an ACCEPTED push
--    can never silently go back to PENDING (which would send it a second time) without clearing its ticket on purpose.
--  * chk_push_token: the device token snapshot exists exactly while the delivery is alive and is wiped when it ends.
--
-- push_provider_state: two fixed rows, SEND and RECEIPT, shared by all API instances. When Expo rejects our credentials
-- the matching channel goes AUTH_FAILED and pauses; ONE instance at a time probes it (probe_claim_id / probe_until).
-- The two channels are independent on purpose: a receipt problem must never cause a resend.
--
-- push_rate_bucket: one row, a token bucket shared by all instances, so the combined send rate stays under Expo's
-- per-project limit. It uses the database clock, so instance clocks do not matter.
--
-- notification.push_fanout_at: NULL = fan-out not done yet. Existing rows are marked done here, so deploying this
-- never pushes old notifications.
--
-- Delivery guarantee: at-least-once (Expo has no idempotency key). A push is sent again if Expo accepted it but the
-- worker died before recording the ticket. collapseId reduces duplicates on the device; it is not a guarantee.
--
-- Rollback: DROP TABLE push_delivery, push_provider_state, push_rate_bucket; DROP TYPE push_status, push_channel,
-- push_channel_status; ALTER TABLE notification DROP COLUMN push_fanout_at (pending pushes are lost, in-app
-- notifications are untouched). Roll the API back first; the previous version ignores all of this.
-- ============================================================================

CREATE TYPE "push_status" AS ENUM ('PENDING', 'SENDING', 'ACCEPTED', 'DELIVERED', 'FAILED', 'CANCELLED', 'UNCONFIRMED');
CREATE TYPE "push_channel" AS ENUM ('SEND', 'RECEIPT');
CREATE TYPE "push_channel_status" AS ENUM ('OK', 'AUTH_FAILED');

CREATE TABLE "push_delivery" (
    "id"               UUID           NOT NULL DEFAULT gen_random_uuid(),
    "notification_id"  UUID           NOT NULL,
    "user_id"          UUID           NOT NULL,
    "device_token_id"  UUID,
    "expo_token"       TEXT,
    "status"           "push_status"  NOT NULL DEFAULT 'PENDING',
    "attempts"         INTEGER        NOT NULL DEFAULT 0,
    "next_attempt_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_until"     TIMESTAMPTZ(6),
    "claim_id"         UUID,
    "ticket_id"        TEXT,
    "ticket_at"        TIMESTAMPTZ(6),
    "receipt_attempts" INTEGER        NOT NULL DEFAULT 0,
    "next_receipt_at"  TIMESTAMPTZ(6),
    "receipt_claim_id"      UUID,
    "receipt_locked_until"  TIMESTAMPTZ(6),
    "last_error"       TEXT,
    "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at"      TIMESTAMPTZ(6),

    CONSTRAINT "push_delivery_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "push_delivery_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notification"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "push_delivery_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "push_delivery_device_token_id_fkey" FOREIGN KEY ("device_token_id") REFERENCES "device_token"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "push_delivery_notification_id_device_token_id_key" UNIQUE ("notification_id", "device_token_id"),
    CONSTRAINT chk_push_counters CHECK (attempts >= 0 AND receipt_attempts >= 0),
    -- The SEND lease: a delivery being sent carries BOTH claim_id and locked_until, every other delivery carries NEITHER.
    CONSTRAINT chk_push_claim CHECK (
        (status = 'SENDING' AND claim_id IS NOT NULL AND locked_until IS NOT NULL)
        OR (status <> 'SENDING' AND claim_id IS NULL AND locked_until IS NULL)),
    -- The RECEIPT lease is a separate pair, so the send lease above can be strict: only an ACCEPTED delivery that is being
    -- checked for its receipt carries it (both columns), every other delivery carries neither.
    CONSTRAINT chk_push_receipt_lease CHECK (
        (receipt_claim_id IS NULL AND receipt_locked_until IS NULL)
        OR (status = 'ACCEPTED' AND receipt_claim_id IS NOT NULL AND receipt_locked_until IS NOT NULL)),
    -- not yet accepted by Expo = no ticket; accepted = ticket + when to look for the receipt
    CONSTRAINT chk_push_ticket_phase CHECK (
        (status IN ('PENDING', 'SENDING') AND ticket_id IS NULL)
        OR (status = 'ACCEPTED' AND ticket_id IS NOT NULL AND ticket_at IS NOT NULL AND next_receipt_at IS NOT NULL)
        OR status IN ('DELIVERED', 'FAILED', 'CANCELLED', 'UNCONFIRMED')),
    -- the device token snapshot lives exactly as long as the delivery does
    CONSTRAINT chk_push_token CHECK ((status IN ('PENDING', 'SENDING', 'ACCEPTED')) = (expo_token IS NOT NULL)),
    CONSTRAINT chk_push_finished CHECK ((status IN ('DELIVERED', 'FAILED', 'CANCELLED', 'UNCONFIRMED')) = (finished_at IS NOT NULL))
);

CREATE INDEX idx_push_delivery_due ON "push_delivery" ("next_attempt_at") WHERE status = 'PENDING';
CREATE INDEX idx_push_delivery_leases ON "push_delivery" ("locked_until") WHERE status = 'SENDING';
CREATE INDEX idx_push_delivery_receipts ON "push_delivery" ("next_receipt_at") WHERE status = 'ACCEPTED';
CREATE INDEX idx_push_delivery_finished ON "push_delivery" ("finished_at") WHERE finished_at IS NOT NULL;
CREATE INDEX idx_push_delivery_device ON "push_delivery" ("device_token_id") WHERE device_token_id IS NOT NULL;

CREATE TABLE "push_provider_state" (
    "channel"              "push_channel"        NOT NULL,
    "status"               "push_channel_status" NOT NULL DEFAULT 'OK',
    "paused_until"         TIMESTAMPTZ(6),
    "consecutive_failures" INTEGER               NOT NULL DEFAULT 0,
    "last_error_code"      TEXT,
    "last_error_at"        TIMESTAMPTZ(6),
    "probe_claim_id"       UUID,
    "probe_until"          TIMESTAMPTZ(6),

    CONSTRAINT "push_provider_state_pkey" PRIMARY KEY ("channel"),
    CONSTRAINT chk_push_state_paused CHECK ((status = 'AUTH_FAILED') = (paused_until IS NOT NULL)),
    -- an election is either held (claim AND lease) or not (neither)
    CONSTRAINT chk_push_state_probe CHECK ((probe_claim_id IS NULL) = (probe_until IS NULL))
);
INSERT INTO "push_provider_state" ("channel") VALUES ('SEND'), ('RECEIPT');

CREATE TABLE "push_rate_bucket" (
    "id"            INTEGER          NOT NULL DEFAULT 1,
    "tokens"        DOUBLE PRECISION NOT NULL,
    "refilled_at"   TIMESTAMPTZ(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "blocked_until" TIMESTAMPTZ(6),

    CONSTRAINT "push_rate_bucket_pkey" PRIMARY KEY ("id"),
    CONSTRAINT chk_push_bucket_single CHECK (id = 1)
);
INSERT INTO "push_rate_bucket" ("id", "tokens") VALUES (1, 300);

-- Fan-out marker. Existing notifications are marked done so that deploying never pushes old events.
ALTER TABLE "notification" ADD COLUMN "push_fanout_at" TIMESTAMPTZ(6);
UPDATE "notification" SET "push_fanout_at" = now();
CREATE INDEX idx_notification_unfanned ON "notification" ("created_at") WHERE push_fanout_at IS NULL;
