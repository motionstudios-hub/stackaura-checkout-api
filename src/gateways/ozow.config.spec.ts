import {
  buildOzowHashMaterial,
  buildOzowPaymentForm,
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
});
