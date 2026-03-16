import { Body, Controller, Get, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';

type LoginDto = { email: string; password: string };

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  async login(@Body() body: LoginDto, @Res({ passthrough: true }) res: Response) {
    const { userId, sessionToken, expiresAt } = await this.auth.login(body.email, body.password);

    const cookieName = process.env.SESSION_COOKIE_NAME ?? 'stackaura_session';

    res.cookie(cookieName, sessionToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: false, // set true in prod (https)
      expires: expiresAt,
      path: '/',
    });

    return { ok: true, userId };
  }

  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const cookieName = process.env.SESSION_COOKIE_NAME ?? 'stackaura_session';
    const token = (req as any).cookies?.[cookieName];

    if (token) {
      const session = await this.auth.resolveSession(token);
      if (session?.user?.id) await this.auth.logoutByUserId(session.user.id);
    }

    res.clearCookie(cookieName, { path: '/' });
    return { ok: true };
  }

  @Get('me')
  async me(@Req() req: Request) {
    const cookieName = process.env.SESSION_COOKIE_NAME ?? 'stackaura_session';
    const token = (req as any).cookies?.[cookieName];

    const session = await this.auth.resolveSession(token);
    if (!session) throw new UnauthorizedException('Not authenticated');

    return session;
  }
}