-- Add merchant-scoped PayFast credentials for multi-merchant configuration.
ALTER TABLE "Merchant"
ADD COLUMN "payfastMerchantId" TEXT,
ADD COLUMN "payfastMerchantKey" TEXT,
ADD COLUMN "payfastPassphrase" TEXT;
