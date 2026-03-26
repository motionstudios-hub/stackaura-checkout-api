import {
  buildOzowHashMaterial,
  buildOzowPaymentForm,
  resolveOzowConfig,
} from './ozow.config';

describe('buildOzowPaymentForm', () => {
  it('preserves Ozow field order and hashes the exact final posted values', () => {
    const form = buildOzowPaymentForm({
      siteCode: 'K20-K20-164',
      privateKey: 'private-key',
      reference: 'SIGNUP-4B52242880F7421FAD597ADD',
      amountCents: 9900,
      currency: 'ZAR',
      customer: 'adminn@test.com',
      optional1: '1caf6d6d-740a-4bc9-bc52-773558ca8e64',
      successUrl: 'https://stackaura.co.za/payments/success',
      cancelUrl: 'https://stackaura.co.za/payments/cancel',
      errorUrl: 'https://stackaura.co.za/payments/error',
      notifyUrl: 'https://api.stackaura.co.za/webhooks/ozow',
      isTest: true,
    });

    expect(Object.keys(form.fields)).toEqual([
      'SiteCode',
      'CountryCode',
      'CurrencyCode',
      'Amount',
      'TransactionReference',
      'BankReference',
      'Optional1',
      'Customer',
      'CancelUrl',
      'ErrorUrl',
      'SuccessUrl',
      'NotifyUrl',
      'IsTest',
      'HashCheck',
    ]);

    const hashMaterial = buildOzowHashMaterial(form.fields, 'private-key', [
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
    ]);

    expect(hashMaterial.orderedFields.map((field) => field.key)).toEqual([
      'SiteCode',
      'CountryCode',
      'CurrencyCode',
      'Amount',
      'TransactionReference',
      'BankReference',
      'Optional1',
      'Customer',
      'CancelUrl',
      'ErrorUrl',
      'SuccessUrl',
      'NotifyUrl',
      'IsTest',
    ]);
    expect(hashMaterial.hashInput).toBe(
      'K20-K20-164' +
        'ZA' +
        'ZAR' +
        '99.00' +
        'SIGNUP-4B52242880F7421FAD597ADD' +
        'SIGNUP-4B52242880F74' +
        '1caf6d6d-740a-4bc9-bc52-773558ca8e64' +
        'adminn@test.com' +
        'https://stackaura.co.za/payments/cancel' +
        'https://stackaura.co.za/payments/error' +
        'https://stackaura.co.za/payments/success' +
        'https://api.stackaura.co.za/webhooks/ozow' +
        'true',
    );
    expect(form.fields.IsTest).toBe('true');
    expect(form.fields.HashCheck).toBe(hashMaterial.hashCheck);
  });

  it('normalizes lowercase payment references before posting to Ozow', () => {
    const form = buildOzowPaymentForm({
      siteCode: 'K20-K20-164',
      privateKey: 'private-key',
      reference: 'inv-4b52242880f7421fad597add',
      amountCents: 9900,
      currency: 'ZAR',
      successUrl: 'https://stackaura.co.za/payments/success',
      cancelUrl: 'https://stackaura.co.za/payments/cancel',
      errorUrl: 'https://stackaura.co.za/payments/error',
      notifyUrl: 'https://api.stackaura.co.za/webhooks/ozow',
      isTest: true,
    });

    expect(form.fields.TransactionReference).toBe(
      'INV-4B52242880F7421FAD597ADD',
    );
    expect(form.fields.BankReference).toBe('INV-4B52242880F7421F');
  });
});

describe('resolveOzowConfig', () => {
  const originalEnv = {
    siteCode: process.env.OZOW_SITE_CODE,
    privateKey: process.env.OZOW_PRIVATE_KEY,
    apiKey: process.env.OZOW_API_KEY,
    testMode: process.env.OZOW_TEST_MODE,
  };

  afterEach(() => {
    process.env.OZOW_SITE_CODE = originalEnv.siteCode;
    process.env.OZOW_PRIVATE_KEY = originalEnv.privateKey;
    process.env.OZOW_API_KEY = originalEnv.apiKey;
    process.env.OZOW_TEST_MODE = originalEnv.testMode;
  });

  it('prefers merchant-saved Ozow config over global env vars', () => {
    process.env.OZOW_SITE_CODE = 'ENV-SC';
    process.env.OZOW_PRIVATE_KEY = 'env-private';
    process.env.OZOW_API_KEY = 'env-api';
    process.env.OZOW_TEST_MODE = 'true';

    const resolved = resolveOzowConfig({
      ozowSiteCode: 'MERCHANT-SC',
      ozowPrivateKey: 'merchant-private',
      ozowApiKey: 'merchant-api',
      ozowIsTest: false,
    });

    expect(resolved.siteCode).toBe('MERCHANT-SC');
    expect(resolved.privateKey).toBe('merchant-private');
    expect(resolved.apiKey).toBe('merchant-api');
    expect(resolved.isTest).toBe(false);
  });

  it('falls back to env vars when merchant has not saved Ozow mode yet', () => {
    process.env.OZOW_SITE_CODE = 'ENV-SC';
    process.env.OZOW_PRIVATE_KEY = 'env-private';
    process.env.OZOW_API_KEY = 'env-api';
    process.env.OZOW_TEST_MODE = 'false';

    const resolved = resolveOzowConfig({
      ozowSiteCode: null,
      ozowPrivateKey: null,
      ozowApiKey: null,
      ozowIsTest: null,
    });

    expect(resolved.siteCode).toBe('ENV-SC');
    expect(resolved.privateKey).toBe('env-private');
    expect(resolved.apiKey).toBe('env-api');
    expect(resolved.isTest).toBe(false);
  });
});

describe('Ozow config hardening', () => {
  const originalEnv = {
    siteCode: process.env.OZOW_SITE_CODE,
    privateKey: process.env.OZOW_PRIVATE_KEY,
    apiKey: process.env.OZOW_API_KEY,
    testMode: process.env.OZOW_TEST_MODE,
  };

  afterEach(() => {
    process.env.OZOW_SITE_CODE = originalEnv.siteCode;
    process.env.OZOW_PRIVATE_KEY = originalEnv.privateKey;
    process.env.OZOW_API_KEY = originalEnv.apiKey;
    process.env.OZOW_TEST_MODE = originalEnv.testMode;
  });

  it('does not mix partial merchant Ozow credentials with env fallbacks', () => {
    process.env.OZOW_SITE_CODE = 'ENV-SC';
    process.env.OZOW_PRIVATE_KEY = 'env-private';
    process.env.OZOW_API_KEY = 'env-api';
    process.env.OZOW_TEST_MODE = 'true';

    const resolved = resolveOzowConfig({
      ozowSiteCode: 'MERCHANT-SC',
      ozowPrivateKey: null,
      ozowApiKey: null,
      ozowIsTest: null,
    });

    expect(resolved.source).toBe('merchant');
    expect(resolved.siteCode).toBe('MERCHANT-SC');
    expect(resolved.privateKey).toBeNull();
    expect(resolved.apiKey).toBeNull();
    expect(resolved.hasPartialMerchantConfig).toBe(true);
  });
});
