import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/authMiddleware';
import { adminMiddleware } from '../middleware/adminMiddleware';
import { getCache, setCache } from '../utils/cache';

const router = Router();

const SHARE_URL_KEY = 'app:share_url';
const REFERRAL_URL_KEY = 'app:referral_url';

// GET /config/share-url — public
router.get('/share-url', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const cached = await getCache<string>(SHARE_URL_KEY);
    const url = cached ?? process.env.APP_SHARE_URL ?? '';
    res.json({ url });
  } catch (err) {
    next(err);
  }
});

// POST /config/share-url — admin only
router.post('/share-url', authMiddleware, adminMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { url } = z.object({ url: z.string().url() }).parse(req.body);
    await setCache(SHARE_URL_KEY, url, 60 * 60 * 24 * 365);
    res.json({ url });
  } catch (err) {
    next(err);
  }
});

// GET /config/referral-url — public
router.get('/referral-url', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const cached = await getCache<string>(REFERRAL_URL_KEY);
    const url = cached ?? process.env.REFERRAL_URL ?? 'https://web.credmintfinance.online/login';
    res.json({ url });
  } catch (err) {
    next(err);
  }
});

// POST /config/referral-url — admin only
router.post('/referral-url', authMiddleware, adminMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { url } = z.object({ url: z.string().url() }).parse(req.body);
    await setCache(REFERRAL_URL_KEY, url, 60 * 60 * 24 * 365);
    res.json({ url });
  } catch (err) {
    next(err);
  }
});

export default router;
