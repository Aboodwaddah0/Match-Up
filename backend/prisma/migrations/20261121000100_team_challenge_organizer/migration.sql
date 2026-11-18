-- ============================================================================
-- BIZ-02 / D19: remember who created a team challenge.
--
-- The captain of the challenging team AT CREATION becomes the match organizer when the challenge is accepted,
-- whatever happens to the captaincy in between. Additive and nullable: challenges created before this column
-- existed keep NULL and keep the old rule (the captain at acceptance); no existing row is changed.
--
-- Rollback: drop the constraint and the column (nothing else depends on them), then roll the API back.
-- ============================================================================

ALTER TABLE "team_challenge" ADD COLUMN "organizer_id" UUID;

ALTER TABLE "team_challenge" ADD CONSTRAINT "team_challenge_organizer_id_fkey" FOREIGN KEY ("organizer_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
