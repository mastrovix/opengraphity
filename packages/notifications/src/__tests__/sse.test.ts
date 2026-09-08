import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sseManager, type InAppNotification } from '../sse.js'

// sseManager is a process-wide singleton: every test disconnects what it
// connected so the registry is empty again (getConnectedCount() === 0).

type FakeRes = { write: ReturnType<typeof vi.fn<(data: string) => void>> }

function fakeRes(): FakeRes {
  return { write: vi.fn<(data: string) => void>() }
}

function notif(over: Partial<InAppNotification> = {}): InAppNotification {
  return {
    id: 'n-1', type: 'incident.created', title: 'notification.incident.created.title',
    message: 'DB down', severity: 'error', entity_id: 'inc-1', entity_type: 'incident',
    timestamp: '2026-09-08T10:00:00.000Z', read: false,
    ...over,
  }
}

const connected: string[] = []
function connect(tenantId: string, userId: string, res: FakeRes): string {
  const id = sseManager.connect(tenantId, userId, res)
  connected.push(id)
  return id
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  for (const id of connected.splice(0)) sseManager.disconnect(id)
  vi.useRealTimers()
  vi.restoreAllMocks()
  expect(sseManager.getConnectedCount()).toBe(0)
})

describe('SseManager — registration', () => {
  it('connect registers the client under its tenant and returns a unique id', () => {
    const a = connect('t1', 'u1', fakeRes())
    const b = connect('t1', 'u2', fakeRes())
    expect(a).toMatch(/^[0-9a-f-]{36}$/)
    expect(a).not.toBe(b)
    expect(sseManager.getConnectedCount('t1')).toBe(2)
    expect(sseManager.getConnectedCount('t2')).toBe(0)
    expect(sseManager.getConnectedCount()).toBe(2)
  })

  it('disconnect removes the client; a second/unknown disconnect is a no-op', () => {
    const res = fakeRes()
    const id = connect('t1', 'u1', res)
    sseManager.disconnect(id)
    expect(sseManager.getConnectedCount('t1')).toBe(0)
    expect(() => sseManager.disconnect(id)).not.toThrow()
    expect(() => sseManager.disconnect('does-not-exist')).not.toThrow()
    sseManager.sendToTenant('t1', notif())
    expect(res.write).not.toHaveBeenCalled()
  })
})

describe('SseManager — sendToTenant', () => {
  it('writes ONLY to the clients of the target tenant (two tenants, one event)', () => {
    const t1a = fakeRes(); const t1b = fakeRes(); const t2 = fakeRes()
    connect('t1', 'u1', t1a)
    connect('t1', 'u2', t1b)
    connect('t2', 'u1', t2)   // same userId as t1/u1 — must not leak across tenants

    sseManager.sendToTenant('t1', notif())

    expect(t1a.write).toHaveBeenCalledTimes(1)
    expect(t1b.write).toHaveBeenCalledTimes(1)
    expect(t2.write).not.toHaveBeenCalled()
  })

  it('SSE frame format: a single `data: <json>` line terminated by a blank line, no `event:` line', () => {
    const res = fakeRes()
    connect('t1', 'u1', res)
    const n = notif()
    sseManager.sendToTenant('t1', n)

    const frame = res.write.mock.calls[0]![0]
    expect(frame.startsWith('data: ')).toBe(true)
    expect(frame.endsWith('\n\n')).toBe(true)
    expect(frame).not.toContain('event:')
    expect(frame).not.toContain('id:')
    const parsed = JSON.parse(frame.slice('data: '.length, -2)) as InAppNotification
    expect(parsed).toEqual(n)
  })

  it('a tenant with no connected clients is a no-op (no throw)', () => {
    expect(() => sseManager.sendToTenant('nobody', notif())).not.toThrow()
  })
})

describe('SseManager — sendToUser', () => {
  it('targets (tenant, user): other users and the same user id in another tenant get nothing', () => {
    const target1 = fakeRes(); const target2 = fakeRes(); const other = fakeRes(); const foreign = fakeRes()
    connect('t1', 'u1', target1)
    connect('t1', 'u1', target2)   // second tab of the same user
    connect('t1', 'u2', other)
    connect('t2', 'u1', foreign)

    sseManager.sendToUser('t1', 'u1', notif({ id: 'n-user' }))

    expect(target1.write).toHaveBeenCalledTimes(1)
    expect(target2.write).toHaveBeenCalledTimes(1)
    expect(other.write).not.toHaveBeenCalled()
    expect(foreign.write).not.toHaveBeenCalled()
    expect(target1.write.mock.calls[0]![0]).toContain('"id":"n-user"')
  })
})

describe('SseManager — dead clients', () => {
  // BUG (packages/notifications/src/sse.ts:62-66 and :48-52): the write loop has
  // no try/catch. A client whose socket is gone (res.write throws) aborts the
  // broadcast — the clients registered after it never receive the event — and
  // the dead client stays in the registry. Expected: skip + remove the dead
  // client, keep writing to the others.
  it('a client whose write() throws is dropped and does not block the others — BUG: no try/catch around res.write (sse.ts:64)', () => {
    const dead = fakeRes()
    dead.write.mockImplementation(() => { throw new Error('write after end') })
    const alive = fakeRes()
    const deadId = connect('t1', 'u1', dead)
    connect('t1', 'u2', alive)

    expect(() => sseManager.sendToTenant('t1', notif())).not.toThrow()
    expect(alive.write).toHaveBeenCalledTimes(1)
    // the dead client must have been evicted
    expect(sseManager.getConnectedCount('t1')).toBe(1)
    sseManager.disconnect(deadId)
  })

})

describe('SseManager — no heartbeat', () => {
  it('pinned: the manager schedules no keep-alive writes (heartbeat, if any, is the HTTP layer\'s job)', () => {
    vi.useFakeTimers()
    const res = fakeRes()
    connect('t1', 'u1', res)
    vi.advanceTimersByTime(5 * 60_000)
    expect(res.write).not.toHaveBeenCalled()
  })
})
