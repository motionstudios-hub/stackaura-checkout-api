import { YocoGateway } from './yoco.gateway';

describe('YocoGateway', () => {
  let gateway: YocoGateway;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    gateway = new YocoGateway();
    fetchMock = jest.fn();
    (global as { fetch?: jest.Mock }).fetch = fetchMock;
  });

  afterEach(() => {
    delete (global as { fetch?: jest.Mock }).fetch;
  });

  it('creates a Yoco checkout session with merchant-scoped keys', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'checkout_123',
        redirectUrl: 'https://c.yoco.com/checkout/abc123',
        processingMode: 'test',
      }),
    });

    await expect(
      gateway.createPayment({
        merchantId: 'm-1',
        paymentId: 'p-1',
        reference: 'INV-YOCO-1',
        amountCents: 9900,
        currency: 'ZAR',
        config: {
          yocoPublicKey: 'pk_test_public',
          yocoSecretKey: 'sk_test_secret',
          yocoTestMode: true,
        },
        metadata: {
          returnUrl: 'https://stackaura.co.za/payments/success',
          cancelUrl: 'https://stackaura.co.za/payments/cancel',
          errorUrl: 'https://stackaura.co.za/payments/error',
        },
      }),
    ).resolves.toEqual({
      redirectUrl: 'https://c.yoco.com/checkout/abc123',
      externalReference: 'checkout_123',
      raw: expect.objectContaining({
        id: 'checkout_123',
        processingMode: 'test',
      }),
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://payments.yoco.com/api/checkouts',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer sk_test_secret',
          'Idempotency-Key': 'p-1',
        }),
      }),
    );
  });

  it('falls back blank redirect URLs to the Stackaura production payment pages', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'checkout_456',
        redirectUrl: 'https://c.yoco.com/checkout/abc456',
        processingMode: 'test',
      }),
    });

    await gateway.createPayment({
      merchantId: 'm-1',
      paymentId: 'p-2',
      reference: 'INV-YOCO-2',
      amountCents: 9900,
      currency: 'ZAR',
      config: {
        yocoPublicKey: 'pk_test_public',
        yocoSecretKey: 'sk_test_secret',
        yocoTestMode: true,
      },
      metadata: {
        returnUrl: '',
        cancelUrl: '   ',
        errorUrl: '',
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://payments.yoco.com/api/checkouts',
      expect.objectContaining({
        body: JSON.stringify({
          amount: 9900,
          currency: 'ZAR',
          successUrl: 'https://stackaura.co.za/payments/success',
          cancelUrl: 'https://stackaura.co.za/payments/cancel',
          failureUrl: 'https://stackaura.co.za/payments/error',
          clientReferenceId: 'p-2',
          externalId: 'INV-YOCO-2',
          metadata: {
            merchantId: 'm-1',
            paymentId: 'p-2',
            reference: 'INV-YOCO-2',
          },
        }),
      }),
    );
  });

  it('rejects non-absolute redirect URLs before calling Yoco', async () => {
    await expect(
      gateway.createPayment({
        merchantId: 'm-1',
        paymentId: 'p-bad-url',
        reference: 'INV-YOCO-BAD-URL',
        amountCents: 9900,
        currency: 'ZAR',
        config: {
          yocoPublicKey: 'pk_test_public',
          yocoSecretKey: 'sk_test_secret',
          yocoTestMode: true,
        },
        metadata: {
          returnUrl: '/payments/success',
          cancelUrl: 'https://stackaura.co.za/payments/cancel',
          errorUrl: 'https://stackaura.co.za/payments/error',
        },
      }),
    ).rejects.toThrow('Yoco successUrl must be an absolute HTTPS URL');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects sub-R2.00 Yoco payments before calling the provider', async () => {
    await expect(
      gateway.createPayment({
        merchantId: 'm-1',
        paymentId: 'p-low',
        reference: 'INV-YOCO-LOW',
        amountCents: 100,
        currency: 'ZAR',
        config: {
          yocoPublicKey: 'pk_test_public',
          yocoSecretKey: 'sk_test_secret',
          yocoTestMode: true,
        },
      }),
    ).rejects.toThrow('Yoco requires amountCents to be at least 200');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces the sanitized Yoco provider validation error body', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      headers: new Headers({
        'content-type': 'application/json',
        'x-request-id': 'req_yoco_1',
      }),
      json: async () => ({
        description: 'You cannot process a payment for less than R2.00.',
      }),
    });

    await expect(
      gateway.createPayment({
        merchantId: 'm-1',
        paymentId: 'p-1',
        reference: 'INV-YOCO-1',
        amountCents: 250,
        currency: 'ZAR',
        config: {
          yocoPublicKey: 'pk_test_public',
          yocoSecretKey: 'sk_test_secret',
          yocoTestMode: true,
        },
        metadata: {
          returnUrl: 'https://stackaura.co.za/payments/success',
          cancelUrl: 'https://stackaura.co.za/payments/cancel',
          errorUrl: 'https://stackaura.co.za/payments/error',
        },
      }),
    ).rejects.toThrow(
      'Yoco checkout creation failed: You cannot process a payment for less than R2.00.',
    );
  });

  it('registers a Yoco webhook subscription and returns the one-time secret', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'sub_123',
        mode: 'test',
        name: 'stackaura-test',
        secret: 'whsec_test_secret',
        url: 'https://api.stackaura.co.za/v1/webhooks/yoco',
      }),
    });

    await expect(
      gateway.registerWebhookSubscription({
        config: {
          yocoSecretKey: 'sk_test_secret',
          yocoTestMode: true,
        },
        name: 'stackaura-test',
        url: 'https://api.stackaura.co.za/v1/webhooks/yoco',
      }),
    ).resolves.toEqual({
      id: 'sub_123',
      mode: 'test',
      name: 'stackaura-test',
      secret: 'whsec_test_secret',
      url: 'https://api.stackaura.co.za/v1/webhooks/yoco',
      raw: expect.objectContaining({
        id: 'sub_123',
      }),
    });
  });

  it('looks up a Yoco checkout status with merchant-scoped keys', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'checkout_123',
        status: 'completed',
        paymentId: 'pay_123',
        externalId: 'INV-YOCO-1',
        clientReferenceId: 'p-1',
        processingMode: 'test',
      }),
    });

    await expect(
      gateway.getCheckoutStatus({
        checkoutId: 'checkout_123',
        config: {
          yocoSecretKey: 'sk_test_secret',
          yocoTestMode: true,
        },
      }),
    ).resolves.toEqual({
      checkoutId: 'checkout_123',
      externalReference: 'INV-YOCO-1',
      clientReferenceId: 'p-1',
      paymentId: 'pay_123',
      providerStatus: 'completed',
      processingMode: 'test',
      status: 'succeeded',
      raw: expect.objectContaining({
        id: 'checkout_123',
        paymentId: 'pay_123',
      }),
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://payments.yoco.com/api/checkouts/checkout_123',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer sk_test_secret',
        }),
      }),
    );
  });
});
