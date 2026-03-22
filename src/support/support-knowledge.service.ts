import { Injectable } from '@nestjs/common';
import {
  SupportCitation,
  SupportKnowledgeMatch,
} from './support.types';

type KnowledgeEntry = SupportCitation & {
  content: string;
  keywords: string[];
};

const KNOWLEDGE_BASE: KnowledgeEntry[] = [
  {
    id: 'gateway-connections',
    title: 'Gateway connections in the dashboard',
    url: '/dashboard/gateways',
    source: 'dashboard',
    excerpt:
      'Merchants connect Ozow, Yoco, and Paystack from the dashboard gateway page, and saved secrets stay masked after submission.',
    keywords: [
      'gateway',
      'gateway setup',
      'gateway connection',
      'ozow',
      'yoco',
      'paystack',
      'credentials',
      'configure',
    ],
    content:
      'Gateway connections are managed inside the authenticated dashboard at /dashboard/gateways. Ozow requires a site code, API key, private key, and test mode setting. Yoco requires a public key, secret key, and test mode setting. Paystack requires a secret key and test mode setting. Saved secrets remain masked after save, and the dashboard uses backend readback to show connection state without exposing raw credentials.',
  },
  {
    id: 'api-keys',
    title: 'Developer API keys',
    url: '/dashboard/api-keys',
    source: 'dashboard',
    excerpt:
      'API keys are created per merchant in test or live mode and the full secret is only shown once at creation time.',
    keywords: [
      'api key',
      'developer key',
      'test key',
      'live key',
      'secret key',
      'revoke key',
    ],
    content:
      'Stackaura developer keys are created from /dashboard/api-keys. Keys can be issued in test or live mode, revoked later, and are only fully visible at creation time. The dashboard thereafter shows masked prefixes only, so merchants should store secrets in a password manager when they are issued.',
  },
  {
    id: 'hosted-checkout-routing',
    title: 'Hosted checkout and routing',
    url: '/docs',
    source: 'docs',
    excerpt:
      'Hosted checkout supports explicit gateway choice and auto routing with fallback before provider checkout starts.',
    keywords: [
      'checkout',
      'hosted checkout',
      'payment link',
      'auto routing',
      'fallback',
      'gateway selection',
      'payment failed',
    ],
    content:
      'Hosted checkout and payment links run through Stackaura routing. Explicit gateway choice is respected exactly. Auto routing chooses the best eligible rail and can fallback only before provider checkout meaningfully starts. Once a customer has already been handed to a provider checkout, Stackaura should not silently switch rails.',
  },
  {
    id: 'gateway-troubleshooting',
    title: 'Gateway payment troubleshooting',
    url: '/dashboard/support',
    source: 'docs',
    excerpt:
      'Troubleshoot payment failures by checking gateway credentials, environment mismatches, callback URLs, and recent failed payment attempts before escalating.',
    keywords: [
      'why are payments failing',
      'payment failing',
      'ozow failing',
      'yoco failing',
      'paystack failing',
      'webhook issue',
      'callback url',
      'return url',
      'test mode',
      'live mode',
      'recent failed transactions',
      'provider-side issue',
    ],
    content:
      'When a gateway payment is failing, Stackaura support should first inspect the merchant-specific context: whether the gateway is fully connected, whether the gateway mode matches the test/live environment, whether recent failed payment attempts exist, and whether routing failed before provider handoff. If configuration looks correct, the next likely checks are callback and return URL alignment, provider request validation, and provider-side rejection or bank-side issues. Dashboard next steps should point the merchant to Gateway Connections, Developer Keys, and recent payment attempts before escalating to human support.',
  },
  {
    id: 'merchant-activation',
    title: 'Merchant activation and onboarding',
    url: '/signup',
    source: 'system',
    excerpt:
      'Merchants can remain pending until signup or onboarding requirements are complete, after which the account becomes active.',
    keywords: [
      'onboarding',
      'activation',
      'merchant pending',
      'pending account',
      'account pending',
      'signup payment',
    ],
    content:
      'Stackaura merchants can be created in a pending state during onboarding, then activated when signup requirements are complete. A merchant that is not active should not expect full live operations until onboarding and activation are finished. The support assistant should guide the merchant using their current active or pending state rather than generic advice.',
  },
  {
    id: 'payments-api',
    title: 'Payments API basics',
    url: '/docs',
    source: 'docs',
    excerpt:
      'Payments are created with Stackaura APIs and routed across supported gateways from one orchestration backend.',
    keywords: [
      'payments api',
      'integration',
      'api',
      'create payment',
      'payment intent',
      'webhook',
    ],
    content:
      'The Stackaura API supports POST /v1/payments/intents, POST /v1/payments, GET /v1/payments/:reference, and hosted checkout/payment link flows. Merchants integrate once and then use Stackaura routing, gateway connections, and webhook handling from one backend.',
  },
  {
    id: 'payouts',
    title: 'Payouts and settlements',
    url: '/docs',
    source: 'docs',
    excerpt:
      'Payout support is available from the payout service, with ZAR and DERIV rail currently supported in this build.',
    keywords: [
      'payout',
      'settlement',
      'settlements',
      'withdrawal',
      'deriv',
      'transfer',
    ],
    content:
      'Stackaura payout functionality in the current backend supports ZAR payouts on the DERIV rail. Support responses should use the actual merchant payout status data when available and avoid promising payout rails or settlement features that are not present in the system.',
  },
  {
    id: 'support-escalation',
    title: 'Support escalation',
    url: '/dashboard/support',
    source: 'policy',
    excerpt:
      'Human support escalations route through wesupport@stackaura.co.za, while billing and general inquiries stay on separate addresses.',
    keywords: [
      'support',
      'human support',
      'escalate',
      'wesupport',
      'billing',
      'compliance',
      'fraud',
    ],
    content:
      'Dashboard support escalations are handed off to wesupport@stackaura.co.za as the official Stackaura support inbox. Billing matters belong to billing@stackaura.co.za, general inquiries belong to info@stackaura.co.za, and admin@stackaura.co.za is reserved for internal operations. The support AI should escalate unresolved or sensitive issues instead of pretending to solve them automatically.',
  },
];

@Injectable()
export class SupportKnowledgeService {
  search(queryRaw: string, limit = 3): SupportKnowledgeMatch[] {
    const query = this.normalize(queryRaw);
    const tokens = this.tokens(query);

    return KNOWLEDGE_BASE.map((entry) => {
      let score = 0;

      for (const keyword of entry.keywords) {
        const normalizedKeyword = this.normalize(keyword);
        if (query.includes(normalizedKeyword)) {
          score += 6;
        }

        for (const token of this.tokens(normalizedKeyword)) {
          if (tokens.has(token)) {
            score += 2;
          }
        }
      }

      const title = this.normalize(entry.title);
      if (query.includes(title)) {
        score += 8;
      }

      for (const token of this.tokens(title)) {
        if (tokens.has(token)) {
          score += 2;
        }
      }

      const contentTokens = this.tokens(entry.content);
      let contentHits = 0;
      for (const token of tokens) {
        if (contentTokens.has(token)) {
          contentHits += 1;
        }
      }
      score += contentHits;

      return {
        ...entry,
        score,
      };
    })
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  }

  defaultCitations(limit = 2): SupportCitation[] {
    return KNOWLEDGE_BASE.slice(0, limit).map((entry) => ({
      id: entry.id,
      title: entry.title,
      url: entry.url,
      excerpt: entry.excerpt,
      source: entry.source,
    }));
  }

  private normalize(value: string) {
    return value.trim().toLowerCase();
  }

  private tokens(value: string) {
    return new Set(
      this.normalize(value)
        .split(/[^a-z0-9]+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2),
    );
  }
}
