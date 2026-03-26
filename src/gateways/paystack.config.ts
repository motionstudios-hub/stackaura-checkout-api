export const PAYSTACK_API_BASE_URL = 'https://api.paystack.co';
export const PAYSTACK_INITIALIZE_PATH = '/transaction/initialize';
export const PAYSTACK_VERIFY_PATH = '/transaction/verify';
export const PAYSTACK_SUCCESS_URL = 'https://stackaura.co.za/payments/success';
export const PAYSTACK_CANCEL_URL = 'https://stackaura.co.za/payments/cancel';
export const PAYSTACK_ERROR_URL = 'https://stackaura.co.za/payments/error';
export const PAYSTACK_WEBHOOK_URL =
  'https://api.stackaura.co.za/v1/webhooks/paystack';

export type PaystackConfigSource = {
  paystackSecretKey?: string | null;
  paystackTestMode?: boolean | null;
};

export type ResolvedPaystackConfig = {
  secretKey: string | null;
  testMode: boolean;
  apiBaseUrl: string;
  initializeUrl: string;
  verifyUrlBase: string;
  successUrl: string;
  cancelUrl: string;
  errorUrl: string;
  webhookUrl: string;
};

const trimToNull = (value: unknown) =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

export function detectPaystackModeFromSecretKey(
  secretKey: string | null | undefined,
) {
  const normalized = trimToNull(secretKey);
  if (!normalized) return null;
  if (normalized.startsWith('sk_test_')) return true;
  if (normalized.startsWith('sk_live_')) return false;
  return null;
}

export function resolvePaystackConfig(
  source: PaystackConfigSource = {},
): ResolvedPaystackConfig {
  const secretKey =
    trimToNull(source.paystackSecretKey) ??
    trimToNull(process.env.PAYSTACK_SECRET_KEY);
  const detectedMode = detectPaystackModeFromSecretKey(secretKey);

  return {
    secretKey,
    testMode:
      source.paystackTestMode ??
      detectedMode ??
      parseBooleanEnv(process.env.PAYSTACK_TEST_MODE) ??
      process.env.NODE_ENV !== 'production',
    apiBaseUrl: PAYSTACK_API_BASE_URL,
    initializeUrl: `${PAYSTACK_API_BASE_URL}${PAYSTACK_INITIALIZE_PATH}`,
    verifyUrlBase: `${PAYSTACK_API_BASE_URL}${PAYSTACK_VERIFY_PATH}`,
    successUrl: PAYSTACK_SUCCESS_URL,
    cancelUrl: PAYSTACK_CANCEL_URL,
    errorUrl: PAYSTACK_ERROR_URL,
    webhookUrl: PAYSTACK_WEBHOOK_URL,
  };
}

export function assertPaystackConfigConsistency(
  config: ResolvedPaystackConfig,
) {
  const detectedMode = detectPaystackModeFromSecretKey(config.secretKey);
  if (detectedMode !== null && detectedMode !== config.testMode) {
    throw new Error('Paystack secret key does not match the selected testMode');
  }
}

export function resolvePaystackRedirectUrl(
  candidate: string | null | undefined,
  fallback: string,
  label: 'callbackUrl' | 'cancelUrl' | 'errorUrl',
) {
  const resolved = trimToNull(candidate) ?? fallback;

  let parsed: URL;
  try {
    parsed = new URL(resolved);
  } catch {
    throw new Error(`Paystack ${label} must be an absolute HTTPS URL`);
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(`Paystack ${label} must be an absolute HTTPS URL`);
  }

  return parsed.toString();
}

export function resolvePaystackRedirectUrls(args: {
  callbackUrl?: string | null;
  cancelUrl?: string | null;
  errorUrl?: string | null;
}) {
  return {
    callbackUrl: resolvePaystackRedirectUrl(
      args.callbackUrl,
      PAYSTACK_SUCCESS_URL,
      'callbackUrl',
    ),
    cancelUrl: resolvePaystackRedirectUrl(
      args.cancelUrl,
      PAYSTACK_CANCEL_URL,
      'cancelUrl',
    ),
    errorUrl: resolvePaystackRedirectUrl(
      args.errorUrl,
      PAYSTACK_ERROR_URL,
      'errorUrl',
    ),
  };
}

function parseBooleanEnv(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return null;
}
