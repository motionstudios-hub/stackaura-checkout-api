import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import type { GatewayRedirectForm } from '../gateways/gateway.types';
import { PaymentsService } from '../payments/payments.service';
import { PrismaService } from '../prisma/prisma.service';

@Controller('checkout')
export class CheckoutController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentsService: PaymentsService,
  ) {}

  @Get('cancel')
  async cancel(
    @Query() query: Record<string, string | string[] | undefined>,
    @Res() res: Response,
  ) {
    return this.tryFailoverAndRedirect(query, res, 'cancel');
  }

  @Get('error')
  async error(
    @Query() query: Record<string, string | string[] | undefined>,
    @Res() res: Response,
  ) {
    return this.tryFailoverAndRedirect(query, res, 'error');
  }

  @Get('success')
  async success(
    @Query() query: Record<string, string | string[] | undefined>,
    @Res() res: Response,
  ) {
    const reference = this.extractPaymentReference(query);
    const context = await this.loadStatusPageContext(reference);
    const content = this.resolveStatusContent('success', context);

    return res
      .status(200)
      .type('html')
      .send(
        this.renderStatusPage({
          title: content.title,
          status: content.status,
          message: content.message,
          reference: context?.reference ?? reference,
          gateway: context?.gateway ?? null,
          tone: content.tone,
        }),
      );
  }

  @Get(':checkoutToken')
  async getCheckout(
    @Param('checkoutToken') checkoutToken: string,
    @Res() res: Response,
  ) {
    const payment = await this.prisma.payment.findFirst({
      where: {
        checkoutToken,
        expiresAt: { gt: new Date() },
      },
      select: {
        id: true,
        merchantId: true,
        reference: true,
        amountCents: true,
        currency: true,
        status: true,
        description: true,
        customerEmail: true,
        expiresAt: true,
        gateway: true,
        rawGateway: true,
      },
    });

    if (!payment) {
      throw new NotFoundException('Checkout session not found or expired');
    }

    const merchant = await this.prisma.merchant.findUnique({
      where: { id: payment.merchantId },
      select: { name: true },
    });

    const latestAttempt = await this.prisma.paymentAttempt.findFirst({
      where: { paymentId: payment.id },
      orderBy: { createdAt: 'desc' },
      select: {
        redirectUrl: true,
        gateway: true,
      },
    });

    return res
      .status(200)
      .type('html')
      .send(
        this.renderCheckoutPage({
          merchantName: merchant?.name ?? 'Merchant',
          reference: payment.reference,
          amountCents: payment.amountCents,
          currency: payment.currency,
          status: payment.status,
          description: payment.description,
          customerEmail: payment.customerEmail,
          expiresAt: payment.expiresAt,
          gateway: latestAttempt?.gateway ?? payment.gateway ?? null,
          ...this.resolveRedirectState(
            payment.rawGateway,
            latestAttempt?.redirectUrl ?? null,
          ),
        }),
      );
  }

  private parseRedirectForm(value: unknown): GatewayRedirectForm | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const record = value as Record<string, unknown>;
    const action =
      typeof record.action === 'string' && record.action.trim()
        ? record.action.trim()
        : null;
    const method =
      typeof record.method === 'string' && record.method.trim().toUpperCase() === 'POST'
        ? 'POST'
        : null;
    const fields =
      record.fields && typeof record.fields === 'object' && !Array.isArray(record.fields)
        ? (record.fields as Record<string, unknown>)
        : null;

    if (!action || !method || !fields) {
      return null;
    }

    const normalizedFields: Record<string, string> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (typeof value === 'string') {
        normalizedFields[key] = value;
      } else if (typeof value === 'number' && Number.isFinite(value)) {
        normalizedFields[key] = String(value);
      }
    }

    return {
      action,
      method,
      fields: normalizedFields,
    };
  }

  private resolveRedirectState(rawGateway: unknown, fallbackRedirectUrl: string | null) {
    const root =
      rawGateway && typeof rawGateway === 'object' && !Array.isArray(rawGateway)
        ? (rawGateway as Record<string, unknown>)
        : null;
    const request =
      root?.request && typeof root.request === 'object' && !Array.isArray(root.request)
        ? (root.request as Record<string, unknown>)
        : root;
    const redirectForm = this.parseRedirectForm(
      request?.redirectForm ?? root?.redirectForm,
    );
    const redirectUrl =
      (typeof request?.redirectUrl === 'string' && request.redirectUrl.trim()) ||
      redirectForm?.action ||
      fallbackRedirectUrl;

    return {
      redirectUrl: redirectUrl ?? null,
      redirectForm,
    };
  }

  private async tryFailoverAndRedirect(
    query: Record<string, string | string[] | undefined>,
    res: Response,
    route: 'cancel' | 'error',
  ) {
    const reference = this.extractPaymentReference(query);
    const context = await this.loadStatusPageContext(reference);
    const content = this.resolveStatusContent(route, context);

    if (!reference) {
      return res
        .status(200)
        .type('html')
        .send(
          this.renderStatusPage({
            title: content.title,
            status: content.status,
            message: content.message,
            reference: null,
            gateway: null,
            tone: content.tone,
          }),
        );
    }

    const failover =
      await this.paymentsService.autoFailoverByReference(reference);

    if (failover?.redirectUrl) {
      return res.redirect(302, failover.redirectUrl);
    }

    return res
      .status(200)
      .type('html')
      .send(
        this.renderStatusPage({
          title: content.title,
          status: content.status,
          message: content.message,
          reference: context?.reference ?? reference,
          gateway: context?.gateway ?? null,
          tone: content.tone,
        }),
      );
  }

  private async loadStatusPageContext(reference: string | null) {
    const normalizedReference = reference?.trim();
    if (!normalizedReference) {
      return null;
    }

    const payment = await this.prisma.payment.findFirst({
      where: { reference: normalizedReference },
      select: {
        reference: true,
        gateway: true,
        rawGateway: true,
      },
    });

    if (!payment) {
      return null;
    }

    const rawGateway = this.asRecord(payment.rawGateway);
    const publicFlow = this.asRecord(rawGateway?.publicFlow);

    return {
      reference: payment.reference,
      gateway:
        typeof payment.gateway === 'string' && payment.gateway.trim()
          ? payment.gateway.trim()
          : null,
      isSignupFlow: publicFlow?.flow === 'merchant_signup',
    };
  }

  private resolveStatusContent(
    route: 'success' | 'cancel' | 'error',
    context: { isSignupFlow: boolean } | null,
  ) {
    if (context?.isSignupFlow) {
      if (route === 'success') {
        return {
          title: 'Merchant activation successful',
          status: 'SUCCESS',
          message:
            'Your activation payment was completed successfully. Your merchant account can now be activated.',
          tone: 'success' as const,
        };
      }

      if (route === 'cancel') {
        return {
          title: 'Merchant activation cancelled',
          status: 'CANCELLED',
          message:
            'The merchant activation payment was cancelled before completion.',
          tone: 'warning' as const,
        };
      }

      return {
        title: 'Merchant activation failed',
        status: 'ERROR',
        message: 'We couldn’t complete the merchant activation payment.',
        tone: 'error' as const,
      };
    }

    if (route === 'success') {
      return {
        title: 'Payment successful',
        status: 'SUCCESS',
        message: 'Your payment was completed successfully.',
        tone: 'success' as const,
      };
    }

    if (route === 'cancel') {
      return {
        title: 'Payment cancelled',
        status: 'CANCELLED',
        message: 'The payment was cancelled before completion.',
        tone: 'warning' as const,
      };
    }

    return {
      title: 'Payment failed',
      status: 'ERROR',
      message: 'We couldn’t complete the payment.',
      tone: 'error' as const,
    };
  }

  private renderCheckoutPage(args: {
    merchantName: string;
    reference: string;
    amountCents: number;
    currency: string;
    status: string;
    description: string | null;
    customerEmail: string | null;
    expiresAt: Date;
    gateway: string | null;
    redirectUrl: string | null;
    redirectForm: GatewayRedirectForm | null;
  }) {
    const amount = this.formatMoney(args.amountCents, args.currency);
    const expiresAt = new Date(args.expiresAt).toLocaleString();
    const expiresAtIso = new Date(args.expiresAt).toISOString();
    const description =
      args.description ?? 'Secure payment powered by Stackaura.';
    const customer = args.customerEmail ?? 'Not provided';
    const gateway = args.gateway ?? 'STACKAURA';
    const cta = args.redirectForm
      ? this.renderRedirectForm(args.redirectForm, gateway)
      : args.redirectUrl
        ? `<a class="cta" href="${this.escapeHtml(args.redirectUrl)}">Continue to ${this.escapeHtml(gateway)}</a>`
        : `<div class="muted-box">Gateway redirect is being prepared by Stackaura. Refresh this page in a moment if the payment link does not appear yet.</div>`;

    return `
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Stackaura Checkout</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #050505;
        --panel: #0d0d0f;
        --border: #202027;
        --muted: #9a9aa5;
        --text: #f5f5f7;
        --accent: #ffffff;
        --accentText: #000000;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        background: radial-gradient(circle at top, #111214 0%, var(--bg) 55%);
        color: var(--text);
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
      }
      .shell {
        width: 100%;
        max-width: 980px;
        display: grid;
        gap: 18px;
      }
      .brand {
        display: flex;
        align-items: center;
        gap: 14px;
      }
      .logo {
        width: 52px;
        height: 52px;
        border-radius: 16px;
        background: #fff;
        color: #000;
        display: grid;
        place-items: center;
        font-size: 28px;
        font-weight: 700;
      }
      .brand-copy h1 {
        margin: 0;
        font-size: 28px;
      }
      .brand-copy p {
        margin: 4px 0 0;
        color: var(--muted);
      }
      .grid {
        display: grid;
        gap: 18px;
        grid-template-columns: 1.2fr 0.8fr;
      }
      .card {
        border: 1px solid var(--border);
        background: rgba(13,13,15,0.92);
        border-radius: 24px;
        padding: 24px;
      }
      .eyebrow {
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.12em;
      }
      .amount {
        margin-top: 14px;
        font-size: 44px;
        font-weight: 700;
      }
      .description {
        margin-top: 10px;
        color: #d8d8de;
        line-height: 1.5;
      }
      .pill-row {
        margin-top: 18px;
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }
      .list {
        margin-top: 18px;
        display: grid;
        gap: 12px;
      }
      .row {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        border-top: 1px solid var(--border);
        padding-top: 12px;
        color: #d8d8de;
      }
      .row strong {
        color: var(--text);
      }
      .cta {
        display: inline-flex;
        justify-content: center;
        align-items: center;
        width: 100%;
        margin-top: 18px;
        min-height: 52px;
        border-radius: 16px;
        background: var(--accent);
        color: var(--accentText);
        font-weight: 700;
        text-decoration: none;
      }
      .muted-box {
        margin-top: 18px;
        border: 1px dashed var(--border);
        border-radius: 16px;
        padding: 14px;
        color: var(--muted);
        line-height: 1.5;
      }
      .badge {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        border: 1px solid var(--border);
        border-radius: 999px;
        padding: 8px 12px;
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .badge strong {
        color: var(--text);
        font-weight: 700;
      }
      .countdown {
        margin-top: 18px;
        padding: 16px;
        border-radius: 18px;
        border: 1px solid var(--border);
        background: rgba(255,255,255,0.02);
      }
      .countdown-label {
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .countdown-value {
        margin-top: 8px;
        font-size: 30px;
        font-weight: 700;
      }
      .countdown-sub {
        margin-top: 6px;
        color: var(--muted);
        font-size: 12px;
      }
      .stack {
        display: grid;
        gap: 16px;
      }
      @media (max-width: 820px) {
        .grid { grid-template-columns: 1fr; }
        .amount { font-size: 36px; }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="brand">
        <div class="logo">S</div>
        <div class="brand-copy">
          <h1>Stackaura Checkout</h1>
          <p>Secure multi-gateway payment orchestration</p>
        </div>
      </div>

      <div class="grid">
        <section class="card">
          <div class="eyebrow">Paying ${this.escapeHtml(args.merchantName)}</div>
          <div class="amount">${this.escapeHtml(amount)}</div>
          <div class="description">${this.escapeHtml(description)}</div>
          <div class="pill-row">
            <div class="badge">Gateway • <strong>${this.escapeHtml(gateway)}</strong></div>
            <div class="badge">Status • <strong>${this.escapeHtml(args.status)}</strong></div>
          </div>

          <div class="list">
            <div class="row">
              <span>Reference</span>
              <strong>${this.escapeHtml(args.reference)}</strong>
            </div>
            <div class="row">
              <span>Customer</span>
              <strong>${this.escapeHtml(customer)}</strong>
            </div>
            <div class="row">
              <span>Expires</span>
              <strong>${this.escapeHtml(expiresAt)}</strong>
            </div>
          </div>
        </section>

        <aside class="card stack">
          <div class="countdown">
            <div class="countdown-label">Checkout expires in</div>
            <div class="countdown-value" id="countdown">--:--</div>
            <div class="countdown-sub">Expires at ${this.escapeHtml(expiresAt)}</div>
          </div>
          ${cta}
          <div class="fine">
            By continuing, the shopper will be redirected to the selected payment gateway managed by Stackaura.
          </div>
        </aside>
      </div>
    </div>
    <script>
      (function () {
        const expiresAt = new Date(${JSON.stringify(expiresAtIso)}).getTime();
        const el = document.getElementById('countdown');
        if (!el) return;

        function render() {
          const remaining = Math.max(0, expiresAt - Date.now());
          const totalSeconds = Math.floor(remaining / 1000);
          const minutes = Math.floor(totalSeconds / 60);
          const seconds = totalSeconds % 60;
          el.textContent = \`\${String(minutes).padStart(2, '0')}:\${String(seconds).padStart(2, '0')}\`;
        }

        render();
        const timer = setInterval(() => {
          render();
          if (Date.now() >= expiresAt) {
            clearInterval(timer);
          }
        }, 1000);
      })();
    </script>
  </body>
</html>`;
  }

  private renderRedirectForm(
    redirectForm: GatewayRedirectForm,
    gateway: string,
  ) {
    const hiddenInputs = Object.entries(redirectForm.fields)
      .map(
        ([key, value]) =>
          `<input type="hidden" name="${this.escapeHtml(key)}" value="${this.escapeHtml(value)}" />`,
      )
      .join('');

    return `
<form id="gateway-form" method="${this.escapeHtml(redirectForm.method)}" action="${this.escapeHtml(redirectForm.action)}">
  ${hiddenInputs}
  <button class="cta" type="submit">Continue to ${this.escapeHtml(gateway)}</button>
</form>
<script>
  (function () {
    const form = document.getElementById('gateway-form');
    if (form) {
      form.submit();
    }
  })();
</script>`;
  }

  private renderStatusPage(args: {
    title: string;
    status: string;
    message: string;
    reference: string | null;
    gateway: string | null;
    tone: 'success' | 'warning' | 'error';
  }) {
    const accent =
      args.tone === 'success'
        ? '#1f9d55'
        : args.tone === 'warning'
          ? '#d97706'
          : '#dc2626';

    return `
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${this.escapeHtml(args.title)}</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        background: #050505;
        color: #f5f5f7;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        display: grid;
        place-items: center;
        padding: 24px;
      }
      .card {
        width: 100%;
        max-width: 640px;
        border-radius: 24px;
        border: 1px solid #202027;
        background: #0d0d0f;
        padding: 28px;
      }
      .badge {
        display: inline-flex;
        align-items: center;
        border-radius: 999px;
        padding: 8px 12px;
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        border: 1px solid ${accent};
        color: ${accent};
      }
      h1 {
        margin: 16px 0 10px;
        font-size: 32px;
      }
      p {
        margin: 0;
        color: #b4b4be;
        line-height: 1.6;
      }
      .meta {
        margin-top: 18px;
        border-top: 1px solid #202027;
        padding-top: 18px;
        color: #d8d8de;
      }
      .meta strong {
        color: #fff;
      }
    </style>
  </head>
  <body>
    <section class="card">
      <div class="badge">${this.escapeHtml(args.status)}</div>
      <h1>${this.escapeHtml(args.title)}</h1>
      <p>${this.escapeHtml(args.message)}</p>
      <div class="meta">
        <div><strong>Powered by:</strong> Stackaura Checkout</div>
        <div style="margin-top:8px;"><strong>Reference:</strong> ${this.escapeHtml(args.reference ?? 'Unavailable')}</div>
        ${args.gateway ? `<div style="margin-top:8px;"><strong>Gateway:</strong> ${this.escapeHtml(args.gateway)}</div>` : ''}
      </div>
    </section>
  </body>
</html>`;
  }

  private formatMoney(amountCents: number, currency: string) {
    return `${currency} ${(amountCents / 100).toFixed(2)}`;
  }

  private escapeHtml(value: string) {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private asRecord(value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    return value as Record<string, unknown>;
  }

  private extractPaymentReference(
    query: Record<string, string | string[] | undefined>,
  ) {
    const pick = (value: string | string[] | undefined) =>
      Array.isArray(value) ? value[0] : value;

    const candidates = [
      pick(query.reference),
      pick(query.m_payment_id),
      pick(query.payment_id),
      pick(query.TransactionReference),
      pick(query.transactionReference),
      pick(query.transaction_reference),
    ];

    for (const value of candidates) {
      const normalized = value?.trim();
      if (normalized) return normalized;
    }

    return null;
  }
}
