import { UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { ApiKeyGuard } from './api-key.guard';

describe('ApiKeyGuard', () => {
  let guard: ApiKeyGuard;
  let prisma: {
    apiKey: {
      findFirst: jest.Mock;
    };
  };
  let reflector: { getAllAndOverride: jest.Mock };

  const buildContext = (headers: Record<string, string | undefined>) => {
    const request = { headers } as {
      headers: Record<string, string | undefined>;
      apiKeyAuth?: { apiKeyId: string; merchantId: string; keyHash: string };
    };

    const context = {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
      getHandler: () => buildContext,
      getClass: () => ApiKeyGuard,
    } as unknown as ExecutionContext;

    return { context, request };
  };

  beforeEach(() => {
    prisma = {
      apiKey: {
        findFirst: jest.fn(),
      },
    };
    reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(false),
    };

    guard = new ApiKeyGuard(prisma as never, reflector as never);
  });

  it('bypasses auth for public routes', async () => {
    reflector.getAllAndOverride.mockReturnValueOnce(true);
    const { context, request } = buildContext({});

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(prisma.apiKey.findFirst).not.toHaveBeenCalled();
    expect(request.apiKeyAuth).toBeUndefined();
  });

  it('accepts Authorization Bearer API key', async () => {
    prisma.apiKey.findFirst.mockResolvedValue({
      id: 'key-1',
      merchantId: 'merchant-1',
    });
    const { context, request } = buildContext({
      authorization: 'Bearer ck_test_auth',
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(prisma.apiKey.findFirst).toHaveBeenCalled();
    expect(request.apiKeyAuth).toEqual(
      expect.objectContaining({
        apiKeyId: 'key-1',
        merchantId: 'merchant-1',
      }),
    );
  });

  it('falls back to x-api-key when Authorization is missing', async () => {
    prisma.apiKey.findFirst.mockResolvedValue({
      id: 'key-2',
      merchantId: 'merchant-2',
    });
    const { context, request } = buildContext({
      'x-api-key': 'ck_test_fallback',
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.apiKeyAuth?.merchantId).toBe('merchant-2');
  });

  it('rejects invalid Authorization header even if x-api-key exists', async () => {
    const { context } = buildContext({
      authorization: 'ck_test_invalid',
      'x-api-key': 'ck_test_fallback',
    });

    await expect(guard.canActivate(context)).rejects.toThrow(
      new UnauthorizedException('Invalid Authorization header'),
    );
  });

  it('rejects when both Authorization and x-api-key are missing', async () => {
    const { context } = buildContext({});

    await expect(guard.canActivate(context)).rejects.toThrow(
      new UnauthorizedException('Missing Authorization header'),
    );
  });
});
