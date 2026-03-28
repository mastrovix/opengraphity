export interface RedisOptions {
  host: string
  port: number
}

export function getRedisOptions(): RedisOptions {
  return {
    host: process.env['REDIS_HOST'] ?? 'localhost',
    port: parseInt(process.env['REDIS_PORT'] ?? '6379', 10),
  }
}

/** No-op: kept for backward-compatible import in apps/api/src/index.ts */
export async function closeConnection(): Promise<void> {
  // BullMQ manages its own Redis connections internally
}
