-- Add indexes for merchant-scoped payment listing/search.
CREATE INDEX IF NOT EXISTS "Payment_merchantId_createdAt_idx"
ON "Payment"("merchantId", "createdAt");

CREATE INDEX IF NOT EXISTS "Payment_merchantId_reference_idx"
ON "Payment"("merchantId", "reference");
