import { encryptStoredSecret, isEncryptedSecret } from './secrets';

export const MERCHANT_SECRET_FIELDS = [
  'payfastMerchantKey',
  'payfastPassphrase',
  'ozowPrivateKey',
  'ozowApiKey',
  'yocoSecretKey',
  'yocoWebhookSecret',
  'paystackSecretKey',
] as const;

export type MerchantSecretField = (typeof MERCHANT_SECRET_FIELDS)[number];

export type MerchantSecretRecord = {
  id: string;
} & Record<MerchantSecretField, string | null>;

export type MerchantSecretBackupEntry = {
  merchantId: string;
  fields: Partial<Record<MerchantSecretField, string>>;
};

function trimToNull(value: string | null | undefined) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function getPlaintextMerchantSecretFields(
  merchant: MerchantSecretRecord,
) {
  return MERCHANT_SECRET_FIELDS.filter((field) => {
    const value = trimToNull(merchant[field]);
    return Boolean(value) && !isEncryptedSecret(value);
  });
}

export function buildMerchantSecretBackupEntry(
  merchant: MerchantSecretRecord,
): MerchantSecretBackupEntry | null {
  const fields = getPlaintextMerchantSecretFields(merchant);
  if (!fields.length) {
    return null;
  }

  return {
    merchantId: merchant.id,
    fields: Object.fromEntries(
      fields.map((field) => [field, trimToNull(merchant[field])]),
    ) as Partial<Record<MerchantSecretField, string>>,
  };
}

export function buildEncryptedMerchantSecretUpdate(
  merchant: MerchantSecretRecord,
) {
  const backup = buildMerchantSecretBackupEntry(merchant);
  if (!backup) {
    return null;
  }

  return {
    merchantId: merchant.id,
    fields: Object.keys(backup.fields) as MerchantSecretField[],
    data: Object.fromEntries(
      Object.entries(backup.fields).map(([field, value]) => [
        field,
        encryptStoredSecret(value),
      ]),
    ) as Record<MerchantSecretField, string | null>,
    backup,
  };
}
