import { Test, TestingModule } from '@nestjs/testing';
import type { Request, Response } from 'express';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

describe('AuthController', () => {
  let controller: AuthController;
  let authService: {
    login: jest.Mock;
    resolveSession: jest.Mock;
    logoutByUserId: jest.Mock;
  };
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    process.env = { ...originalEnv };
    authService = {
      login: jest.fn(),
      resolveSession: jest.fn(),
      logoutByUserId: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: authService }],
    }).compile();

    controller = module.get<AuthController>(AuthController);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.clearAllMocks();
  });

  it('sets production-safe cookie attributes on login', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SESSION_COOKIE_NAME = 'stackaura_session';
    process.env.SESSION_COOKIE_SAME_SITE = 'none';
    process.env.SESSION_COOKIE_DOMAIN = '.stackaura.co.za';
    authService.login.mockResolvedValue({
      userId: 'u-1',
      sessionToken: 'signed-session-token',
      expiresAt: new Date('2026-03-20T12:00:00.000Z'),
    });

    const response = {
      cookie: jest.fn(),
    } as unknown as Response;

    await controller.login(
      { email: 'owner@example.com', password: 'ChangeMe123!' },
      response,
    );

    expect(authService.login).toHaveBeenCalledWith(
      'owner@example.com',
      'ChangeMe123!',
    );
    expect(
      (response as unknown as { cookie: jest.Mock }).cookie,
    ).toHaveBeenCalledWith(
      'stackaura_session',
      'signed-session-token',
      expect.objectContaining({
        httpOnly: true,
        sameSite: 'none',
        secure: true,
        path: '/',
        domain: '.stackaura.co.za',
      }),
    );
  });

  it('clears the session cookie with matching production attributes on logout', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SESSION_COOKIE_NAME = 'stackaura_session';
    process.env.SESSION_COOKIE_SAME_SITE = 'lax';
    process.env.SESSION_COOKIE_DOMAIN = '.stackaura.co.za';
    authService.resolveSession.mockResolvedValue({
      user: { id: 'u-1', email: 'owner@example.com' },
      memberships: [],
    });

    const request = {
      cookies: {
        stackaura_session: 'signed-session-token',
      },
    } as unknown as Request;
    const response = {
      clearCookie: jest.fn(),
    } as unknown as Response;

    await controller.logout(request, response);

    expect(authService.resolveSession).toHaveBeenCalledWith(
      'signed-session-token',
    );
    expect(authService.logoutByUserId).toHaveBeenCalledWith('u-1');
    expect(
      (response as unknown as { clearCookie: jest.Mock }).clearCookie,
    ).toHaveBeenCalledWith(
      'stackaura_session',
      expect.objectContaining({
        httpOnly: true,
        sameSite: 'lax',
        secure: true,
        path: '/',
        domain: '.stackaura.co.za',
      }),
    );
  });
});
