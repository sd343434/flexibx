-- Used TOTP codes (sign-in replay guard, src/server/auth/two-factor.ts). Additive.
-- CreateTable
CREATE TABLE "two_factor_used_codes" (
    "user_id" UUID NOT NULL,
    "code_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "two_factor_used_codes_pkey" PRIMARY KEY ("user_id","code_hash")
);

-- CreateIndex
CREATE INDEX "two_factor_used_codes_expires_at_idx" ON "two_factor_used_codes"("expires_at");

-- AddForeignKey
ALTER TABLE "two_factor_used_codes" ADD CONSTRAINT "two_factor_used_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

