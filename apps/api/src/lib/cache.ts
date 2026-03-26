class MemoryCache {
  private store = new Map<string, { data: unknown; expires: number }>()

  get<T>(key: string): T | null {
    const entry = this.store.get(key)
    if (!entry) return null
    if (Date.now() > entry.expires) {
      this.store.delete(key)
      return null
    }
    return entry.data as T
  }

  set(key: string, data: unknown, ttlSeconds: number): void {
    this.store.set(key, { data, expires: Date.now() + ttlSeconds * 1_000 })
  }

  invalidate(pattern: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(pattern)) this.store.delete(key)
    }
  }

  clear(): void {
    this.store.clear()
  }
}

export const cache = new MemoryCache()
