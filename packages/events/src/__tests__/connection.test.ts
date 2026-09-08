import { describe, it, expect, vi } from 'vitest'
import type { Queue } from 'bullmq'
import { registerQueue, closeConnection, openQueueCount } from '../connection.js'

function fakeQueue(): Queue & { close: ReturnType<typeof vi.fn> } {
  return { close: vi.fn(async () => {}) } as unknown as Queue & { close: ReturnType<typeof vi.fn> }
}

describe('closeConnection — really closes the registered queues (D-24)', () => {
  it('closes every registered queue once, runs onClosed, and empties the registry', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const q1 = fakeQueue(); const q2 = fakeQueue()
    const onClosed = vi.fn()
    registerQueue(q1, onClosed)
    registerQueue(q2)
    expect(openQueueCount()).toBe(2)

    await closeConnection()
    expect(q1.close).toHaveBeenCalledTimes(1)
    expect(q2.close).toHaveBeenCalledTimes(1)
    expect(onClosed).toHaveBeenCalledTimes(1)
    expect(openQueueCount()).toBe(0)

    // Idempotent: a second call closes nothing again.
    await closeConnection()
    expect(q1.close).toHaveBeenCalledTimes(1)
  })

  it('propagates a queue close failure (shutdown must see it)', async () => {
    const bad = fakeQueue()
    bad.close.mockRejectedValueOnce(new Error('redis gone'))
    registerQueue(bad)
    await expect(closeConnection()).rejects.toThrow('redis gone')
    expect(openQueueCount()).toBe(0)
  })
})
