import 'dotenv/config';
import { Logger, RequestMethod, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import cookieParser = require('cookie-parser');

export function assertPayfastPostbackPolicy() {
  const nodeEnv = process.env.NODE_ENV?.trim().toLowerCase();
  const verifyPostback =
    process.env.PAYFAST_VERIFY_POSTBACK?.trim().toLowerCase();

  if (nodeEnv === 'production' && verifyPostback === 'false') {
    throw new Error(
      'PAYFAST_VERIFY_POSTBACK=false is not allowed in production',
    );
  }
}

export function isSwaggerEnabled(env: NodeJS.ProcessEnv = process.env) {
  const nodeEnv = env.NODE_ENV?.trim().toLowerCase();
  const enabled = env.SWAGGER_ENABLED?.trim().toLowerCase() === 'true';
  return nodeEnv !== 'production' || enabled;
}

export function setupSwagger(app: INestApplication) {
  const config = new DocumentBuilder()
    .setTitle('checkout-api')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'ck_*',
        name: 'Authorization',
        in: 'header',
      },
      'bearer',
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);
  document.security = [{ bearer: [] }];
  SwaggerModule.setup('docs', app, document, {
    useGlobalPrefix: false,
    jsonDocumentUrl: '/docs-json',
    swaggerOptions: {
      persistAuthorization: true,
    },
  });
}

export async function bootstrap() {
  assertPayfastPostbackPolicy();
  const logger = new Logger('Bootstrap');

  // rawBody: true captures req.rawBody (Buffer) for signature verification
  const app = await NestFactory.create(AppModule, { rawBody: true });

  app.use(cookieParser());

  app.enableCors({
    origin: ['http://127.0.0.1:3000', 'http://localhost:3000'],
    credentials: true,
  });

  // All routes are under /v1 except provider-facing Ozow endpoints.
  app.setGlobalPrefix('v1', {
    exclude: [
      { path: 'payments/ozow/initiate', method: RequestMethod.POST },
      { path: 'payments/ozow/:reference/status', method: RequestMethod.GET },
      { path: 'webhooks/ozow', method: RequestMethod.POST },
    ],
  });
  if (isSwaggerEnabled()) {
    setupSwagger(app);
  }

  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port);
  logger.log(`Checkout API listening on http://localhost:${port}`);
}

if (require.main === module) {
  void bootstrap();
}
