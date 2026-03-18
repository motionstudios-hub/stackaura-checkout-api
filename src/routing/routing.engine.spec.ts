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
      }),
    ).toThrow('Gateway YOCO is not available for this payment');
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
        },
        mode: 'STRICT_PRIORITY',
        amountCents: 500,
        currency: 'ZAR',
      }),
    ).toThrow('No gateway available for this payment');
  });
});
