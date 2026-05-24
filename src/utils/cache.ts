import { redis } from '../lib/redis';

export async function getCache<T>(key: string): Promise<T | null> {
  try {
    return await redis.get<T>(key);
  } catch {
    return null;
  }
}

export async function setCache(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  try {
    await redis.set(key, value, { ex: ttlSeconds });
  } catch {}
}

export async function delCache(key: string): Promise<void> {
  try {
    await redis.del(key);
  } catch {}
}
