-- WhatsApp Business (first slice): the last read of each connected WhatsApp Business
-- account (masked business numbers, templates) and verified webhook events recorded once
-- per workspace. Additive only. Prerequisite: 20261010140000_advertising_core (the WABA
-- itself is an ad_accounts row on platform WHATSAPP). No phone numbers of customers,
-- message ids or message contents are stored anywhere.

-- CreateTable
CREATE TABLE "whatsapp_snapshots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "phone_numbers" JSONB NOT NULL,
    "templates" JSONB NOT NULL,
    "fetched_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_webhook_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "event_hash" CHAR(64) NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "phone_number_id" VARCHAR(64) NOT NULL,
    "error_code" INTEGER,
    "event_at" TIMESTAMPTZ(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_snapshots_account_id_key" ON "whatsapp_snapshots"("account_id");

-- CreateIndex
CREATE INDEX "whatsapp_snapshots_workspace_id_idx" ON "whatsapp_snapshots"("workspace_id");

-- CreateIndex
CREATE INDEX "whatsapp_webhook_events_workspace_id_account_id_event_at_idx" ON "whatsapp_webhook_events"("workspace_id", "account_id", "event_at" DESC);

-- CreateIndex
CREATE INDEX "whatsapp_webhook_events_account_id_idx" ON "whatsapp_webhook_events"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_webhook_events_workspace_id_event_hash_key" ON "whatsapp_webhook_events"("workspace_id", "event_hash");

-- AddForeignKey
ALTER TABLE "whatsapp_snapshots" ADD CONSTRAINT "whatsapp_snapshots_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_snapshots" ADD CONSTRAINT "whatsapp_snapshots_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ad_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_webhook_events" ADD CONSTRAINT "whatsapp_webhook_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_webhook_events" ADD CONSTRAINT "whatsapp_webhook_events_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ad_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Snapshots and events belong to a WhatsApp account of their own workspace.
CREATE FUNCTION "whatsapp_account_trigger"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "ad_accounts" a WHERE a."id" = NEW."account_id"
                   AND a."workspace_id" = NEW."workspace_id" AND a."platform" = 'WHATSAPP') THEN
    RAISE EXCEPTION '% must reference a WhatsApp account of its workspace', TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "whatsapp_snapshots_account" BEFORE INSERT OR UPDATE ON "whatsapp_snapshots"
  FOR EACH ROW EXECUTE FUNCTION "whatsapp_account_trigger"();
CREATE TRIGGER "whatsapp_webhook_events_account" BEFORE INSERT OR UPDATE ON "whatsapp_webhook_events"
  FOR EACH ROW EXECUTE FUNCTION "whatsapp_account_trigger"();
CREATE TRIGGER "whatsapp_snapshots_workspace_immutable" BEFORE UPDATE ON "whatsapp_snapshots"
  FOR EACH ROW EXECUTE FUNCTION "marketing_workspace_immutable_trigger"();

-- Events are append-only facts with a closed vocabulary.
ALTER TABLE "whatsapp_webhook_events" ADD CONSTRAINT "whatsapp_webhook_events_check" CHECK (
  "event_hash" ~ '^[0-9a-f]{64}$'
  AND "kind" IN ('status', 'message')
  AND "status" IN ('sent', 'delivered', 'read', 'failed', 'received', 'other')
  AND "phone_number_id" ~ '^[0-9A-Za-z_-]{1,64}$');
CREATE FUNCTION "whatsapp_webhook_events_append_only"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'whatsapp_webhook_events is append-only' USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER "whatsapp_webhook_events_no_update" BEFORE UPDATE ON "whatsapp_webhook_events"
  FOR EACH ROW EXECUTE FUNCTION "whatsapp_webhook_events_append_only"();
