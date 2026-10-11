-- Advertising execution and WhatsApp messaging. Additive only. Prerequisites:
-- 20261010140000_advertising_core and 20261010150000_whatsapp_core.
-- - ad_execution_steps: the per-plan ledger of external writes (idempotent resume,
--   uncertain outcomes reconciled before any new write).
-- - ad_spend_limits: per-workspace, per-currency caps; nothing spends without one.
-- - whatsapp_contacts / whatsapp_messages: opt-in contacts (numbers encrypted, keyed
--   hash for lookups) and approved outbound messages with their delivery lifecycle.
-- AlterTable
ALTER TABLE "ad_plans" ADD COLUMN     "activation_run_id" UUID,
ADD COLUMN     "activation_status" VARCHAR(20),
ADD COLUMN     "external_checked_at" TIMESTAMPTZ(3),
ADD COLUMN     "external_status" VARCHAR(20),
ADD COLUMN     "identity_external_id" VARCHAR(64);

-- CreateTable
CREATE TABLE "ad_execution_steps" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "step" VARCHAR(20) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "external_id" VARCHAR(64),
    "error_code" VARCHAR(60),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ad_execution_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_spend_limits" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "max_plan_budget_minor" BIGINT NOT NULL,
    "max_daily_budget_minor" BIGINT NOT NULL,
    "updated_by_user_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ad_spend_limits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_contacts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "phone_hash" CHAR(64) NOT NULL,
    "phone_ciphertext" TEXT NOT NULL,
    "masked_number" VARCHAR(20) NOT NULL,
    "consent_status" VARCHAR(20) NOT NULL,
    "consent_source" VARCHAR(40) NOT NULL,
    "consent_at" TIMESTAMPTZ(3) NOT NULL,
    "opted_out_at" TIMESTAMPTZ(3),
    "last_inbound_at" TIMESTAMPTZ(3),
    "added_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "phone_number_id" VARCHAR(64) NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "template_name" VARCHAR(512),
    "template_language" VARCHAR(20),
    "content" JSONB NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "external_message_id" VARCHAR(128),
    "error_code" INTEGER,
    "idempotency_key" CHAR(64) NOT NULL,
    "run_id" UUID,
    "requested_by_user_id" UUID,
    "sent_at" TIMESTAMPTZ(3),
    "status_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ad_execution_steps_workspace_id_plan_id_idx" ON "ad_execution_steps"("workspace_id", "plan_id");

-- CreateIndex
CREATE UNIQUE INDEX "ad_execution_steps_plan_id_step_key" ON "ad_execution_steps"("plan_id", "step");

-- CreateIndex
CREATE INDEX "ad_spend_limits_updated_by_user_id_idx" ON "ad_spend_limits"("updated_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "ad_spend_limits_workspace_id_currency_key" ON "ad_spend_limits"("workspace_id", "currency");

-- CreateIndex
CREATE INDEX "whatsapp_contacts_account_id_idx" ON "whatsapp_contacts"("account_id");

-- CreateIndex
CREATE INDEX "whatsapp_contacts_added_by_user_id_idx" ON "whatsapp_contacts"("added_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_contacts_workspace_id_account_id_phone_hash_key" ON "whatsapp_contacts"("workspace_id", "account_id", "phone_hash");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_messages_external_message_id_key" ON "whatsapp_messages"("external_message_id");

-- CreateIndex
CREATE INDEX "whatsapp_messages_workspace_id_created_at_idx" ON "whatsapp_messages"("workspace_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "whatsapp_messages_account_id_idx" ON "whatsapp_messages"("account_id");

-- CreateIndex
CREATE INDEX "whatsapp_messages_contact_id_idx" ON "whatsapp_messages"("contact_id");

-- CreateIndex
CREATE INDEX "whatsapp_messages_run_id_idx" ON "whatsapp_messages"("run_id");

-- CreateIndex
CREATE INDEX "whatsapp_messages_requested_by_user_id_idx" ON "whatsapp_messages"("requested_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_messages_workspace_id_idempotency_key_key" ON "whatsapp_messages"("workspace_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "ad_plans_activation_run_id_idx" ON "ad_plans"("activation_run_id");

-- AddForeignKey
ALTER TABLE "ad_plans" ADD CONSTRAINT "ad_plans_activation_run_id_fkey" FOREIGN KEY ("activation_run_id") REFERENCES "agent_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_execution_steps" ADD CONSTRAINT "ad_execution_steps_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_execution_steps" ADD CONSTRAINT "ad_execution_steps_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "ad_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_spend_limits" ADD CONSTRAINT "ad_spend_limits_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_spend_limits" ADD CONSTRAINT "ad_spend_limits_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_contacts" ADD CONSTRAINT "whatsapp_contacts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_contacts" ADD CONSTRAINT "whatsapp_contacts_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ad_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_contacts" ADD CONSTRAINT "whatsapp_contacts_added_by_user_id_fkey" FOREIGN KEY ("added_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ad_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "whatsapp_contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Closed vocabularies and sane values.
ALTER TABLE "ad_execution_steps" ADD CONSTRAINT "ad_execution_steps_check" CHECK (
  "step" IN ('media', 'campaign', 'adset', 'creative', 'ad', 'activate')
  AND "status" IN ('IN_FLIGHT', 'SUCCEEDED', 'UNCERTAIN', 'FAILED')
  AND ("status" <> 'SUCCEEDED' OR "step" = 'activate' OR "external_id" IS NOT NULL)
  AND "attempts" >= 0);
ALTER TABLE "ad_plans" ADD CONSTRAINT "ad_plans_activation_check" CHECK (
  "activation_status" IS NULL
  OR "activation_status" IN ('REQUESTED', 'ACTIVE', 'UNCERTAIN', 'FAILED'));
ALTER TABLE "ad_spend_limits" ADD CONSTRAINT "ad_spend_limits_check" CHECK (
  "currency" ~ '^[A-Z]{3}$'
  AND "max_plan_budget_minor" > 0
  AND "max_daily_budget_minor" > 0
  AND "max_daily_budget_minor" <= "max_plan_budget_minor"
  AND "version" >= 0);
ALTER TABLE "whatsapp_contacts" ADD CONSTRAINT "whatsapp_contacts_check" CHECK (
  "phone_hash" ~ '^[0-9a-f]{64}$'
  AND "consent_status" IN ('OPTED_IN', 'OPTED_OUT')
  AND ("consent_status" <> 'OPTED_OUT' OR "opted_out_at" IS NOT NULL));
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_check" CHECK (
  "kind" IN ('TEMPLATE', 'TEXT')
  AND ("kind" <> 'TEMPLATE' OR ("template_name" IS NOT NULL AND "template_language" IS NOT NULL))
  AND "status" IN ('PENDING', 'SENDING', 'UNCERTAIN', 'ACCEPTED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'CANCELLED')
  AND "idempotency_key" ~ '^[0-9a-f]{64}$');

-- Nothing moves between workspaces.
CREATE TRIGGER "ad_execution_steps_same_workspace" BEFORE INSERT OR UPDATE ON "ad_execution_steps"
  FOR EACH ROW EXECUTE FUNCTION "marketing_same_workspace_trigger"('plan_id', 'ad_plans');
CREATE TRIGGER "ad_execution_steps_workspace_immutable" BEFORE UPDATE ON "ad_execution_steps"
  FOR EACH ROW EXECUTE FUNCTION "marketing_workspace_immutable_trigger"();
CREATE TRIGGER "ad_plans_activation_same_workspace" BEFORE INSERT OR UPDATE ON "ad_plans"
  FOR EACH ROW EXECUTE FUNCTION "marketing_same_workspace_trigger"('activation_run_id', 'agent_runs');
CREATE TRIGGER "ad_spend_limits_workspace_immutable" BEFORE UPDATE ON "ad_spend_limits"
  FOR EACH ROW EXECUTE FUNCTION "marketing_workspace_immutable_trigger"();
CREATE TRIGGER "whatsapp_contacts_account" BEFORE INSERT OR UPDATE ON "whatsapp_contacts"
  FOR EACH ROW EXECUTE FUNCTION "whatsapp_account_trigger"();
CREATE TRIGGER "whatsapp_contacts_workspace_immutable" BEFORE UPDATE ON "whatsapp_contacts"
  FOR EACH ROW EXECUTE FUNCTION "marketing_workspace_immutable_trigger"();
CREATE TRIGGER "whatsapp_messages_account" BEFORE INSERT OR UPDATE ON "whatsapp_messages"
  FOR EACH ROW EXECUTE FUNCTION "whatsapp_account_trigger"();
CREATE TRIGGER "whatsapp_messages_same_workspace" BEFORE INSERT OR UPDATE ON "whatsapp_messages"
  FOR EACH ROW EXECUTE FUNCTION "marketing_same_workspace_trigger"(
    'contact_id', 'whatsapp_contacts', 'run_id', 'agent_runs');
CREATE TRIGGER "whatsapp_messages_workspace_immutable" BEFORE UPDATE ON "whatsapp_messages"
  FOR EACH ROW EXECUTE FUNCTION "marketing_workspace_immutable_trigger"();
