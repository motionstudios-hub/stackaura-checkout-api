import { GatewayProvider } from '@prisma/client';
import { RoutingEngine } from './routing.engine';

describe('RoutingEngine', () => {
  const engine = new RoutingEngine();

  const merchant = {
    id: 'm-1',
    payfastMerchantId: null,
    payfastMerchantKey: null,
    payfastIsSandbox: true,
    ozowSiteCode: 'OZ-1',
    ozowPrivateKey: 'oz-private',
    ozowApiKey: 'oz-api',
    ozowIsTest: true,
    yocoPublicKey: 'pk_test_123',
    yocoSecretKey: 'sk_test_123',
    yocoTestMode: true,
    paystackSecretKey: 'sk_test_paystack',
    paystackTestMode: true,
    gatewayOrder: null,
    platformFeeBps: 0,
    platformFeeFixedCents: 0,
  };

  it('prefers Yoco first during AUTO routing when configured and amount is valid', () => {
    const decision = engine.decide({
      requestedGateway: 'AUTO',
      merchant,
      mode: 'STRICT_PRIORITY',
      amountCents: 9900,
      currency: 'ZAR',
      customerEmail: 'buyer@example.com',
    });

    expect(decision.selectedGateway).toBe(GatewayProvider.YOCO);
    expect(decision.rankedGateways.map((item) => item.gateway)).toEqual([
      GatewayProvider.YOCO,
      GatewayProvider.OZOW,
    ]);
  });

  it('falls back to Ozow during AUTO routing when Yoco amount is below minimum', () => {
    const decision = engine.decide({
      requestedGateway: 'AUTO',
      merchant,
      mode: 'STRICT_PRIORITY',
      amountCents: 150,
      currency: 'ZAR',
      customerEmail: 'buyer@example.com',
    });

    expect(decision.selectedGateway).toBe(GatewayProvider.OZOW);
    expect(
      decision.readiness.find((item) => item.gateway === GatewayProvider.YOCO),
    ).toEqual(
      expect.objectContaining({
        ready: false,
        issues: expect.arrayContaining([
          'Yoco requires a minimum amount of 200 cents',
        ]),
      }),
    );
  });

  it('rejects explicit Yoco selection when Yoco is not ready for the amount', () => {
    expect(() =>
      engine.decide({
        requestedGateway: GatewayProvider.YOCO,
        merchant,
        mode: 'STRICT_PRIORITY',
        amountCents: 199,
        currency: 'ZAR',
        customerEmail: 'buyer@example.com',
      }),
    ).toThrow('Gateway YOCO is not available for this payment');
  });

  it('allows explicit Paystack selection when merchant config and customer email are present', () => {
    const decision = engine.decide({
      requestedGateway: GatewayProvider.PAYSTACK,
      merchant,
      mode: 'STRICT_PRIORITY',
      amountCents: 9900,
      currency: 'ZAR',
      customerEmail: 'buyer@example.com',
    });

    expect(decision.selectedGateway).toBe(GatewayProvider.PAYSTACK);
    expect(decision.rankedGateways).toEqual([
      {
        gateway: GatewayProvider.PAYSTACK,
        priority: 1,
        reason: ['explicit_gateway_request'],
      },
    ]);
  });

  it('rejects explicit Paystack selection when customerEmail is missing', () => {
    expect(() =>
      engine.decide({
        requestedGateway: GatewayProvider.PAYSTACK,
        merchant,
        mode: 'STRICT_PRIORITY',
        amountCents: 9900,
        currency: 'ZAR',
        customerEmail: null,
      }),
    ).toThrow('Gateway PAYSTACK is not available for this payment');
  });



  it('marks Ozow unavailable when merchant config is partial instead of mixing env fallback values', () => {
    const originalEnv = {
      siteCode: process.env.OZOW_SITE_CODE,
      privateKey: process.env.OZOW_PRIVATE_KEY,
      apiKey: process.env.OZOW_API_KEY,
      testMode: process.env.OZOW_TEST_MODE,
    };

    process.env.OZOW_SITE_CODE = 'ENV-SC';
    process.env.OZOW_PRIVATE_KEY = 'env-private';
    process.env.OZOW_API_KEY = 'env-api';
    process.env.OZOW_TEST_MODE = 'true';

    try {
      const readiness = engine.getGatewayReadiness({
        merchant: {
          ...merchant,
          ozowSiteCode: 'MERCHANT-SC',
          ozowPrivateKey: null,
          ozowApiKey: null,
          ozowIsTest: null,
        },
        mode: 'STRICT_PRIORITY',
        amountCents: 9900,
        currency: 'ZAR',
        customerEmail: 'buyer@example.com',
      });

      expect(
        readiness.find((item) => item.gateway === GatewayProvider.OZOW),
      ).toEqual(
        expect.objectContaining({
          ready: false,
          issues: expect.arrayContaining(['merchant Ozow config is incomplete']),
        }),
      );
    } finally {
      process.env.OZOW_SITE_CODE = originalEnv.siteCode;
      process.env.OZOW_PRIVATE_KEY = originalEnv.privateKey;
      process.env.OZOW_API_KEY = originalEnv.apiKey;
      process.env.OZOW_TEST_MODE = originalEnv.testMode;
    }
  });

  it('returns a clear no-gateway-available error when neither rail is ready', () => {
    expect(() =>
      engine.decide({
        requestedGateway: 'AUTO',
        merchant: {
          ...merchant,
          ozowSiteCode: null,
          ozowPrivateKey: null,
          yocoPublicKey: null,
          yocoSecretKey: null,
          paystackSecretKey: 'sk_test_paystack',
        },
        mode: 'STRICT_PRIORITY',
        amountCents: 500,
        currency: 'ZAR',
        customerEmail: 'buyer@example.com',
      }),
    ).toThrow('No gateway available for this payment');
  });
});
