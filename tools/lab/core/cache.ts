// In-memory read cache, valid for the lifetime of one process and nothing else, so no state ever persists across runs.
const maxEntries = 128
const ttlMs = 60_000
const entries = new Map<string, { value: unknown, expiresAt: number }>()

export function getCached<T>(key: string): T | undefined {
  const record = entries.get(key)
  if (!record) return undefined
  if (record.expiresAt <= Date.now()) {
    entries.delete(key)
    return undefined
  }
  entries.delete(key)
  entries.set(key, record)
  return record.value as T
}

export function setCached<T>(key: string, value: T): void {
  entries.set(key, { value, expiresAt: Date.now() + ttlMs })
  while (entries.size > maxEntries) {
    const oldest = entries.keys().next().value
    if (oldest === undefined) break
    entries.delete(oldest)
  }
}

// Invalidates every cached value whose key starts with the given prefix.
export function invalidateCached(prefix: string): void {
  for (const key of [...entries.keys()]) {
    if (key.startsWith(prefix)) entries.delete(key)
  }
}

export function clearCache(): void {
  entries.clear()
}
