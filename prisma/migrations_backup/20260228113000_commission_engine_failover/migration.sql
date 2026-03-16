ALTER TABLE "Merchant"
ADD COLUMN "platformFeeBps" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "platformFeeFixedCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "gatewayOrder" JSONB NOT NULL DEFAULT '["OZOW","PAYFAST"]';

ALTER TABLE "Payment"
ADD COLUMN "platformFeeCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "merchantNetCents" INTEGER NOT NULL DEFAULT 0;

UPDATE "Payment"
SET "merchantNetCents" = "amountCents"
WHERE "merchantNetCents" = 0;

CREATE TABLE "PaymentAttempt" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "paymentId" TEXT NOT NULL,
  "gateway" "GatewayProvider" NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'CREATED',
  "redirectUrl" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PaymentAttempt_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "PaymentAttempt"
ADD CONSTRAINT "PaymentAttempt_paymentId_fkey"
FOREIGN KEY ("paymentId") REFERENCES "Payment"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "PaymentAttempt_paymentId_createdAt_idx"
ON "PaymentAttempt"("paymentId", "createdAt" DESC);
