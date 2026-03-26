import {
  assertPaystackConfigConsistency,
  detectPaystackModeFromSecretKey,
  resolvePaystackConfig,
  resolvePaystackRedirectUrls,
} from './paystack.config';

describe('resolvePaystackConfig', () => {
  it('detects Paystack test mode from a test secret key', () => {
    const resolved = resolvePaystackConfig({
      paystackSecretKey: 'sk_test_secret',
      paystackTestMode: null,
    });

    expect(resolved.testMode).toBe(true);
  });

  it('detects Paystack live mode from a live secret key', () => {
    const resolved = resolvePaystackConfig({
      paystackSecretKey: 'sk_live_secret',
      paystackTestMode: null,
    });

    expect(resolved.testMode).toBe(false);
  });

  it('throws when explicit Paystack testMode conflicts with key environment', () => {
    const resolved = resolvePaystackConfig({
      paystackSecretKey: 'sk_test_secret',
      paystackTestMode: false,
    });

    expect(() => assertPaystackConfigConsistency(resolved)).toThrow(
      'Paystack secret key does not match the selected testMode',
    );
  });

  it('detects key environment from Paystack secret key prefixes', () => {
    expect(detectPaystackModeFromSecretKey('sk_test_123')).toBe(true);
    expect(detectPaystackModeFromSecretKey('sk_live_123')).toBe(false);
    expect(detectPaystackModeFromSecretKey('custom_secret')).toBeNull();
  });

  it('uses the versioned Stackaura webhook URL', () => {
    const resolved = resolvePaystackConfig({
      paystackSecretKey: 'sk_live_secret',
      paystackTestMode: false,
    });

    expect(resolved.webhookUrl).toBe(
      'https://api.stackaura.co.za/v1/webhooks/paystack',
    );
  });
});

describe('resolvePaystackRedirectUrls', () => {
  it('falls back blank redirect URLs to the Stackaura production pages', () => {
    expect(
      resolvePaystackRedirectUrls({
        callbackUrl: '',
        cancelUrl: '   ',
        errorUrl: '',
      }),
    ).toEqual({
      callbackUrl: 'https://stackaura.co.za/payments/success',
      cancelUrl: 'https://stackaura.co.za/payments/cancel',
      errorUrl: 'https://stackaura.co.za/payments/error',
    });
  });

  it('rejects non-absolute redirect URLs', () => {
    expect(() =>
      resolvePaystackRedirectUrls({
        callbackUrl: '/payments/success',
      }),
    ).toThrow('Paystack callbackUrl must be an absolute HTTPS URL');
  });
});
