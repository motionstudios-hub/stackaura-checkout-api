import {
  computePlatformFeeBreakdown,
  resolveDefaultMerchantPlanCode,
  resolveMerchantPlan,
  resolvePublicPricingSnapshot,
  resolvePlatformFeePolicy,
  resolveRoutingPlanFeatures,
} from './monetization.config';

describe('monetization.config', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('applies platform default fixed fees', () => {
    process.env.STACKAURA_PLATFORM_FEE_FIXED_CENTS = '125';

    const policy = resolvePlatformFeePolicy();
    const fee = computePlatformFeeBreakdown({
      amountCents: 1000,
      policy,
    });

    expect(policy).toEqual(
      expect.objectContaining({
        fixedFeeCents: 125,
        percentageBps: 0,
        ruleType: 'FIXED',
        source: 'platform_default',
      }),
    );
    expect(fee).toEqual({
      baseAmountCents: 1000,
      platformFeeCents: 125,
      chargeAmountCents: 1125,
      merchantNetCents: 1000,
    });
  });

  it('accepts the fixed fee env alias without the _CENTS suffix', () => {
    process.env.STACKAURA_PLATFORM_FEE_FIXED = '150';

    const policy = resolvePlatformFeePolicy();

    expect(policy).toEqual(
      expect.objectContaining({
        fixedFeeCents: 150,
        percentageBps: 0,
        ruleType: 'FIXED',
        source: 'platform_default',
      }),
    );
  });

  it('applies platform default percentage fees', () => {
    process.env.STACKAURA_PLATFORM_FEE_BPS = '250';

    const policy = resolvePlatformFeePolicy();
    const fee = computePlatformFeeBreakdown({
      amountCents: 2000,
      policy,
    });

    expect(policy).toEqual(
      expect.objectContaining({
        fixedFeeCents: 0,
        percentageBps: 250,
        ruleType: 'PERCENTAGE',
        source: 'platform_default',
      }),
    );
    expect(fee).toEqual({
      baseAmountCents: 2000,
      platformFeeCents: 50,
      chargeAmountCents: 2050,
      merchantNetCents: 2000,
    });
  });

  it('supports combined fees and merchant override precedence', () => {
    process.env.STACKAURA_PLATFORM_FEE_FIXED_CENTS = '80';
    process.env.STACKAURA_PLATFORM_FEE_BPS = '100';

    const plan = resolveMerchantPlan({
      merchantPlanCode: 'growth',
      merchantPlatformFeeFixedCents: 150,
      merchantPlatformFeeBps: 300,
    });
    const fee = computePlatformFeeBreakdown({
      amountCents: 10000,
      policy: plan.feePolicy,
    });

    expect(plan.feePolicy).toEqual(
      expect.objectContaining({
        fixedFeeCents: 150,
        percentageBps: 300,
        ruleType: 'FIXED_PLUS_PERCENTAGE',
        source: 'merchant_override',
        merchantOverrideApplied: true,
      }),
    );
    expect(fee).toEqual({
      baseAmountCents: 10000,
      platformFeeCents: 450,
      chargeAmountCents: 10450,
      merchantNetCents: 10000,
    });
  });

  it('resolves starter plan feature access', () => {
    const plan = resolveMerchantPlan({ merchantPlanCode: 'starter' });

    expect(plan.routingFeatures).toEqual({
      planCode: 'starter',
      manualGatewaySelection: false,
      autoRouting: true,
      fallback: false,
      source: 'merchant_plan',
    });
  });

  it('resolves growth plan feature access', () => {
    const plan = resolveMerchantPlan({ merchantPlanCode: 'growth' });

    expect(plan.routingFeatures).toEqual({
      planCode: 'growth',
      manualGatewaySelection: true,
      autoRouting: true,
      fallback: true,
      source: 'merchant_plan',
    });
  });

  it('resolves scale plan feature access', () => {
    const plan = resolveMerchantPlan({ merchantPlanCode: 'scale' });

    expect(plan.routingFeatures).toEqual({
      planCode: 'scale',
      manualGatewaySelection: true,
      autoRouting: true,
      fallback: true,
      source: 'merchant_plan',
    });
  });

  it('allows plan fee settings to override platform defaults', () => {
    process.env.STACKAURA_PLATFORM_FEE_BPS = '100';
    process.env.STACKAURA_PLAN_SCALE_FEE_BPS = '25';

    const plan = resolveMerchantPlan({ merchantPlanCode: 'scale' });

    expect(plan.feePolicy).toEqual(
      expect.objectContaining({
        fixedFeeCents: 0,
        percentageBps: 25,
        ruleType: 'PERCENTAGE',
        source: 'merchant_plan',
        merchantOverrideApplied: false,
      }),
    );
  });

  it('formats public pricing from env-backed plan fees', () => {
    process.env.STACKAURA_PLATFORM_FEE_FIXED = '150';
    process.env.STACKAURA_PLATFORM_FEE_BPS = '150';
    process.env.STACKAURA_PLAN_GROWTH_FEE_FIXED = '250';
    process.env.STACKAURA_PLAN_GROWTH_FEE_BPS = '250';
    process.env.STACKAURA_PLAN_SCALE_FEE_FIXED = '750';
    process.env.STACKAURA_PLAN_SCALE_FEE_BPS = '750';

    const pricing = resolvePublicPricingSnapshot();

    expect(pricing.plans.starter.display).toEqual({
      percentage: '1.50%',
      fixedFee: 'R1.50',
      fromPrice: 'From 1.50% + R1.50 / transaction',
      startingFromPrice: 'Starting from 1.50% + R1.50 / transaction',
    });
    expect(pricing.plans.growth.display).toEqual({
      percentage: '2.50%',
      fixedFee: 'R2.50',
      fromPrice: 'From 2.50% + R2.50 / transaction',
      startingFromPrice: 'Starting from 2.50% + R2.50 / transaction',
    });
    expect(pricing.plans.scale.display).toEqual({
      percentage: '7.50%',
      fixedFee: 'R7.50',
      fromPrice: 'From 7.50% + R7.50 / transaction',
      startingFromPrice: 'Starting from 7.50% + R7.50 / transaction',
    });
  });

  it('falls back to platform defaults when merchant plan is missing', () => {
    process.env.STACKAURA_DEFAULT_MERCHANT_PLAN = 'growth';

    expect(resolveDefaultMerchantPlanCode()).toBe('growth');
    expect(resolveRoutingPlanFeatures()).toEqual({
      planCode: 'growth',
      manualGatewaySelection: true,
      autoRouting: true,
      fallback: true,
      source: 'platform_default',
    });
  });
});
