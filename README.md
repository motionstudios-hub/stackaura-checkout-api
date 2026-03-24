<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## API auth headers

Protected endpoints accept:

- `Authorization: Bearer <ck_...>` (primary)
- `x-api-key: <ck_...>` (backward-compatible fallback when `Authorization` is missing)

If `Authorization` is present, it must be a valid Bearer header.

Endpoints currently using this auth pattern:

- `POST /v1/payments`
- `GET /v1/payments`
- `GET /v1/payments/:reference`
- `GET /v1/payments/:reference/attempts`
- `POST /v1/payments/:reference/failover`
- `POST /v1/payouts`
- `GET /v1/payouts/:id`
- `POST /v1/merchants/:merchantId/gateways/payfast`
- `POST /v1/merchants/:merchantId/gateways/ozow`
- `POST /v1/webhooks/merchants/:merchantId/endpoints`
- `GET /v1/webhooks/merchants/:merchantId/endpoints`
- `POST /v1/webhooks/endpoints/:endpointId/rotate-secret`
- `GET /v1/webhooks/endpoints/:endpointId/deliveries`
- `POST /v1/webhooks/deliveries/:deliveryId/retry`

Preferred examples:

```bash
curl -X POST http://localhost:3001/v1/payments \
  -H "Authorization: Bearer ck_test_..." \
  -H "Content-Type: application/json" \
  -d '{"amountCents":1000,"gateway":"AUTO","reference":"INV-AUTO-1"}'

curl http://localhost:3001/v1/payments/INV-123 \
  -H "Authorization: Bearer ck_test_..."

curl http://localhost:3001/v1/payments/INV-123/attempts \
  -H "Authorization: Bearer ck_test_..."

curl "http://localhost:3001/v1/payments?status=PAID&gateway=PAYFAST&from=2026-02-27&to=2026-02-27&q=INV&limit=25" \
  -H "Authorization: Bearer ck_test_..."

curl "http://localhost:3001/v1/payments?cursor=<nextCursor>&limit=25" \
  -H "Authorization: Bearer ck_test_..."

curl -X POST http://localhost:3001/v1/payments \
  -H "Authorization: Bearer ck_test_..." \
  -H "Content-Type: application/json" \
  -d '{"amountCents":1500,"reference":"INV-OZOW-1","gateway":"OZOW","customerEmail":"buyer@example.com"}'

curl -X POST http://localhost:3001/v1/payments/INV-AUTO-1/failover \
  -H "Authorization: Bearer ck_test_..."
```

## Commission + gateway failover

Merchant config fields:

- `platformFeeBps` (default `0`)
- `platformFeeFixedCents` (default `0`)
- `gatewayOrder` JSON (default `["OZOW","PAYFAST"]`)

Payment computed fields:

- `platformFeeCents`
- `merchantNetCents`

Fee formula on create:

- `fee = fixed + round(amountCents * bps / 10000)`
- Clamp fee to `0..amountCents`
- `merchantNetCents = amountCents - platformFeeCents`

Gateway routing:

- `gateway` omitted or `AUTO` chooses the first configured gateway from `gatewayOrder`
- if merchant `gatewayOrder` is `null`, server falls back to `GATEWAY_ORDER_DEFAULT` env
- every generated redirect creates a `PaymentAttempt` row
- `GET /v1/payments/:reference/attempts` returns attempts newest-first
- `GET /v1/payments` and `GET /v1/payments/:reference` include `currentAttemptId` and `attempts`
- `POST /v1/payments/:reference/failover` creates the next attempt in order
- `/v1/checkout/cancel` and `/v1/checkout/error` auto-fail over when a payment reference is present

## Swagger / OpenAPI docs

- UI: `GET /docs`
- JSON: `GET /docs-json`
- Title: `checkout-api`

Swagger auth:

1. Open `/docs`
2. Click `Authorize`
3. Paste your token only, for example: `ck_test_...`
4. Swagger sends `Authorization: Bearer <token>` automatically

Local:

- `http://localhost:3001/docs`
- `http://localhost:3001/docs-json`

Ngrok:

- `https://<your-ngrok-domain>/docs`
- `https://<your-ngrok-domain>/docs-json`

Production behavior:

- If `NODE_ENV=production`, docs are disabled by default.
- To enable docs in production, set `SWAGGER_ENABLED=true`.

## PayFast production safety

For real payments:

- Set `PAYFAST_VERIFY_POSTBACK=true`
- Ensure PayFast ITN can reach your service (`ngrok` for local dev, public domain in production)

Safety rule in code:

- `PAYFAST_VERIFY_POSTBACK=false` is allowed only when `NODE_ENV !== production`
- In production, `PAYFAST_VERIFY_POSTBACK=false` causes ITN processing to fail closed

## Merchant secret migration

Stackaura now encrypts merchant gateway credentials at rest. New writes are encrypted automatically, and legacy plaintext values should be migrated before broad launch.

Fields covered:

- `payfastMerchantKey`
- `payfastPassphrase`
- `ozowPrivateKey`
- `ozowApiKey`
- `yocoSecretKey`
- `yocoWebhookSecret`
- `paystackSecretKey`

Required production env before running the migration:

- `DATABASE_URL`
- `CREDENTIALS_ENCRYPTION_SECRET`

Dry run:

```bash
npm run merchant-secrets:migrate:dry-run
```

Apply the migration with a secure backup file:

```bash
npm run merchant-secrets:migrate -- --apply --backup-file=/secure/path/merchant-secret-backup.json
```

Verify that no plaintext merchant gateway secrets remain:

```bash
npm run merchant-secrets:verify
```

Rollback from a captured backup file:

```bash
ts-node src/scripts/migrate-merchant-secrets.ts --rollback-file=/secure/path/merchant-secret-backup.json
```

Operational notes:

- Treat the backup file as sensitive because it contains the original secret values.
- Store the backup outside the repo, restrict access, and delete it after verification.
- Take a database snapshot before the apply step so rollback can use either the backup file or the database snapshot.

## Merchant webhook deliveries

Webhook delivery is queue-based with retries. Delivery rows include:

- `status` (`PENDING` | `SUCCESS` | `FAILED`)
- `attempts`
- `lastStatusCode`
- `lastError`
- `nextAttemptAt`

Outbound delivery requests are signed with the endpoint `secret` using HMAC SHA-256:

- Header `X-Checkout-Delivery-Id`: stable delivery UUID (`WebhookDelivery.id`)
- Header `X-Checkout-Timestamp`: ISO timestamp used in signature input
- Header `X-Checkout-Signature`: `sha256=<hex_digest>`
- Canonical string: `<timestamp>.<rawBody>`
- JSON body shape:
  - `deliveryId` (uuid)
  - `event` (string)
  - `attempt` (number)
  - `data` (original event payload)

Examples:

```bash
# 1) Create merchant webhook endpoint
curl -X POST http://localhost:3001/v1/webhooks/merchants/<merchantId>/endpoints \
  -H "Authorization: Bearer ck_test_..." \
  -H "Content-Type: application/json" \
  -d '{"url":"https://merchant.example/webhooks/checkout"}'

# 2) Rotate endpoint secret
curl -X POST http://localhost:3001/v1/webhooks/endpoints/<endpointId>/rotate-secret \
  -H "Authorization: Bearer ck_test_..."

# 3) List endpoint deliveries
curl "http://localhost:3001/v1/webhooks/endpoints/<endpointId>/deliveries?limit=25" \
  -H "Authorization: Bearer ck_test_..."

# 4) Retry a failed delivery now
curl -X POST http://localhost:3001/v1/webhooks/deliveries/<deliveryId>/retry \
  -H "Authorization: Bearer ck_test_..."
```

Signature verification notes for webhook receivers:

- Use the raw request body exactly as received (before JSON re-serialization).
- Recompute `expected = HMAC_SHA256(endpointSecret, "<X-Checkout-Timestamp>.<rawBody>")`.
- Compare against `X-Checkout-Signature` after removing the `sha256=` prefix.
- Use `X-Checkout-Delivery-Id` (or `body.deliveryId`) as your dedupe key and ignore repeats.
- Use a constant-time comparison and reject stale timestamps (for example, older than 5 minutes).

Example signed request (local simulation):

```bash
timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
raw='{"deliveryId":"2dc0c0fb-cd91-4a08-9af2-36f5f70ad693","event":"payment.paid","attempt":1,"data":{"payment":{"reference":"INV-100","status":"PAID"}}}'
secret='whsec_replace_me'
sig="$(printf '%s.%s' "$timestamp" "$raw" | openssl dgst -sha256 -hmac "$secret" -hex | sed 's/^.* //')"

curl -X POST https://merchant.example/webhooks/checkout \
  -H "Content-Type: application/json" \
  -H "X-Checkout-Event: payment.paid" \
  -H "X-Checkout-Delivery-Id: 2dc0c0fb-cd91-4a08-9af2-36f5f70ad693" \
  -H "X-Checkout-Timestamp: ${timestamp}" \
  -H "X-Checkout-Signature: sha256=${sig}" \
  -d "$raw"
```

Example receiver verification + dedupe (Express):

```ts
import { createHmac, timingSafeEqual } from 'crypto';

app.post('/webhooks/checkout', express.raw({ type: 'application/json' }), (req, res) => {
  const timestamp = req.get('X-Checkout-Timestamp') ?? '';
  const signatureHeader = req.get('X-Checkout-Signature') ?? '';
  const deliveryId = req.get('X-Checkout-Delivery-Id') ?? '';
  const rawBody = req.body.toString('utf8');

  const received = signatureHeader.replace(/^sha256=/i, '');
  const expected = createHmac('sha256', process.env.CHECKOUT_ENDPOINT_SECRET!)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  const valid =
    received.length === expected.length &&
    timingSafeEqual(Buffer.from(received), Buffer.from(expected));
  if (!valid) return res.status(401).send('invalid signature');

  // Merchant-side dedupe: persist deliveryId and skip if already processed.
  if (hasProcessedDelivery(deliveryId)) return res.status(200).send('duplicate ignored');

  const payload = JSON.parse(rawBody) as {
    deliveryId: string;
    event: string;
    attempt: number;
    data: Record<string, unknown>;
  };

  handleCheckoutEvent(payload.event, payload.data);
  markDeliveryProcessed(deliveryId);
  return res.status(200).send('ok');
});
```

## Ozow gateway

Configure merchant Ozow credentials:

```bash
curl -X POST http://localhost:3001/v1/merchants/<merchantId>/gateways/ozow \
  -H "Authorization: Bearer ck_test_..." \
  -H "Content-Type: application/json" \
  -d '{"siteCode":"SC-1234","privateKey":"ozow_private_key","apiKey":"ozow_api_key"}'
```

Create payment with Ozow:

```bash
curl -X POST http://localhost:3001/v1/payments \
  -H "Authorization: Bearer ck_test_..." \
  -H "Content-Type: application/json" \
  -d '{"amountCents":2500,"reference":"INV-OZOW-123","gateway":"OZOW","customerEmail":"buyer@example.com"}'
```

Simulate Ozow webhook in dev:

```bash
curl -X POST http://localhost:3001/v1/webhooks/ozow \
  -H "Content-Type: application/json" \
  -d '{"SiteCode":"SC-1234","TransactionId":"oz-tx-123","TransactionReference":"INV-OZOW-123","Amount":"25.00","Status":"Complete","CurrencyCode":"ZAR","IsTest":"true","HashCheck":"<sha512>"}'
```

## Merchant onboarding MVP flow

Current API flow:

1. Create merchant
2. Create API key
3. Configure merchant PayFast credentials (`POST /v1/merchants/:merchantId/gateways/payfast`)
4. Create payment (`POST /v1/payments`) and redirect customer to `redirectUrl`
5. Receive PayFast ITN (`POST /v1/webhooks/payfast`) and update payment status
6. Fetch payment status (`GET /v1/payments/:reference`)

## Next product increments

- Merchant webhook deliveries: default endpoint bootstrap (optional), endpoint/secret management UI, retry + delivery log views
- Add second gateway: Ozow (recommended fast follow for SA EFT) or PayGate

## Project setup

```bash
$ npm install
```

## Compile and run the project

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production mode
$ npm run start:prod
```

## Local dev port + ngrok

```bash
# Run API on port 3001
$ PORT=3001 npm run start:dev

# Expose local API for webhooks
$ ngrok http 3001
```

## Run tests

```bash
# unit tests
$ npm run test

# e2e tests
$ npm run test:e2e

# test coverage
$ npm run test:cov
```

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ npm install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).
