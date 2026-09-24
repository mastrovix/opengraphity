/**
 * The Redis of the paged passes' cursors (lib/pagedPass.ts), in memory: for the
 * tests of a pass that do not mock `lib/bullmq.js` for anything else.
 *
 *   vi.mock('../../lib/bullmq.js', () => import('../../lib/__tests__/passCursorRedisFake.js'))
 */
const cursors = new Map<string, string>()

const redis = {
  get: async (key: string) => cursors.get(key) ?? null,
  set: async (key: string, value: string) => { cursors.set(key, value); return 'OK' },
  del: async (key: string) => (cursors.delete(key) ? 1 : 0),
}

export const getSharedRedis = () => redis

/** What a test left behind, so the next one starts from the first key. */
export function resetPassCursors(): void {
  cursors.clear()
}
