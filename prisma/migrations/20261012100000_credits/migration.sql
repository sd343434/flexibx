-- CreateEnum
CREATE TYPE "credit_entry_kind" AS ENUM ('SUBSCRIPTION_GRANT', 'SUBSCRIPTION_EXPIRE', 'PURCHASE', 'AUTO_RECHARGE', 'ADJUSTMENT', 'HOLD', 'CAPTURE', 'RELEASE');
-- CreateEnum
CREATE TYPE "credit_hold_status" AS ENUM ('HELD', 'CAPTURED', 'RELEASED');
-- CreateEnum
CREATE TYPE "credit_recharge_status" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');
-- CreateTable
CREATE TABLE "credit_accounts" (
    "workspace_id" UUID NOT NULL,
    "plan_code" VARCHAR(40) NOT NULL,
    "period_start" TIMESTAMPTZ(3) NOT NULL,
    "period_end" TIMESTAMPTZ(3) NOT NULL,
    "subscription_credits" INTEGER NOT NULL,
    "purchased_credits" INTEGER NOT NULL,
    "held_credits" INTEGER NOT NULL DEFAULT 0,
    "daily_cap" INTEGER,
    "period_cap" INTEGER,
    "feature_caps" JSONB NOT NULL DEFAULT '{}',
    "auto_recharge_enabled" BOOLEAN NOT NULL DEFAULT false,
    "auto_recharge_threshold" INTEGER,
    "auto_recharge_amount" INTEGER,
    "auto_recharge_period_max" INTEGER,
    "updated_by_user_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "credit_accounts_pkey" PRIMARY KEY ("workspace_id")
);
-- CreateTable
CREATE TABLE "credit_holds" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "feature" VARCHAR(40) NOT NULL,
    "amount" INTEGER NOT NULL,
    "subscription_portion" INTEGER NOT NULL,
    "purchased_portion" INTEGER NOT NULL,
    "status" "credit_hold_status" NOT NULL DEFAULT 'HELD',
    "captured_amount" INTEGER,
    "idempotency_key" VARCHAR(160) NOT NULL,
    "reference" VARCHAR(160),
    "price_version" VARCHAR(40) NOT NULL,
    "user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settled_at" TIMESTAMPTZ(3),
    CONSTRAINT "credit_holds_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "credit_ledger_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sequence" BIGSERIAL NOT NULL,
    "workspace_id" UUID NOT NULL,
    "kind" "credit_entry_kind" NOT NULL,
    "amount" INTEGER NOT NULL,
    "subscription_after" INTEGER NOT NULL,
    "purchased_after" INTEGER NOT NULL,
    "held_after" INTEGER NOT NULL,
    "hold_id" UUID,
    "feature" VARCHAR(40),
    "provider" VARCHAR(40),
    "model" VARCHAR(120),
    "provider_cost_micros" BIGINT,
    "actor_user_id" UUID,
    "external_ref" VARCHAR(160),
    "request_key" VARCHAR(80),
    "note" VARCHAR(300),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "credit_ledger_entries_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "credit_recharges" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" "credit_recharge_status" NOT NULL DEFAULT 'PENDING',
    "idempotency_key" VARCHAR(160) NOT NULL,
    "provider" VARCHAR(40),
    "external_ref" VARCHAR(160),
    "failure_code" VARCHAR(60),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settled_at" TIMESTAMPTZ(3),
    CONSTRAINT "credit_recharges_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "credit_holds_workspace_id_created_at_idx" ON "credit_holds"("workspace_id", "created_at");
-- CreateIndex
CREATE INDEX "credit_holds_workspace_id_status_idx" ON "credit_holds"("workspace_id", "status");
-- CreateIndex
CREATE UNIQUE INDEX "credit_holds_workspace_id_idempotency_key_key" ON "credit_holds"("workspace_id", "idempotency_key");
-- CreateIndex
CREATE UNIQUE INDEX "credit_ledger_entries_sequence_key" ON "credit_ledger_entries"("sequence");
-- CreateIndex
CREATE UNIQUE INDEX "credit_ledger_entries_workspace_id_request_key_key" ON "credit_ledger_entries"("workspace_id", "request_key");
-- CreateIndex
CREATE INDEX "credit_ledger_entries_workspace_id_sequence_idx" ON "credit_ledger_entries"("workspace_id", "sequence" DESC);
-- CreateIndex
CREATE INDEX "credit_ledger_entries_hold_id_idx" ON "credit_ledger_entries"("hold_id");
-- CreateIndex
CREATE INDEX "credit_recharges_workspace_id_created_at_idx" ON "credit_recharges"("workspace_id", "created_at");
-- CreateIndex
CREATE UNIQUE INDEX "credit_recharges_workspace_id_idempotency_key_key" ON "credit_recharges"("workspace_id", "idempotency_key");
-- AddForeignKey
ALTER TABLE "credit_accounts" ADD CONSTRAINT "credit_accounts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "credit_holds" ADD CONSTRAINT "credit_holds_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "credit_ledger_entries" ADD CONSTRAINT "credit_ledger_entries_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "credit_ledger_entries" ADD CONSTRAINT "credit_ledger_entries_hold_id_fkey" FOREIGN KEY ("hold_id") REFERENCES "credit_holds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "credit_recharges" ADD CONSTRAINT "credit_recharges_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Integrity (Prisma cannot express these) ──────────────────────────────────

-- Balances never go negative; caps and top-up settings are positive when set.
ALTER TABLE "credit_accounts" ADD CONSTRAINT "credit_accounts_balances_check" CHECK (
  "subscription_credits" >= 0 AND "purchased_credits" >= 0 AND "held_credits" >= 0
  AND ("daily_cap" IS NULL OR "daily_cap" > 0)
  AND ("period_cap" IS NULL OR "period_cap" > 0)
  AND ("auto_recharge_threshold" IS NULL OR "auto_recharge_threshold" >= 0)
  AND ("auto_recharge_amount" IS NULL OR "auto_recharge_amount" > 0)
  AND ("auto_recharge_period_max" IS NULL OR "auto_recharge_period_max" > 0)
  AND "period_end" > "period_start"
  AND jsonb_typeof("feature_caps") = 'object'
);
-- Automatic top-up needs all three settings.
ALTER TABLE "credit_accounts" ADD CONSTRAINT "credit_accounts_auto_recharge_check" CHECK (
  NOT "auto_recharge_enabled" OR (
    "auto_recharge_threshold" IS NOT NULL AND "auto_recharge_amount" IS NOT NULL
    AND "auto_recharge_period_max" IS NOT NULL
    AND "auto_recharge_amount" <= "auto_recharge_period_max"
  )
);
-- A hold is positive, split exactly, and captured at most in full; settled iff not HELD.
ALTER TABLE "credit_holds" ADD CONSTRAINT "credit_holds_amount_check" CHECK (
  "amount" > 0 AND "subscription_portion" >= 0 AND "purchased_portion" >= 0
  AND "subscription_portion" + "purchased_portion" = "amount"
  AND ("captured_amount" IS NULL OR ("captured_amount" >= 0 AND "captured_amount" <= "amount"))
  AND (("status" = 'CAPTURED') = ("captured_amount" IS NOT NULL))
  AND (("status" = 'HELD') = ("settled_at" IS NULL))
);
ALTER TABLE "credit_ledger_entries" ADD CONSTRAINT "credit_ledger_entries_check" CHECK (
  "subscription_after" >= 0 AND "purchased_after" >= 0 AND "held_after" >= 0
  AND ("kind" NOT IN ('HOLD', 'CAPTURE', 'RELEASE') OR "hold_id" IS NOT NULL)
);
ALTER TABLE "credit_recharges" ADD CONSTRAINT "credit_recharges_check" CHECK (
  "amount" > 0 AND (("status" = 'PENDING') = ("settled_at" IS NULL))
);

-- A hold is settled once: HELD → CAPTURED or RELEASED, never back, amount fixed.
CREATE FUNCTION "credit_hold_transition_trigger"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'HELD' THEN
    RAISE EXCEPTION 'credit hold % is already settled', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."amount" <> OLD."amount" OR NEW."subscription_portion" <> OLD."subscription_portion"
     OR NEW."purchased_portion" <> OLD."purchased_portion"
     OR NEW."idempotency_key" <> OLD."idempotency_key" THEN
    RAISE EXCEPTION 'credit hold amounts are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "credit_holds_transition" BEFORE UPDATE ON "credit_holds"
  FOR EACH ROW EXECUTE FUNCTION "credit_hold_transition_trigger"();

-- The ledger is append-only.
CREATE FUNCTION "credit_ledger_append_only_trigger"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'credit_ledger_entries is append-only' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER "credit_ledger_entries_append_only" BEFORE UPDATE ON "credit_ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION "credit_ledger_append_only_trigger"();

-- Same workspace for linked rows; workspace never changes.
CREATE TRIGGER "credit_ledger_entries_same_workspace" BEFORE INSERT ON "credit_ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION "marketing_same_workspace_trigger"('hold_id', 'credit_holds');
CREATE TRIGGER "credit_holds_workspace_immutable" BEFORE UPDATE ON "credit_holds"
  FOR EACH ROW EXECUTE FUNCTION "marketing_workspace_immutable_trigger"();
CREATE TRIGGER "credit_recharges_workspace_immutable" BEFORE UPDATE ON "credit_recharges"
  FOR EACH ROW EXECUTE FUNCTION "marketing_workspace_immutable_trigger"();
