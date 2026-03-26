import {
  buildEncryptedMerchantSecretUpdate,
  buildMerchantSecretBackupEntry,
  getPlaintextMerchantSecretFields,
} from './merchant-secret-migration';
import { decryptStoredSecret, isEncryptedSecret } from './secrets';

describe('merchant secret migration helpers', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      CREDENTIALS_ENCRYPTION_SECRET: 'test-credential-secret',
    };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('finds only plaintext secret fields that still need migration', () => {
    const merchant = {
      id: 'm-1',
      payfastMerchantKey: 'pf-key',
      payfastPassphrase: null,
      ozowPrivateKey: 'enc:v1:iv:tag:payload',
      ozowApiKey: 'oz-api',
      yocoSecretKey: '',
      yocoWebhookSecret: 'whsec_test',
      paystackSecretKey: null,
    };

    expect(getPlaintextMerchantSecretFields(merchant)).toEqual([
      'payfastMerchantKey',
      'ozowApiKey',
      'yocoWebhookSecret',
    ]);
  });

  it('builds a backup entry only for plaintext values', () => {
    const merchant = {
      id: 'm-1',
      payfastMerchantKey: 'pf-key',
      payfastPassphrase: null,
      ozowPrivateKey: null,
      ozowApiKey: 'oz-api',
      yocoSecretKey: null,
      yocoWebhookSecret: null,
      paystackSecretKey: null,
    };

    expect(buildMerchantSecretBackupEntry(merchant)).toEqual({
      merchantId: 'm-1',
      fields: {
        payfastMerchantKey: 'pf-key',
        ozowApiKey: 'oz-api',
      },
    });
  });

  it('encrypts every plaintext field included in the migration update', () => {
    const merchant = {
      id: 'm-1',
      payfastMerchantKey: 'pf-key',
      payfastPassphrase: 'pf-pass',
      ozowPrivateKey: null,
      ozowApiKey: null,
      yocoSecretKey: 'sk_test_secret',
      yocoWebhookSecret: null,
      paystackSecretKey: 'sk_test_paystack',
    };

    const update = buildEncryptedMerchantSecretUpdate(merchant);

    expect(update?.fields).toEqual([
      'payfastMerchantKey',
      'payfastPassphrase',
      'yocoSecretKey',
      'paystackSecretKey',
    ]);
    expect(update?.backup).toEqual({
      merchantId: 'm-1',
      fields: {
        payfastMerchantKey: 'pf-key',
        payfastPassphrase: 'pf-pass',
        yocoSecretKey: 'sk_test_secret',
        paystackSecretKey: 'sk_test_paystack',
      },
    });

    const encryptedValues = Object.values(update?.data ?? {});
    expect(encryptedValues.every((value) => isEncryptedSecret(value))).toBe(
      true,
    );
    expect(decryptStoredSecret(update?.data.payfastMerchantKey ?? null)).toBe(
      'pf-key',
    );
    expect(decryptStoredSecret(update?.data.payfastPassphrase ?? null)).toBe(
      'pf-pass',
    );
    expect(decryptStoredSecret(update?.data.yocoSecretKey ?? null)).toBe(
      'sk_test_secret',
    );
    expect(decryptStoredSecret(update?.data.paystackSecretKey ?? null)).toBe(
      'sk_test_paystack',
    );
  });
});
