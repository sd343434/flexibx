-- Execution hardening: the Facebook Page chosen for a plan, WhatsApp marketing opt-outs
-- (separate from a full opt-out), an append-only consent history, and the release of a
-- message whose outcome is unknown by an owner or admin.

-- AlterTable
ALTER TABLE "ad_plans" ADD COLUMN     "identity_checked_at" TIMESTAMPTZ(3),
ADD COLUMN     "identity_name" VARCHAR(200),
ADD COLUMN     "identity_options" JSONB;

-- AlterTable
ALTER TABLE "whatsapp_contacts" ADD COLUMN     "marketing_opt_out_source" VARCHAR(40),
ADD COLUMN     "marketing_opted_out_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "whatsapp_messages" ADD COLUMN     "resolved_at" TIMESTAMPTZ(3),
ADD COLUMN     "resolved_by_user_id" UUID;

-- CreateTable
CREATE TABLE "whatsapp_consent_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "kind" VARCHAR(30) NOT NULL,
    "source" VARCHAR(40) NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "actor_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_consent_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "whatsapp_consent_events_workspace_id_contact_id_occurred_at_idx" ON "whatsapp_consent_events"("workspace_id", "contact_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "whatsapp_consent_events_contact_id_idx" ON "whatsapp_consent_events"("contact_id");

-- CreateIndex
CREATE INDEX "whatsapp_consent_events_actor_user_id_idx" ON "whatsapp_consent_events"("actor_user_id");

-- CreateIndex
CREATE INDEX "whatsapp_messages_resolved_by_user_id_idx" ON "whatsapp_messages"("resolved_by_user_id");

-- AddForeignKey
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_resolved_by_user_id_fkey" FOREIGN KEY ("resolved_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_consent_events" ADD CONSTRAINT "whatsapp_consent_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_consent_events" ADD CONSTRAINT "whatsapp_consent_events_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "whatsapp_contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_consent_events" ADD CONSTRAINT "whatsapp_consent_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Closed vocabularies.
ALTER TABLE "whatsapp_consent_events" ADD CONSTRAINT "whatsapp_consent_events_check" CHECK (
  "kind" IN ('OPTED_IN', 'OPTED_OUT', 'MARKETING_OPTED_OUT', 'MARKETING_RESUMED')
  AND "source" ~ '^[a-z0-9_]{1,40}$');
ALTER TABLE "whatsapp_contacts" ADD CONSTRAINT "whatsapp_contacts_marketing_check" CHECK (
  ("marketing_opted_out_at" IS NULL) = ("marketing_opt_out_source" IS NULL));
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_resolution_check" CHECK (
  "resolved_at" IS NULL OR "status" IN ('UNCERTAIN', 'SENDING'));
ALTER TABLE "ad_plans" ADD CONSTRAINT "ad_plans_identity_check" CHECK (
  "identity_options" IS NULL OR jsonb_typeof("identity_options") = 'array');

-- Webhook events now also record marketing-preference changes (user_preferences).
ALTER TABLE "whatsapp_webhook_events" DROP CONSTRAINT "whatsapp_webhook_events_check";
ALTER TABLE "whatsapp_webhook_events" ADD CONSTRAINT "whatsapp_webhook_events_check" CHECK (
  "event_hash" ~ '^[0-9a-f]{64}$'
  AND "kind" IN ('status', 'message', 'preference')
  AND "status" IN ('sent', 'delivered', 'read', 'failed', 'received', 'other',
                   'marketing_stop', 'marketing_resume')
  AND "phone_number_id" ~ '^[0-9A-Za-z_-]{1,64}$');

-- Consent history is append-only and stays inside its workspace.
CREATE FUNCTION "whatsapp_consent_events_append_only"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'whatsapp_consent_events is append-only' USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER "whatsapp_consent_events_no_update" BEFORE UPDATE ON "whatsapp_consent_events"
  FOR EACH ROW EXECUTE FUNCTION "whatsapp_consent_events_append_only"();
CREATE TRIGGER "whatsapp_consent_events_same_workspace" BEFORE INSERT ON "whatsapp_consent_events"
  FOR EACH ROW EXECUTE FUNCTION "marketing_same_workspace_trigger"('contact_id', 'whatsapp_contacts');
