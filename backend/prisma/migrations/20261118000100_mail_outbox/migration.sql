-- ============================================================================
-- MAIL-01 / AUTH-02: transactional e-mail outbox.
--
-- A business operation (register, forgot-password, resend-verification) inserts its one-time
-- token AND a row here in the SAME transaction; a worker sends the message later. So a request
-- never waits for SMTP, a dead mail server cannot hold requests, and a message is never lost
-- when the process dies between "token created" and "mail sent".
--
-- What a row holds:
--  * kind + locale + recipient: the message is RENDERED AT SEND TIME from the application's
--    templates, so the configurable link targets (VERIFY_EMAIL_URL / RESET_PASSWORD_URL) apply
--    to queued messages too, and no mail body is stored.
--  * token_enc: the raw one-time token, ENCRYPTED (AES-256-GCM with the dedicated key
--    MAIL_OUTBOX_ENCRYPTION_KEY, never the JWT secret; row id bound as associated data). The token table stores only a hash on purpose;
--    the outbox must not undo that. The column is set to NULL as soon as the message is SENT,
--    FAILED or CANCELLED (enforced by chk_mail_outbox_secret_lifecycle).
--
-- Worker protocol (see src/jobs/mail-worker.ts):
--  * claim:  UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED): two workers never take
--            the same row. A claim sets status SENDING, a claim_id and a lease (locked_until)
--            and counts the attempt.
--  * crash:  a SENDING row whose lease has expired is claimed again, so a crashed worker loses
--            nothing; because the attempt is counted at claim time, a message that keeps crashing
--            the worker still ends as FAILED after max attempts.
--  * finish: UPDATE ... WHERE id AND claim_id = <mine> AND status = 'SENDING': a worker whose
--            lease expired cannot overwrite the result of the worker that took over.
--  * retry:  transient errors -> PENDING with next_attempt_at (backoff); permanent SMTP errors
--            and exhausted attempts -> FAILED (terminal).
--
-- DELIVERY GUARANTEE: at-least-once. SMTP cannot give exactly-once: if the server accepts a
-- message and the worker dies before recording SENT, the row is retried and the recipient can get
-- the same message twice (each copy carries the same Message-ID derived from the row id, which
-- lets mail systems and clients de-duplicate, but that is not guaranteed).
--
-- Rollback: DROP TABLE mail_outbox; DROP TYPE mail_status; DROP TYPE mail_kind;
--   Queued messages are lost with the table (users can request a new link; tokens already
--   created stay valid). Roll the application back FIRST (or at the same time): the previous
--   version sends mail inline and does not use this table. See README for the deployment order.
-- ============================================================================

CREATE TYPE "mail_kind" AS ENUM ('EMAIL_VERIFY', 'PASSWORD_RESET');
CREATE TYPE "mail_status" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED', 'CANCELLED');

CREATE TABLE "mail_outbox" (
    "id"              UUID           NOT NULL DEFAULT gen_random_uuid(),
    "user_id"         UUID           NOT NULL,
    "kind"            "mail_kind"    NOT NULL,
    "to_email"        TEXT           NOT NULL,
    "locale"          "locale"       NOT NULL,
    "token_enc"       TEXT,
    "expires_at"      TIMESTAMPTZ(6) NOT NULL,
    "status"          "mail_status"  NOT NULL DEFAULT 'PENDING',
    "attempts"        INTEGER        NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_until"    TIMESTAMPTZ(6),
    "claim_id"        UUID,
    "last_error"      TEXT,
    "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at"         TIMESTAMPTZ(6),
    "finished_at"     TIMESTAMPTZ(6),

    CONSTRAINT "mail_outbox_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "mail_outbox_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT chk_mail_outbox_attempts CHECK (attempts >= 0),
    -- the secret exists exactly while the message can still be sent
    CONSTRAINT chk_mail_outbox_secret_lifecycle CHECK ((status IN ('PENDING', 'SENDING')) = (token_enc IS NOT NULL)),
    -- a claimed row always carries its lease
    CONSTRAINT chk_mail_outbox_claim CHECK (status <> 'SENDING' OR (claim_id IS NOT NULL AND locked_until IS NOT NULL)),
    CONSTRAINT chk_mail_outbox_finished CHECK ((status IN ('SENT', 'FAILED', 'CANCELLED')) = (finished_at IS NOT NULL)),
    CONSTRAINT chk_mail_outbox_sent CHECK ((status = 'SENT') = (sent_at IS NOT NULL))
);

-- the worker's two lookups: due PENDING rows, and SENDING rows whose lease ran out
CREATE INDEX idx_mail_outbox_due ON "mail_outbox" ("next_attempt_at") WHERE status = 'PENDING';
CREATE INDEX idx_mail_outbox_leases ON "mail_outbox" ("locked_until") WHERE status = 'SENDING';
-- superseding older queued messages of the same kind for one user
CREATE INDEX idx_mail_outbox_user_pending ON "mail_outbox" ("user_id", "kind") WHERE status = 'PENDING';
-- retention purge of finished rows
CREATE INDEX idx_mail_outbox_finished ON "mail_outbox" ("finished_at") WHERE finished_at IS NOT NULL;
