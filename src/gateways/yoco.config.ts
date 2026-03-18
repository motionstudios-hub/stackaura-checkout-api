export const YOCO_CHECKOUT_API_URL = 'https://payments.yoco.com/api/checkouts';
export const YOCO_WEBHOOKS_API_URL = 'https://payments.yoco.com/api/webhooks';
export const YOCO_DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 180;
export const YOCO_SUCCESS_URL = 'https://stackaura.co.za/payments/success';
export const YOCO_CANCEL_URL = 'https://stackaura.co.za/payments/cancel';
export const YOCO_ERROR_URL = 'https://stackaura.co.za/payments/error';

export type YocoConfigSource = {
  yocoPublicKey?: string | null;
  yocoSecretKey?: string | null;
  yocoTestMode?: boolean | null;
};

export type ResolvedYocoConfig = {
  publicKey: string | null;
  secretKey: string | null;
  testMode: boolean;
  checkoutApiUrl: string;
};

const trimToNull = (value: unknown) =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

function inferKeyMode(key: string | null, prefixes: { test: string; live: string }) {
  if (!key) return null;
  if (key.startsWith(prefixes.test)) return true;
  if (key.startsWith(prefixes.live)) return false;
  return null;
}

export function detectYocoModeFromKeys(
  publicKey: string | null | undefined,
  secretKey: string | null | undefined,
) {
  const normalizedPublicKey = trimToNull(publicKey);
  const normalizedSecretKey = trimToNull(secretKey);
  const publicMode = inferKeyMode(normalizedPublicKey, {
    test: 'pk_test_',
    live: 'pk_live_',
  });
  const secretMode = inferKeyMode(normalizedSecretKey, {
    test: 'sk_test_',
    live: 'sk_live_',
  });

  if (
    publicMode !== null &&
    secretMode !== null &&
    publicMode !== secretMode
  ) {
    throw new Error(
      'Yoco public and secret keys must belong to the same environment',
    );
  }

  return secretMode ?? publicMode;
}

export function resolveYocoConfig(
  source: YocoConfigSource = {},
): ResolvedYocoConfig {
  const publicKey = trimToNull(source.yocoPublicKey);
  const secretKey = trimToNull(source.yocoSecretKey);
  const detectedMode = detectYocoModeFromKeys(publicKey, secretKey);

  return {
    publicKey,
    secretKey,
    testMode:
      source.yocoTestMode ??
      detectedMode ??
      process.env.NODE_ENV !== 'production',
    checkoutApiUrl: YOCO_CHECKOUT_API_URL,
  };
}

export function assertYocoConfigConsistency(config: ResolvedYocoConfig) {
  const detectedMode = detectYocoModeFromKeys(
    config.publicKey,
    config.secretKey,
  );

  if (detectedMode !== null && detectedMode !== config.testMode) {
    throw new Error('Yoco keys do not match the selected testMode');
  }
}

export function resolveYocoRedirectUrl(
  candidate: string | null | undefined,
  fallback: string,
  label: 'successUrl' | 'cancelUrl' | 'failureUrl',
) {
  const resolved = trimToNull(candidate) ?? fallback;

  let parsed: URL;
  try {
    parsed = new URL(resolved);
  } catch {
    throw new Error(`Yoco ${label} must be an absolute HTTPS URL`);
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(`Yoco ${label} must be an absolute HTTPS URL`);
  }

  return parsed.toString();
}

export function resolveYocoRedirectUrls(args: {
  successUrl?: string | null;
  cancelUrl?: string | null;
  failureUrl?: string | null;
}) {
  return {
    successUrl: resolveYocoRedirectUrl(
      args.successUrl,
      YOCO_SUCCESS_URL,
      'successUrl',
    ),
    cancelUrl: resolveYocoRedirectUrl(
      args.cancelUrl,
      YOCO_CANCEL_URL,
      'cancelUrl',
    ),
    failureUrl: resolveYocoRedirectUrl(
      args.failureUrl,
      YOCO_ERROR_URL,
      'failureUrl',
    ),
  };
}
