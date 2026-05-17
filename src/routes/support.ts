import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { authMiddleware } from '../middleware/authMiddleware';

const router = Router();

router.use(authMiddleware);

const ticketSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  description: z.string().min(1, 'Description is required').max(2000),
});

router.post('/ticket', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, description } = ticketSchema.parse(req.body);
    const ticket = await prisma.supportTicket.create({
      data: { userId: req.user!.userId, name, description },
      select: { id: true, name: true, status: true, createdAt: true },
    });
    res.status(201).json({ message: 'Ticket submitted successfully', ticket });
  } catch (err) {
    next(err);
  }
});

router.get('/tickets', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tickets = await prisma.supportTicket.findMany({
      where: { userId: req.user!.userId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, description: true, status: true, createdAt: true },
    });
    res.json({ tickets });
  } catch (err) {
    next(err);
  }
});

export default router;
