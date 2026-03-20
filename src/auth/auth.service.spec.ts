import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  let service: AuthService;
  let prisma: {
    user: { findUnique: jest.Mock };
    membership: { findMany: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      user: {
        findUnique: jest.fn(),
      },
      membership: {
        findMany: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  it('logs in an active user with a valid password', async () => {
    const passwordHash = await argon2.hash('ChangeMe123!');
    prisma.user.findUnique.mockResolvedValue({
      id: 'u-1',
      email: 'owner@example.com',
      passwordHash,
      isActive: true,
    });

    const result = await service.login('owner@example.com', 'ChangeMe123!');

    expect(result).toEqual(
      expect.objectContaining({
        userId: 'u-1',
        sessionToken: expect.any(String),
        expiresAt: expect.any(Date),
      }),
    );
  });

  it('rejects login when the auth user is inactive', async () => {
    const passwordHash = await argon2.hash('ChangeMe123!');
    prisma.user.findUnique.mockResolvedValue({
      id: 'u-1',
      email: 'owner@example.com',
      passwordHash,
      isActive: false,
    });

    await expect(
      service.login('owner@example.com', 'ChangeMe123!'),
    ).rejects.toThrow(
      new UnauthorizedException(
        'Account not active. Complete signup to continue.',
      ),
    );
  });
});
