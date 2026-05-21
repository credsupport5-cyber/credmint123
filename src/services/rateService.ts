const COINGECKO_URL =
  'https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=inr';

const PLATFORM_FEE = 0.05;

export async function fetchUsdtInrRate(): Promise<number> {
  const res = await fetch(COINGECKO_URL);
  if (!res.ok) throw new Error(`CoinGecko API error: ${res.status}`);
  const data = (await res.json()) as { tether: { inr: number } };
  return data.tether.inr;
}

export function applyPlatformFee(usdtAmount: number, rate: number): number {
  return Math.floor(usdtAmount * rate * (1 - PLATFORM_FEE));
}
