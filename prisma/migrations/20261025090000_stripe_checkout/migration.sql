-- Card payments for credits (Stripe Checkout, test mode only; docs/runbooks/STRIPE_SANDBOX.md).
-- payment_intents mirrors each purchase Flexibx asked the provider for; payment_events
-- records every verified provider event once. Credits are granted only from a verified
-- event (src/server/billing/checkout-service.ts), once per provider payment id.

-- CreateEnum
CREATE TYPE "payment_intent_status" AS ENUM ('CREATED', 'OPEN', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'NEEDS_REVIEW');

-- CreateTable
CREATE TABLE "payment_intents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "user_id" UUID,
    "provider" VARCHAR(20) NOT NULL,
    "package_id" VARCHAR(40) NOT NULL,
    "credits" INTEGER NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "idempotency_key" VARCHAR(120) NOT NULL,
    "provider_checkout_id" VARCHAR(255),
    "provider_payment_id" VARCHAR(255),
    "status" "payment_intent_status" NOT NULL DEFAULT 'CREATED',
    "failure_code" VARCHAR(80),
    "credited_at" TIMESTAMPTZ(3),
    "refunded_minor" INTEGER NOT NULL DEFAULT 0,
    "credits_removed" INTEGER NOT NULL DEFAULT 0,
    "refund_shortfall" INTEGER NOT NULL DEFAULT 0,
    "dispute_status" VARCHAR(10),
    "expires_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_intents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider" VARCHAR(20) NOT NULL,
    "provider_event_id" VARCHAR(255) NOT NULL,
    "type" VARCHAR(80) NOT NULL,
    "workspace_id" UUID,
    "payment_intent_id" UUID,
    "livemode" BOOLEAN NOT NULL,
    "payload_sha256" VARCHAR(64) NOT NULL,
    "outcome" VARCHAR(40) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_intents_idempotency_key_key" ON "payment_intents"("idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "payment_intents_provider_checkout_id_key" ON "payment_intents"("provider_checkout_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_intents_provider_payment_id_key" ON "payment_intents"("provider_payment_id");

-- CreateIndex
CREATE INDEX "payment_intents_workspace_id_created_at_idx" ON "payment_intents"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "payment_intents_status_created_at_idx" ON "payment_intents"("status", "created_at");

-- CreateIndex
CREATE INDEX "payment_events_payment_intent_id_idx" ON "payment_events"("payment_intent_id");

-- CreateIndex
CREATE INDEX "payment_events_workspace_id_received_at_idx" ON "payment_events"("workspace_id", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_events_provider_provider_event_id_key" ON "payment_events"("provider", "provider_event_id");

-- AddForeignKey
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_payment_intent_id_fkey" FOREIGN KEY ("payment_intent_id") REFERENCES "payment_intents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Integrity (Prisma cannot express these) ──────────────────────────────────

-- Positive server-set amounts; refunds within the paid amount; a succeeded intent has its
-- provider payment id and credit time; dispute status from a fixed set.
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_check" CHECK (
  "credits" > 0 AND "amount_minor" > 0
  AND "currency" ~ '^[a-z]{3}$'
  AND "provider" ~ '^[a-z]{2,20}$'
  AND "refunded_minor" >= 0 AND "refunded_minor" <= "amount_minor"
  AND "credits_removed" >= 0 AND "credits_removed" <= "credits"
  AND "refund_shortfall" >= 0 AND "refund_shortfall" <= "credits"
  AND ("dispute_status" IS NULL OR "dispute_status" IN ('OPEN', 'WON', 'LOST'))
  AND ("status" <> 'SUCCEEDED' OR ("credited_at" IS NOT NULL AND "provider_payment_id" IS NOT NULL))
  AND (("credited_at" IS NULL) OR "status" IN ('SUCCEEDED', 'NEEDS_REVIEW'))
);
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_check" CHECK (
  "provider" ~ '^[a-z]{2,20}$' AND "payload_sha256" ~ '^[0-9a-f]{64}$'
  AND ("payment_intent_id" IS NULL OR "workspace_id" IS NOT NULL)
);

-- What was sold never changes after the intent is created: workspace, package, credits,
-- amount, currency, provider and idempotency key. Provider ids are set once. Credits
-- granted stay granted (credited_at is never cleared).
CREATE FUNCTION "payment_intent_immutable_trigger"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."workspace_id" IS DISTINCT FROM OLD."workspace_id"
    OR NEW."package_id" IS DISTINCT FROM OLD."package_id"
    OR NEW."credits" IS DISTINCT FROM OLD."credits"
    OR NEW."amount_minor" IS DISTINCT FROM OLD."amount_minor"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."provider" IS DISTINCT FROM OLD."provider"
    OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
    OR (OLD."provider_checkout_id" IS NOT NULL
        AND NEW."provider_checkout_id" IS DISTINCT FROM OLD."provider_checkout_id")
    OR (OLD."provider_payment_id" IS NOT NULL
        AND NEW."provider_payment_id" IS DISTINCT FROM OLD."provider_payment_id")
    OR (OLD."credited_at" IS NOT NULL AND NEW."credited_at" IS DISTINCT FROM OLD."credited_at")
    OR NEW."refunded_minor" < OLD."refunded_minor"
    OR NEW."credits_removed" < OLD."credits_removed"
  THEN
    RAISE EXCEPTION 'payment_intents: sold terms, provider ids and grants are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "payment_intents_immutable" BEFORE UPDATE ON "payment_intents"
  FOR EACH ROW EXECUTE FUNCTION "payment_intent_immutable_trigger"();

-- Processed provider events are history: never updated or deleted.
CREATE FUNCTION "payment_events_append_only_trigger"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'payment_events is append-only' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER "payment_events_append_only" BEFORE UPDATE OR DELETE ON "payment_events"
  FOR EACH ROW EXECUTE FUNCTION "payment_events_append_only_trigger"();

-- An event linked to an intent carries the intent's workspace.
CREATE FUNCTION "payment_events_same_workspace_trigger"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."payment_intent_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "payment_intents" i
    WHERE i."id" = NEW."payment_intent_id" AND i."workspace_id" = NEW."workspace_id"
  ) THEN
    RAISE EXCEPTION 'payment_events: payment intent of another workspace'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "payment_events_same_workspace" BEFORE INSERT ON "payment_events"
  FOR EACH ROW EXECUTE FUNCTION "payment_events_same_workspace_trigger"();
