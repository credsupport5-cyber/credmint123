-- Query indexes for user dashboards, history lists, admin queues, and daily spin counts.
-- Apply with Prisma using DIRECT_URL (the non-pooler Neon URL).

CREATE INDEX IF NOT EXISTS "User_referredById_createdAt_idx"
  ON "User" ("referredById", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "User_kycStatus_createdAt_idx"
  ON "User" ("kycStatus", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "UserPlan_userId_status_startDate_idx"
  ON "UserPlan" ("userId", "status", "startDate" DESC);
CREATE INDEX IF NOT EXISTS "UserPlan_status_idx"
  ON "UserPlan" ("status");

CREATE INDEX IF NOT EXISTS "Transaction_userId_createdAt_idx"
  ON "Transaction" ("userId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "Transaction_userId_type_createdAt_idx"
  ON "Transaction" ("userId", "type", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "PaymentSubmission_userId_createdAt_idx"
  ON "PaymentSubmission" ("userId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "PaymentSubmission_status_createdAt_idx"
  ON "PaymentSubmission" ("status", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "WithdrawalRequest_userId_createdAt_idx"
  ON "WithdrawalRequest" ("userId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "WithdrawalRequest_status_createdAt_idx"
  ON "WithdrawalRequest" ("status", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "SpinLog_userId_createdAt_idx"
  ON "SpinLog" ("userId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "Referral_referrerId_createdAt_idx"
  ON "Referral" ("referrerId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "Referral_referrerId_level_idx"
  ON "Referral" ("referrerId", "level");

CREATE INDEX IF NOT EXISTS "RefreshToken_userId_idx"
  ON "RefreshToken" ("userId");
