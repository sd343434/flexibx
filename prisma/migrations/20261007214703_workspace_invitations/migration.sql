-- CreateTable
CREATE TABLE "workspace_invitations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "email" CITEXT NOT NULL,
    "role" "workspace_role" NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "invited_by_user_id" UUID,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "accepted_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workspace_invitations_token_hash_key" ON "workspace_invitations"("token_hash");

-- CreateIndex
CREATE INDEX "workspace_invitations_workspace_id_created_at_idx" ON "workspace_invitations"("workspace_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "workspace_invitations_invited_by_user_id_idx" ON "workspace_invitations"("invited_by_user_id");

-- AddForeignKey
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_invited_by_user_id_fkey" FOREIGN KEY ("invited_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Invitation rules Prisma cannot express ──

-- At most one pending (not accepted, not revoked) invitation per workspace and email.
-- Expired-but-pending rows are removed by the application before a new invitation.
CREATE UNIQUE INDEX "workspace_invitations_pending_email_key"
  ON "workspace_invitations" ("workspace_id", "email")
  WHERE "accepted_at" IS NULL AND "revoked_at" IS NULL;

-- Ownership is never granted by invitation (no ownership transfer).
ALTER TABLE "workspace_invitations"
  ADD CONSTRAINT "workspace_invitations_role_not_owner_check"
  CHECK ("role" <> 'OWNER');

-- SHA-256 as 64 lowercase hex characters: the plaintext token can never be stored here.
ALTER TABLE "workspace_invitations"
  ADD CONSTRAINT "workspace_invitations_token_hash_check"
  CHECK ("token_hash" ~ '^[0-9a-f]{64}$');

-- An invitation ends exactly once: accepted or revoked, never both.
ALTER TABLE "workspace_invitations"
  ADD CONSTRAINT "workspace_invitations_single_outcome_check"
  CHECK ("accepted_at" IS NULL OR "revoked_at" IS NULL);

-- Expiry is after creation.
ALTER TABLE "workspace_invitations"
  ADD CONSTRAINT "workspace_invitations_expiry_check"
  CHECK ("expires_at" > "created_at");
