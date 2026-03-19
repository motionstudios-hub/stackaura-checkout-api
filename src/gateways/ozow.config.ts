import { createHash } from 'crypto';

export const OZOW_PAYMENT_URL = 'https://pay.ozow.com';
export const OZOW_API_BASE_URL = 'https://api.ozow.com';
export const OZOW_SUCCESS_URL = 'https://stackaura.co.za/payments/success';
export const OZOW_CANCEL_URL = 'https://stackaura.co.za/payments/cancel';
export const OZOW_ERROR_URL = 'https://stackaura.co.za/payments/error';
export const OZOW_NOTIFY_URL = 'https://api.stackaura.co.za/webhooks/ozow';

export const OZOW_REQUEST_HASH_FIELDS = [
  'SiteCode',
  'CountryCode',
  'CurrencyCode',
  'Amount',
  'TransactionReference',
  'BankReference',
  'Optional1',
  'Optional2',
  'Optional3',
  'Optional4',
  'Optional5',
  'Customer',
  'CancelUrl',
  'ErrorUrl',
  'SuccessUrl',
  'NotifyUrl',
  'IsTest',
] as const;

export const OZOW_RESPONSE_HASH_FIELDS = [
  'SiteCode',
  'TransactionId',
  'TransactionReference',
  'Amount',
  'Status',
  'Optional1',
  'Optional2',
  'Optional3',
  'Optional4',
  'Optional5',
  'CurrencyCode',
  'IsTest',
  'StatusMessage',
] as const;

export type OzowConfigSource = {
  ozowSiteCode?: string | null;
  ozowPrivateKey?: string | null;
  ozowApiKey?: string | null;
  ozowIsTest?: boolean | null;
};

export type OzowConfigOrigin = 'merchant' | 'env';
export type OzowConfigModeSource = OzowConfigOrigin | 'default';

export type ResolvedOzowConfig = {
  siteCode: string | null;
  privateKey: string | null;
  apiKey: string | null;
  isTest: boolean;
  paymentUrl: string;
  apiBaseUrl: string;
  successUrl: string;
  cancelUrl: string;
  errorUrl: string;
  notifyUrl: string;
  source: OzowConfigOrigin;
  modeSource: OzowConfigModeSource;
  hasPartialMerchantConfig: boolean;
};

export type OzowRedirectForm = {
  action: string;
  method: 'POST';
  fields: Record<string, string>;
};

export type OzowHashMaterial = {
  orderedFields: Array<{ key: string; value: string }>;
  hashInput: string;
  hashCheck: string;
};

type BuildOzowPaymentFormArgs = {
  siteCode: string | null;
  privateKey: string | null;
  reference: string;
  amountCents: number;
  currency: string;
  bankReference?: string | null;
  customer?: string | null;
  optional1?: string | null;
  optional2?: string | null;
  optional3?: string | null;
  optional4?: string | null;
  optional5?: string | null;
  successUrl?: string | null;
  cancelUrl?: string | null;
  errorUrl?: string | null;
  notifyUrl?: string | null;
  isTest: boolean;
};

type NormalizedOzowConfigValues = {
  siteCode: string | null;
  privateKey: string | null;
  apiKey: string | null;
  isTest: boolean | null;
};

const trimToNull = (value: unknown) =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

function parseBooleanEnv(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return null;
}

function normalizeOzowConfigValues(
  source: OzowConfigSource = {},
): NormalizedOzowConfigValues {
  return {
    siteCode: trimToNull(source.ozowSiteCode),
    privateKey: trimToNull(source.ozowPrivateKey),
    apiKey: trimToNull(source.ozowApiKey),
    isTest: typeof source.ozowIsTest === 'boolean' ? source.ozowIsTest : null,
  };
}

function currentEnvOzowConfig(): NormalizedOzowConfigValues {
  return {
    siteCode: trimToNull(process.env.OZOW_SITE_CODE),
    privateKey: trimToNull(process.env.OZOW_PRIVATE_KEY),
    apiKey: trimToNull(process.env.OZOW_API_KEY),
    isTest: parseBooleanEnv(process.env.OZOW_TEST_MODE),
  };
}

function hasAnyMerchantValue(config: NormalizedOzowConfigValues) {
  return Boolean(
    config.siteCode ||
      config.privateKey ||
      config.apiKey ||
      config.isTest !== null,
  );
}

function hasAnyMerchantCredential(config: NormalizedOzowConfigValues) {
  return Boolean(config.siteCode || config.privateKey || config.apiKey);
}

export function parseOzowTestMode(value: string | boolean | null | undefined) {
  if (typeof value === 'boolean') return value;

  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;

  return process.env.NODE_ENV !== 'production';
}

export function resolveOzowConfig(
  source: OzowConfigSource = {},
): ResolvedOzowConfig {
  const merchantValues = normalizeOzowConfigValues(source);
  const envValues = currentEnvOzowConfig();
  const sourceValues = hasAnyMerchantValue(merchantValues)
    ? merchantValues
    : envValues;
  const sourceOrigin: OzowConfigOrigin = hasAnyMerchantValue(merchantValues)
    ? 'merchant'
    : 'env';
  const modeValue =
    sourceOrigin === 'merchant' ? merchantValues.isTest : envValues.isTest;

  return {
    siteCode: sourceValues.siteCode,
    privateKey: sourceValues.privateKey,
    apiKey: sourceValues.apiKey,
    isTest: parseOzowTestMode(modeValue),
    paymentUrl: OZOW_PAYMENT_URL,
    apiBaseUrl: OZOW_API_BASE_URL,
    successUrl: OZOW_SUCCESS_URL,
    cancelUrl: OZOW_CANCEL_URL,
    errorUrl: OZOW_ERROR_URL,
    notifyUrl: OZOW_NOTIFY_URL,
    source: sourceOrigin,
    modeSource:
      modeValue !== null
        ? sourceOrigin
        : sourceOrigin === 'env' && envValues.isTest !== null
          ? 'env'
          : 'default',
    hasPartialMerchantConfig:
      hasAnyMerchantCredential(merchantValues) &&
      (!merchantValues.siteCode || !merchantValues.privateKey),
  };
}

export function hasOzowCredentials(
  source: OzowConfigSource | ResolvedOzowConfig,
) {
  const siteCode =
    'siteCode' in source ? source.siteCode : (source.ozowSiteCode ?? null);
  const privateKey =
    'privateKey' in source
      ? source.privateKey
      : (source.ozowPrivateKey ?? null);

  return Boolean(trimToNull(siteCode)) && Boolean(trimToNull(privateKey));
}

export function resolveOzowRedirectUrl(
  candidate: string | null | undefined,
  fallback: string,
  label: 'successUrl' | 'cancelUrl' | 'errorUrl' | 'notifyUrl',
) {
  const resolved = trimToNull(candidate) ?? fallback;

  let parsed: URL;
  try {
    parsed = new URL(resolved);
  } catch {
    throw new Error(`Ozow ${label} must be an absolute HTTPS URL`);
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(`Ozow ${label} must be an absolute HTTPS URL`);
  }

  return parsed.toString();
}

export function resolveOzowRedirectUrls(args: {
  successUrl?: string | null;
  cancelUrl?: string | null;
  errorUrl?: string | null;
  notifyUrl?: string | null;
}) {
  return {
    successUrl: resolveOzowRedirectUrl(
      args.successUrl,
      OZOW_SUCCESS_URL,
      'successUrl',
    ),
    cancelUrl: resolveOzowRedirectUrl(
      args.cancelUrl,
      OZOW_CANCEL_URL,
      'cancelUrl',
    ),
    errorUrl: resolveOzowRedirectUrl(
      args.errorUrl,
      OZOW_ERROR_URL,
      'errorUrl',
    ),
    notifyUrl: resolveOzowRedirectUrl(
      args.notifyUrl,
      OZOW_NOTIFY_URL,
      'notifyUrl',
    ),
  };
}

export function deriveOzowBankReference(
  reference: string,
  explicitBankReference?: string | null,
) {
  const bankReference = trimToNull(explicitBankReference);
  if (bankReference) {
    return bankReference.toUpperCase().slice(0, 20);
  }

  return normalizeOzowTransactionReference(reference).slice(0, 20);
}

export function normalizeOzowTransactionReference(reference: string) {
  const normalized = reference.trim().toUpperCase();
  if (!normalized) {
    throw new Error('Ozow transaction reference is required');
  }

  return normalized;
}

export function computeOzowHashCheck(
  fields: Record<string, string>,
  privateKey: string | null | undefined,
  orderedKeys: readonly string[],
) {
  return buildOzowHashMaterial(fields, privateKey, orderedKeys).hashCheck;
}

export function buildOzowHashMaterial(
  fields: Record<string, string>,
  privateKey: string | null | undefined,
  orderedKeys: readonly string[],
): OzowHashMaterial {
  const normalizedPrivateKey = trimToNull(privateKey);
  if (!normalizedPrivateKey) {
    throw new Error('Ozow private key is required');
  }

  const orderedFields = orderedKeys.flatMap((key) => {
    const value = fields[key];
    if (typeof value !== 'string' || value.length === 0) {
      return [];
    }

    return [{ key, value }];
  });
  const hashInput = orderedFields.map((field) => field.value).join('');

  return {
    orderedFields,
    hashInput,
    hashCheck: createHash('sha512')
      .update(`${hashInput}${normalizedPrivateKey}`.toLowerCase(), 'utf8')
      .digest('hex'),
  };
}

export function buildOzowPaymentForm(
  args: BuildOzowPaymentFormArgs,
): OzowRedirectForm {
  const siteCode = trimToNull(args.siteCode);
  if (!siteCode) {
    throw new Error('Ozow site code is required');
  }

  const currencyCode = args.currency.trim().toUpperCase();
  if (currencyCode !== 'ZAR') {
    throw new Error('Ozow currently supports ZAR only');
  }

  const redirectUrls = resolveOzowRedirectUrls({
    successUrl: args.successUrl,
    cancelUrl: args.cancelUrl,
    errorUrl: args.errorUrl,
    notifyUrl: args.notifyUrl,
  });
  const transactionReference = normalizeOzowTransactionReference(args.reference);

  const fieldEntries: Array<[string, string]> = [
    ['SiteCode', siteCode],
    ['CountryCode', 'ZA'],
    ['CurrencyCode', currencyCode],
    ['Amount', (args.amountCents / 100).toFixed(2)],
    ['TransactionReference', transactionReference],
    [
      'BankReference',
      deriveOzowBankReference(transactionReference, args.bankReference ?? null),
    ],
  ];

  const optionalFields: Array<[string, string | null | undefined]> = [
    ['Optional1', args.optional1],
    ['Optional2', args.optional2],
    ['Optional3', args.optional3],
    ['Optional4', args.optional4],
    ['Optional5', args.optional5],
    ['Customer', args.customer],
  ];

  for (const [key, value] of optionalFields) {
    const trimmed = trimToNull(value);
    if (trimmed) {
      fieldEntries.push([key, trimmed]);
    }
  }

  fieldEntries.push(
    ['CancelUrl', redirectUrls.cancelUrl],
    ['ErrorUrl', redirectUrls.errorUrl],
    ['SuccessUrl', redirectUrls.successUrl],
    ['NotifyUrl', redirectUrls.notifyUrl],
    ['IsTest', args.isTest ? 'true' : 'false'],
  );

  const fields = Object.fromEntries(fieldEntries) as Record<string, string>;
  const hashMaterial = buildOzowHashMaterial(
    fields,
    args.privateKey,
    OZOW_REQUEST_HASH_FIELDS,
  );
  fields.HashCheck = hashMaterial.hashCheck;

  return {
    action: OZOW_PAYMENT_URL,
    method: 'POST',
    fields,
  };
}
