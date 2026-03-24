ALTER TABLE "Payment"
ADD COLUMN "baseAmountCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "providerFeeCents" INTEGER;

UPDATE "Payment"
SET "baseAmountCents" = COALESCE(
  NULLIF("merchantNetCents", 0),
  GREATEST("amountCents" - COALESCE("platformFeeCents", 0), 0)
);
