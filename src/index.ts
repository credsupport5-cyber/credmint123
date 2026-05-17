import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';

import authRouter from './routes/auth';
import userRouter from './routes/user';
import walletRouter from './routes/wallet';
import plansRouter from './routes/plans';
import paymentRouter from './routes/payment';
import withdrawalRouter from './routes/withdrawal';
import spinRouter from './routes/spin';
import teamRouter from './routes/team';
import adminRouter from './routes/admin';
import supportRouter from './routes/support';

import { errorHandler } from './middleware/errorHandler';
import { startCronJobs } from './services/cronService';

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

app.use(helmet());
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check
app.get('/health', (_, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// Routes
app.use('/v1/auth', authRouter);
app.use('/v1/user', userRouter);
app.use('/v1/wallet', walletRouter);
app.use('/v1/plans', plansRouter);
app.use('/v1/payment', paymentRouter);
app.use('/v1/withdrawal', withdrawalRouter);
app.use('/v1/spin', spinRouter);
app.use('/v1/team', teamRouter);
app.use('/v1/admin', adminRouter);
app.use('/v1/support', supportRouter);

// 404
app.use((_, res) => {
  res.status(404).json({ error: 'NOT_FOUND', message: 'Route not found', statusCode: 404 });
});

// Error handler (must be last)
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT} (${process.env.NODE_ENV})`);
  startCronJobs();
});

export default app;
