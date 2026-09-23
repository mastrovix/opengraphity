/**
 * NOTIFICATIONS: reading one, and a channel that outlives the page.
 *
 * Marking ONE notification read must leave the others as they were — the
 * badge counts the rest — and the write to the server must not block the
 * panel; when it fails, whatever was thrown is logged as text. And the
 * real-time channel can open after the page that asked for it is gone (a
 * slow network, a quick navigation): it must then change nothing — not mark
 * a dead hook «connected», not write the saved notifications into it.
 * `useNotifications.test.tsx`, `.more.test.tsx` and `useNotificationsChannel.test.tsx`
 * cover the rest.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'

type Handlers = { onopen: (r: { ok: boolean; status: number }) => Promise<void> }
const s = vi.hoisted(() => ({
  calls: [] as Handlers[],
  query: vi.fn(), mutate: vi.fn(),
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))
vi.mock('@microsoft/fetch-event-source', () => ({
  fetchEventSource: vi.fn((_url: string, h: Handlers) => { s.calls.push(h); return new Promise(() => {}) }),
}))
vi.mock('@/lib/apiBase', () => ({ apiUrl: (p: string) => p, authHeader: () => ({}) }))
vi.mock('@/lib/apollo', () => ({ apolloClient: { query: (o: unknown) => s.query(o), mutate: (o: unknown) => s.mutate(o) } }))
vi.mock('@/lib/clientLogger', () => ({ clientLogger: s.log }))

const { useNotifications } = await import('./useNotifications')

const saved = (id: string, timestamp: string) => ({
  id, type: 'generic', title: `title ${id}`, titleFallback: null, message: 'm', messageKey: null, messageParams: null,
  severity: 'info', entityId: null, entityType: null, timestamp, read: false,
})

beforeEach(() => {
  s.calls.length = 0
  s.query.mockReset()
  s.mutate.mockReset()
  for (const f of Object.values(s.log)) f.mockReset()
  s.query.mockResolvedValue({ data: { myNotifications: [saved('a', '2026-09-22T10:00:00Z'), saved('b', '2026-09-22T09:00:00Z')] } })
  s.mutate.mockResolvedValue({ data: {} })
})

describe('reading a notification', () => {
  it('marks that one read and leaves the others as they were', async () => {
    const { result } = renderHook(() => useNotifications())
    await waitFor(() => expect(result.current.notifications).toHaveLength(2))
    act(() => { result.current.markAsRead('a') })
    expect(result.current.notifications.map((n) => [n.id, n.read])).toEqual([['a', true], ['b', false]])
    expect(result.current.unreadCount).toBe(1)
    expect(s.mutate).toHaveBeenCalledWith(expect.objectContaining({ variables: { id: 'a' } }))
  })

  it('a write the server refuses is logged with what was thrown, even if it is not an Error', async () => {
    s.mutate.mockRejectedValue('offline')
    const { result } = renderHook(() => useNotifications())
    await waitFor(() => expect(result.current.notifications).toHaveLength(2))
    act(() => { result.current.markAsRead('a') })
    await waitFor(() => expect(s.log.error).toHaveBeenCalledWith('Notification state not saved on the server', { error: 'offline' }))
    // The panel does not wait for the server: the notification is read.
    expect(result.current.notifications[0]!.read).toBe(true)
  })
})

describe('a channel that opens after the page is gone', () => {
  it('changes nothing: no «connected», nothing written, nothing logged', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { result, unmount } = renderHook(() => useNotifications())
    await waitFor(() => expect(s.calls).toHaveLength(1))
    await waitFor(() => expect(result.current.notifications).toHaveLength(2))
    const before = result.current
    unmount()
    s.query.mockClear()
    await act(async () => { await s.calls[0]!.onopen({ ok: true, status: 200 }) })
    // The reload that the opening asks for still goes out, and its answer is dropped.
    await waitFor(() => expect(s.query).toHaveBeenCalledTimes(1))
    await act(async () => { await Promise.resolve() })
    expect(result.current).toBe(before)
    expect(errors).not.toHaveBeenCalled()
    expect(s.log.error).not.toHaveBeenCalled()
    errors.mockRestore()
  })
})
