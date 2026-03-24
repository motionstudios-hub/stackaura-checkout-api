export const MERCHANT_PLAN_CODES = ['starter', 'growth', 'scale'] as const;

export type MerchantPlanCode = (typeof MERCHANT_PLAN_CODES)[number];

export type PlatformFeeRuleType =
  | 'NONE'
  | 'FIXED'
  | 'PERCENTAGE'
  | 'FIXED_PLUS_PERCENTAGE';

export type ResolvedPlatformFeePolicy = {
  fixedFeeCents: number;
  percentageBps: number;
  ruleType: PlatformFeeRuleType;
  source: 'platform_default' | 'merchant_plan' | 'merchant_override';
  merchantOverrideApplied: boolean;
};

export type PlatformFeeBreakdown = {
  baseAmountCents: number;
  platformFeeCents: number;
  chargeAmountCents: number;
  merchantNetCents: number;
};

export type RoutingPlanFeatures = {
  planCode: MerchantPlanCode;
  manualGatewaySelection: boolean;
  autoRouting: boolean;
  fallback: boolean;
  source: 'platform_default' | 'merchant_plan';
};

export type ResolvedMerchantPlan = {
  code: MerchantPlanCode;
  source: 'merchant_assigned' | 'platform_default';
  feePolicy: ResolvedPlatformFeePolicy;
  routingFeatures: RoutingPlanFeatures;
};

export type PublicPricingPlan = {
  code: MerchantPlanCode;
  name: string;
  feePolicy: ResolvedPlatformFeePolicy;
  routingFeatures: RoutingPlanFeatures;
  display: {
    percentage: string;
    fixedFee: string;
    fromPrice: string;
    startingFromPrice: string | null;
  };
};

export type PublicPricingSnapshot = {
  currency: 'ZAR';
  defaultPlanCode: MerchantPlanCode;
  notes: {
    gatewayFees: string;
    infrastructureRole: string;
  };
  plans: Record<MerchantPlanCode, PublicPricingPlan>;
};

type PlatformFeePolicySource = {
  merchantPlatformFeeBps?: number | null;
  merchantPlatformFeeFixedCents?: number | null;
};

type MerchantPlanResolverSource = PlatformFeePolicySource & {
  merchantPlanCode?: string | null;
};

type PlanFeatureSet = Omit<RoutingPlanFeatures, 'planCode' | 'source'>;

const BUILTIN_PLAN_FEATURES: Record<MerchantPlanCode, PlanFeatureSet> = {
  starter: {
    manualGatewaySelection: false,
    autoRouting: true,
    fallback: false,
  },
  growth: {
    manualGatewaySelection: true,
    autoRouting: true,
    fallback: true,
  },
  scale: {
    manualGatewaySelection: true,
    autoRouting: true,
    fallback: true,
  },
};

function parseBooleanEnv(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return null;
}

function parseIntegerEnv(value: string | undefined) {
  const parsed = Number(value?.trim());
  if (!Number.isFinite(parsed)) {
    return 0;
  }

  return Math.trunc(parsed);
}

function hasEnvValue(value: string | undefined) {
  return typeof value === 'string' && value.trim().length > 0;
}

function readFirstConfiguredIntegerEnv(keys: readonly string[]) {
  const configuredKey = keys.find((key) => hasEnvValue(process.env[key]));
  return configuredKey ? parseIntegerEnv(process.env[configuredKey]) : 0;
}

function hasConfiguredEnvKey(keys: readonly string[]) {
  return keys.some((key) => hasEnvValue(process.env[key]));
}

function resolveFeeFixedEnvKeys(prefix: string) {
  return [`${prefix}_FIXED`, `${prefix}_FIXED_CENTS`] as const;
}

function resolveFeeBpsEnvKeys(prefix: string) {
  return [`${prefix}_BPS`] as const;
}

function normalizeFeeComponent(value: number | null | undefined) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.trunc(value as number));
}

function resolveRuleType(args: {
  fixedFeeCents: number;
  percentageBps: number;
}): PlatformFeeRuleType {
  if (args.fixedFeeCents > 0 && args.percentageBps > 0) {
    return 'FIXED_PLUS_PERCENTAGE';
  }

  if (args.fixedFeeCents > 0) {
    return 'FIXED';
  }

  if (args.percentageBps > 0) {
    return 'PERCENTAGE';
  }

  return 'NONE';
}

export function normalizeMerchantPlanCode(
  value: string | null | undefined,
): MerchantPlanCode | null {
  const normalized =
    typeof value === 'string' && value.trim()
      ? value.trim().toLowerCase()
      : null;

  if (!normalized) {
    return null;
  }

  return MERCHANT_PLAN_CODES.includes(normalized as MerchantPlanCode)
    ? (normalized as MerchantPlanCode)
    : null;
}

export function resolveDefaultMerchantPlanCode() {
  return (
    normalizeMerchantPlanCode(process.env.STACKAURA_DEFAULT_MERCHANT_PLAN) ??
    normalizeMerchantPlanCode(process.env.STACKAURA_ROUTING_PLAN) ??
    'growth'
  );
}

function resolvePlatformDefaultFeePolicy(): ResolvedPlatformFeePolicy {
  const fixedFeeCents = normalizeFeeComponent(
    readFirstConfiguredIntegerEnv(
      resolveFeeFixedEnvKeys('STACKAURA_PLATFORM_FEE'),
    ),
  );
  const percentageBps = normalizeFeeComponent(
    readFirstConfiguredIntegerEnv(
      resolveFeeBpsEnvKeys('STACKAURA_PLATFORM_FEE'),
    ),
  );

  return {
    fixedFeeCents,
    percentageBps,
    ruleType: resolveRuleType({
      fixedFeeCents,
      percentageBps,
    }),
    source: 'platform_default',
    merchantOverrideApplied: false,
  };
}

function resolveMerchantOverrideFeePolicy(
  source: PlatformFeePolicySource,
): ResolvedPlatformFeePolicy | null {
  const fixedFeeCents = normalizeFeeComponent(
    source.merchantPlatformFeeFixedCents,
  );
  const percentageBps = normalizeFeeComponent(source.merchantPlatformFeeBps);

  if (fixedFeeCents <= 0 && percentageBps <= 0) {
    return null;
  }

  return {
    fixedFeeCents,
    percentageBps,
    ruleType: resolveRuleType({
      fixedFeeCents,
      percentageBps,
    }),
    source: 'merchant_override',
    merchantOverrideApplied: true,
  };
}

function resolvePlanFeePolicy(
  planCode: MerchantPlanCode,
  fallback: ResolvedPlatformFeePolicy,
): ResolvedPlatformFeePolicy {
  const upperPlanCode = planCode.toUpperCase();
  const feePrefix = `STACKAURA_PLAN_${upperPlanCode}_FEE`;
  const fixedEnvKeys = resolveFeeFixedEnvKeys(feePrefix);
  const bpsEnvKeys = resolveFeeBpsEnvKeys(feePrefix);
  const hasPlanFeeOverride =
    hasConfiguredEnvKey(fixedEnvKeys) || hasConfiguredEnvKey(bpsEnvKeys);

  if (!hasPlanFeeOverride) {
    return fallback;
  }

  const fixedFeeCents = normalizeFeeComponent(
    readFirstConfiguredIntegerEnv(fixedEnvKeys),
  );
  const percentageBps = normalizeFeeComponent(
    readFirstConfiguredIntegerEnv(bpsEnvKeys),
  );

  return {
    fixedFeeCents,
    percentageBps,
    ruleType: resolveRuleType({
      fixedFeeCents,
      percentageBps,
    }),
    source: 'merchant_plan',
    merchantOverrideApplied: false,
  };
}

export function resolvePlatformFeePolicy(
  source: PlatformFeePolicySource = {},
): ResolvedPlatformFeePolicy {
  return (
    resolveMerchantOverrideFeePolicy(source) ??
    resolvePlatformDefaultFeePolicy()
  );
}

export function computePlatformFeeBreakdown(args: {
  amountCents: number;
  policy: ResolvedPlatformFeePolicy;
}): PlatformFeeBreakdown {
  const baseAmountCents = Number.isFinite(args.amountCents)
    ? Math.max(0, Math.trunc(args.amountCents))
    : 0;
  const fixedFeeCents = normalizeFeeComponent(args.policy.fixedFeeCents);
  const percentageBps = normalizeFeeComponent(args.policy.percentageBps);
  const variableFeeCents = Math.round(
    (baseAmountCents * percentageBps) / 10000,
  );
  const platformFeeCents = Math.max(0, fixedFeeCents + variableFeeCents);
  const chargeAmountCents = baseAmountCents + platformFeeCents;

  return {
    baseAmountCents,
    platformFeeCents,
    chargeAmountCents,
    merchantNetCents: baseAmountCents,
  };
}

export function resolveRoutingPlanFeatures(): RoutingPlanFeatures {
  const planCode = resolveDefaultMerchantPlanCode();

  return {
    planCode,
    manualGatewaySelection:
      parseBooleanEnv(process.env.STACKAURA_FEATURE_MANUAL_GATEWAY_SELECTION) ??
      true,
    autoRouting:
      parseBooleanEnv(process.env.STACKAURA_FEATURE_AUTO_ROUTING) ?? true,
    fallback: parseBooleanEnv(process.env.STACKAURA_FEATURE_FALLBACK) ?? true,
    source: 'platform_default',
  };
}

export function resolveMerchantPlan(
  source: MerchantPlanResolverSource = {},
): ResolvedMerchantPlan {
  const platformDefaultFeePolicy = resolvePlatformDefaultFeePolicy();
  const platformDefaultFeatures = resolveRoutingPlanFeatures();
  const merchantPlanCode = normalizeMerchantPlanCode(source.merchantPlanCode);
  const code = merchantPlanCode ?? platformDefaultFeatures.planCode;
  const merchantOverrideFeePolicy = resolveMerchantOverrideFeePolicy(source);

  const feePolicy =
    merchantOverrideFeePolicy ??
    resolvePlanFeePolicy(code, platformDefaultFeePolicy);
  const routingFeatures = merchantPlanCode
    ? {
        planCode: code,
        ...BUILTIN_PLAN_FEATURES[code],
        source: 'merchant_plan' as const,
      }
    : platformDefaultFeatures;

  return {
    code,
    source: merchantPlanCode ? 'merchant_assigned' : 'platform_default',
    feePolicy,
    routingFeatures,
  };
}

function formatPercentageBps(percentageBps: number) {
  return `${(normalizeFeeComponent(percentageBps) / 100).toFixed(2)}%`;
}

function formatZarCents(fixedFeeCents: number) {
  return `R${(normalizeFeeComponent(fixedFeeCents) / 100).toFixed(2)}`;
}

function formatPerTransaction(policy: ResolvedPlatformFeePolicy) {
  const parts: string[] = [];

  if (policy.percentageBps > 0) {
    parts.push(formatPercentageBps(policy.percentageBps));
  }

  if (policy.fixedFeeCents > 0) {
    parts.push(formatZarCents(policy.fixedFeeCents));
  }

  if (parts.length === 0) {
    return null;
  }

  return `${parts.join(' + ')} / transaction`;
}

function buildPublicPricingPlan(code: MerchantPlanCode): PublicPricingPlan {
  const resolvedPlan = resolveMerchantPlan({ merchantPlanCode: code });
  const perTransaction = formatPerTransaction(resolvedPlan.feePolicy);

  return {
    code,
    name: code.charAt(0).toUpperCase() + code.slice(1),
    feePolicy: resolvedPlan.feePolicy,
    routingFeatures: resolvedPlan.routingFeatures,
    display: {
      percentage: formatPercentageBps(resolvedPlan.feePolicy.percentageBps),
      fixedFee: formatZarCents(resolvedPlan.feePolicy.fixedFeeCents),
      fromPrice: perTransaction ? `From ${perTransaction}` : 'Custom pricing',
      startingFromPrice: perTransaction
        ? `Starting from ${perTransaction}`
        : null,
    },
  };
}

export function resolvePublicPricingSnapshot(): PublicPricingSnapshot {
  return {
    currency: 'ZAR',
    defaultPlanCode: resolveDefaultMerchantPlanCode(),
    notes: {
      gatewayFees:
        'Gateway fees charged separately through the connected payment rail.',
      infrastructureRole:
        'Stackaura provides orchestration and infrastructure software. Licensed payment providers process and settle payments.',
    },
    plans: {
      starter: buildPublicPricingPlan('starter'),
      growth: buildPublicPricingPlan('growth'),
      scale: buildPublicPricingPlan('scale'),
    },
  };
}
