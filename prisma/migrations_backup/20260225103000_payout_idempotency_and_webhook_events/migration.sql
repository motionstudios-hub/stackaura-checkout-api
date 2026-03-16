-- Add payout idempotency storage
ALTER TABLE "Payout"
ADD COLUMN "idempotencyKey" TEXT;

-- Move payout status enum from CREATED/PROCESSING/PAID/FAILED/CANCELLED
-- to CREATED/PENDING/SUCCESS/FAILED.
CREATE TYPE "PayoutStatus_new" AS ENUM ('CREATED', 'PENDING', 'SUCCESS', 'FAILED');
ALTER TABLE "Payout" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Payout"
ALTER COLUMN "status" TYPE "PayoutStatus_new"
USING (
  CASE
    WHEN "status"::text = 'PROCESSING' THEN 'PENDING'::"PayoutStatus_new"
    WHEN "status"::text = 'PAID' THEN 'SUCCESS'::"PayoutStatus_new"
    WHEN "status"::text = 'CANCELLED' THEN 'FAILED'::"PayoutStatus_new"
    ELSE "status"::text::"PayoutStatus_new"
  END
);

ALTER TYPE "PayoutStatus" RENAME TO "PayoutStatus_old";
ALTER TYPE "PayoutStatus_new" RENAME TO "PayoutStatus";
DROP TYPE "PayoutStatus_old";

ALTER TABLE "Payout" ALTER COLUMN "status" SET DEFAULT 'CREATED';

CREATE UNIQUE INDEX "Payout_merchantId_idempotencyKey_key"
ON "Payout"("merchantId", "idempotencyKey");

-- Store inbound provider webhook events for idempotent processing.
CREATE TABLE "WebhookEvent" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "provider" TEXT NOT NULL,
  "providerEventId" TEXT NOT NULL,
  "eventType" TEXT,
  "payoutReference" TEXT,
  "payload" JSONB NOT NULL,
  "signature" TEXT,
  "processedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WebhookEvent_provider_providerEventId_key"
ON "WebhookEvent"("provider", "providerEventId");

CREATE INDEX "WebhookEvent_payoutReference_idx"
ON "WebhookEvent"("payoutReference");

CREATE INDEX "WebhookEvent_processedAt_idx"
ON "WebhookEvent"("processedAt");

