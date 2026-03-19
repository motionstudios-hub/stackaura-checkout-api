import { OzowGateway } from './ozow.gateway';

describe('OzowGateway', () => {
  let gateway: OzowGateway;
  const originalEnv = {
    siteCode: process.env.OZOW_SITE_CODE,
    privateKey: process.env.OZOW_PRIVATE_KEY,
    apiKey: process.env.OZOW_API_KEY,
    testMode: process.env.OZOW_TEST_MODE,
  };

  beforeEach(() => {
    gateway = new OzowGateway();
  });

  afterEach(() => {
    process.env.OZOW_SITE_CODE = originalEnv.siteCode;
    process.env.OZOW_PRIVATE_KEY = originalEnv.privateKey;
    process.env.OZOW_API_KEY = originalEnv.apiKey;
    process.env.OZOW_TEST_MODE = originalEnv.testMode;
  });

  it('builds an Ozow redirect form with merchant-scoped config and tracked callback urls', async () => {
    const result = await gateway.createPayment({
      merchantId: 'm-1',
      paymentId: 'p-1',
      reference: 'INV-OZOW-1',
      amountCents: 9900,
      currency: 'ZAR',
      customerEmail: 'buyer@example.com',
      config: {
        ozowSiteCode: 'MERCHANT-SC',
        ozowPrivateKey: 'merchant-private',
        ozowApiKey: 'merchant-api',
        ozowIsTest: false,
      },
      metadata: {
        returnUrl: 'https://stackaura.co.za/payments/success',
        cancelUrl: 'https://stackaura.co.za/payments/cancel',
        errorUrl: 'https://stackaura.co.za/payments/error',
        notifyUrl: 'https://api.stackaura.co.za/webhooks/ozow',
      },
    });

    expect(result.redirectUrl).toBe('https://pay.ozow.com');
    expect(result.externalReference).toBe('INV-OZOW-1');
    expect(result.redirectForm).toEqual(
      expect.objectContaining({
        action: 'https://pay.ozow.com',
        method: 'POST',
        fields: expect.objectContaining({
          SiteCode: 'MERCHANT-SC',
          TransactionReference: 'INV-OZOW-1',
          Optional1: 'p-1',
          IsTest: 'false',
          SuccessUrl:
            'https://stackaura.co.za/payments/success?reference=INV-OZOW-1&paymentId=p-1&gateway=OZOW',
          CancelUrl:
            'https://stackaura.co.za/payments/cancel?reference=INV-OZOW-1&paymentId=p-1&gateway=OZOW',
          ErrorUrl:
            'https://stackaura.co.za/payments/error?reference=INV-OZOW-1&paymentId=p-1&gateway=OZOW',
          NotifyUrl:
            'https://api.stackaura.co.za/webhooks/ozow?reference=INV-OZOW-1&paymentId=p-1&gateway=OZOW',
        }),
      }),
    );
  });

  it('does not mix partial merchant Ozow config with env fallback values', async () => {
    process.env.OZOW_SITE_CODE = 'ENV-SC';
    process.env.OZOW_PRIVATE_KEY = 'env-private';
    process.env.OZOW_API_KEY = 'env-api';
    process.env.OZOW_TEST_MODE = 'true';

    await expect(
      gateway.createPayment({
        merchantId: 'm-1',
        paymentId: 'p-2',
        reference: 'INV-OZOW-2',
        amountCents: 9900,
        currency: 'ZAR',
        config: {
          ozowSiteCode: 'MERCHANT-SC',
          ozowPrivateKey: null,
          ozowApiKey: null,
          ozowIsTest: null,
        },
      }),
    ).rejects.toThrow('Ozow private key is required');
  });

  it('rejects non-absolute Ozow callback urls before generating the handoff form', async () => {
    await expect(
      gateway.createPayment({
        merchantId: 'm-1',
        paymentId: 'p-bad-url',
        reference: 'INV-OZOW-BAD-URL',
        amountCents: 9900,
        currency: 'ZAR',
        config: {
          ozowSiteCode: 'MERCHANT-SC',
          ozowPrivateKey: 'merchant-private',
          ozowApiKey: 'merchant-api',
          ozowIsTest: true,
        },
        metadata: {
          returnUrl: '/payments/success',
          cancelUrl: 'https://stackaura.co.za/payments/cancel',
          errorUrl: 'https://stackaura.co.za/payments/error',
          notifyUrl: 'https://api.stackaura.co.za/webhooks/ozow',
        },
      }),
    ).rejects.toThrow('Ozow successUrl must be an absolute HTTPS URL');
  });
});
