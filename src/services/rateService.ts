const PLATFORM_FEE = 0.05;
const DEFAULT_USDT_INR_RATE = 95;

export async function fetchUsdtInrRate(): Promise<number> {
  const configuredRate = Number(process.env.USDT_INR_RATE ?? DEFAULT_USDT_INR_RATE);

  if (!Number.isFinite(configuredRate) || configuredRate <= 0) {
    throw new Error('Invalid USDT_INR_RATE configuration');
  }

  return configuredRate;
}

export function applyPlatformFee(usdtAmount: number, rate: number): number {
  return Math.floor(usdtAmount * rate * (1 - PLATFORM_FEE));
}
