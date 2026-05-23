import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { signAccessToken, signRefreshToken, verifyRefreshToken, generateReferralCode } from '../lib/auth';
import { AppError } from '../lib/errors';
import { authMiddleware } from '../middleware/authMiddleware';

const router = Router();

const registerSchema = z.object({
  phone: z.string().min(10).max(15),
  password: z.string().min(6),
  name: z.string().min(1).max(100),
  referralCode: z.string().optional(),
});

const loginSchema = z.object({
  phone: z.string().min(10),
  password: z.string().min(1),
});

// POST /auth/register
router.post('/register', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = registerSchema.parse(req.body);

    const existing = await prisma.user.findUnique({ where: { phone: body.phone } });
    if (existing) throw new AppError('PHONE_ALREADY_EXISTS', 'Phone already registered', 409);

    let referredById: string | undefined;
    let referrerId2: string | undefined;
    let referrerId3: string | undefined;
    if (body.referralCode) {
      const l1 = await prisma.user.findUnique({
        where: { referralCode: body.referralCode },
        select: {
          id: true,
          referredBy: {
            select: {
              id: true,
              referredBy: { select: { id: true } },
            },
          },
        },
      });
      if (l1) {
        referredById = l1.id;
        referrerId2  = l1.referredBy?.id;
        referrerId3  = l1.referredBy?.referredBy?.id;
      }
    }

    const passwordHash = await bcrypt.hash(body.password, 12);
    let referralCode = generateReferralCode(body.name);

    // Ensure unique referral code
    while (await prisma.user.findUnique({ where: { referralCode } })) {
      referralCode = generateReferralCode(body.name);
    }

    const user = await prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          phone: body.phone,
          passwordHash,
          name: body.name,
          referralCode,
          referredById,
          referrerId2,
          referrerId3,
        },
      });

      await tx.wallet.create({
        data: { userId: newUser.id },
      });

      return newUser;
    });

    const accessToken = signAccessToken({ userId: user.id, role: user.role });
    const refreshToken = signRefreshToken({ userId: user.id });

    const expiry = new Date();
    expiry.setDate(expiry.getDate() + 30);
    await prisma.refreshToken.create({
      data: { userId: user.id, token: refreshToken, expiresAt: expiry },
    });

    res.status(201).json({
      user: {
        id: user.id,
        phone: user.phone,
        name: user.name,
        kycStatus: user.kycStatus,
        referralCode: user.referralCode,
        role: user.role,
      },
      accessToken,
      refreshToken,
    });
  } catch (err) {
    next(err);
  }
});

// POST /auth/login
router.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = loginSchema.parse(req.body);

    const user = await prisma.user.findUnique({ where: { phone: body.phone } });
    if (!user) throw new AppError('INVALID_CREDENTIALS', 'Invalid phone or password', 401);

    const match = await bcrypt.compare(body.password, user.passwordHash);
    if (!match) throw new AppError('INVALID_CREDENTIALS', 'Invalid phone or password', 401);

    const accessToken = signAccessToken({ userId: user.id, role: user.role });
    const refreshToken = signRefreshToken({ userId: user.id });

    const expiry = new Date();
    expiry.setDate(expiry.getDate() + 30);
    await prisma.refreshToken.create({
      data: { userId: user.id, token: refreshToken, expiresAt: expiry },
    });

    res.json({
      user: {
        id: user.id,
        phone: user.phone,
        name: user.name,
        kycStatus: user.kycStatus,
        referralCode: user.referralCode,
        role: user.role,
      },
      accessToken,
      refreshToken,
    });
  } catch (err) {
    next(err);
  }
});

// POST /auth/refresh
router.post('/refresh', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { refreshToken } = z.object({ refreshToken: z.string() }).parse(req.body);

    const payload = verifyRefreshToken(refreshToken);

    const stored = await prisma.refreshToken.findUnique({ where: { token: refreshToken } });
    if (!stored || stored.expiresAt < new Date()) {
      throw new AppError('INVALID_REFRESH_TOKEN', 'Refresh token invalid or expired', 401);
    }

    const user = await prisma.user.findUnique({ where: { id: payload.userId } });
    if (!user) throw new AppError('INVALID_REFRESH_TOKEN', 'User not found', 401);

    const accessToken = signAccessToken({ userId: user.id, role: user.role });

    res.json({ accessToken });
  } catch (err) {
    next(err);
  }
});

// POST /auth/logout
router.post('/logout', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await prisma.refreshToken.deleteMany({ where: { userId: req.user!.userId } });
    res.json({ message: 'Logged out' });
  } catch (err) {
    next(err);
  }
});

export default router;
