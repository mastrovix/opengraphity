/**
 * THE REAL-TIME CHANNEL: frames, duplicates, drops and reconnections.
 *
 * A dropped SSE connection that reconnects is NOT a failure. Until 20 Sep
 * every drop was logged as `error`, and one tenant had piled up 1,074 lines
 * of "channel down — reconnecting": 87% of all its browser errors, now read
 * by the admin in the Logs page and by the self-analysis. The first drops are
 * `warn`; from the third in a row without ever reconnecting it is `error`,
 * and the counter resets at the first successful reconnection.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'

type Handlers = {
  onopen: (r: { ok: boolean; status: number }) => Promise<void>
  onmessage: (ev: { data: string }) => void
  onerror: () => void
  signal: AbortSignal
}
const s = vi.hoisted(() => ({
  calls: [] as Handlers[],
  rejecters: [] as Array<(e: unknown) => void>,
  query: vi.fn(), mutate: vi.fn(async (_o?: unknown) => ({ data: {} })),
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

vi.mock('@microsoft/fetch-event-source', () => ({
  fetchEventSource: vi.fn((_url: string, h: Handlers) => {
    s.calls.push(h)
    return new Promise((_res, rej) => { s.rejecters.push(rej) })
  }),
}))
vi.mock('@/lib/apiBase', () => ({ apiUrl: (p: string) => p, authHeader: () => ({}) }))
vi.mock('@/lib/apollo', () => ({ apolloClient: { query: (o: unknown) => s.query(o), mutate: (o: unknown) => s.mutate(o) } }))
vi.mock('@/lib/clientLogger', () => ({ clientLogger: s.log }))

const { useNotifications } = await import('./useNotifications')

const frame = (over: Record<string, unknown> = {}) => ({
  data: JSON.stringify({ id: 'n-9', type: 'incident.created', title: 't', message: 'm', severity: 'info', timestamp: '2026-09-22T10:00:00Z', ...over }),
})

beforeEach(() => {
  s.calls.length = 0; s.rejecters.length = 0
  s.query.mockReset(); s.query.mockResolvedValue({ data: { myNotifications: [] } })
  s.mutate.mockReset(); s.mutate.mockResolvedValue({ data: {} })
  for (const f of Object.values(s.log)) f.mockReset()
})
afterEach(() => { vi.useRealTimers() })

describe('the channel', () => {
  it('opening says "connected" and reloads what arrived while it was down', async () => {
    const { result } = renderHook(() => useNotifications())
    await waitFor(() => expect(s.calls).toHaveLength(1))
    expect(result.current.connected).toBe(false)
    await act(async () => { await s.calls[0]!.onopen({ ok: true, status: 200 }) })
    expect(result.current.connected).toBe(true)
    expect(s.query).toHaveBeenCalledTimes(2)   // mount + reconnection
  })

  it('a refused opening throws with the status, so it counts as a drop', async () => {
    renderHook(() => useNotifications())
    await waitFor(() => expect(s.calls).toHaveLength(1))
    await expect(s.calls[0]!.onopen({ ok: false, status: 401 })).rejects.toThrow('SSE connection refused: HTTP 401')
  })

  it('a frame becomes an unread notification, newest first, and a duplicate id is ignored', async () => {
    const { result } = renderHook(() => useNotifications())
    await waitFor(() => expect(s.calls).toHaveLength(1))
    act(() => {
      s.calls[0]!.onmessage(frame({ id: 'a', timestamp: '2026-09-22T09:00:00Z' }))
      s.calls[0]!.onmessage(frame({ id: 'b', timestamp: '2026-09-22T11:00:00Z' }))
      s.calls[0]!.onmessage(frame({ id: 'a', timestamp: '2026-09-22T09:00:00Z' }))
    })
    expect(result.current.notifications.map((n) => n.id)).toEqual(['b', 'a'])
    expect(result.current.unreadCount).toBe(2)
  })

  it('the "connected" handshake and empty frames are not notifications', async () => {
    const { result } = renderHook(() => useNotifications())
    await waitFor(() => expect(s.calls).toHaveLength(1))
    act(() => { s.calls[0]!.onmessage({ data: '' }); s.calls[0]!.onmessage(frame({ type: 'connected' })) })
    expect(result.current.notifications).toHaveLength(0)
  })

  it('a malformed frame is LOGGED, not dropped in silence', async () => {
    renderHook(() => useNotifications())
    await waitFor(() => expect(s.calls).toHaveLength(1))
    act(() => { s.calls[0]!.onmessage({ data: '{not json' }) })
    expect(s.log.error).toHaveBeenCalledWith('SSE notification frame malformed', expect.objectContaining({ frame: '{not json' }))
  })

  it('onerror throws, so the library does not retry on its own', async () => {
    renderHook(() => useNotifications())
    await waitFor(() => expect(s.calls).toHaveLength(1))
    expect(() => s.calls[0]!.onerror()).toThrow('sse-error')
  })

  it('drops are warnings until the third in a row, and a reconnection resets the count', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderHook(() => useNotifications())
    await waitFor(() => expect(s.calls).toHaveLength(1))
    for (let i = 0; i < 3; i++) {
      await act(async () => { s.rejecters[i]!(new Error('network')); await Promise.resolve() })
      await act(async () => { vi.advanceTimersByTime(5_000) })
      await waitFor(() => expect(s.calls).toHaveLength(i + 2))
    }
    expect(s.log.warn).toHaveBeenCalledTimes(2)
    expect(s.log.error).toHaveBeenCalledWith('SSE notification channel down — not recovering', expect.objectContaining({ consecutive: 3 }))

    await act(async () => { await s.calls[3]!.onopen({ ok: true, status: 200 }) })
    await act(async () => { s.rejecters[3]!('bare'); await Promise.resolve() })
    expect(s.log.warn).toHaveBeenLastCalledWith('SSE notification channel dropped — reconnecting', { error: 'bare', consecutive: 1 })
  })

  it('unmounting aborts the stream and does not reconnect', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { unmount } = renderHook(() => useNotifications())
    await waitFor(() => expect(s.calls).toHaveLength(1))
    const signal = s.calls[0]!.signal
    unmount()
    expect(signal.aborted).toBe(true)
    await act(async () => { s.rejecters[0]!(new Error('aborted')); await Promise.resolve() })
    await act(async () => { vi.advanceTimersByTime(10_000) })
    expect(s.calls).toHaveLength(1)
    expect(s.log.warn).not.toHaveBeenCalled()
  })
})

describe('saved notifications', () => {
  it('unreadable message params are logged and the notification still shows', async () => {
    const errore = vi.spyOn(console, 'error').mockImplementation(() => {})
    s.query.mockResolvedValue({ data: { myNotifications: [{
      id: 'n1', type: 'x', title: 't', titleFallback: 'Step', message: 'm', messageKey: 'k', messageParams: '{broken',
      severity: null, entityId: null, entityType: null, timestamp: '2026-01-01T00:00:00Z', read: false,
    }] } })
    const { result } = renderHook(() => useNotifications())
    await waitFor(() => expect(result.current.notifications).toHaveLength(1))
    expect(result.current.notifications[0]).toMatchObject({ severity: 'info', title_fallback: 'Step', message_params: undefined })
    expect(errore).toHaveBeenCalled()
    errore.mockRestore()
  })

  it('a failed load is logged, not thrown', async () => {
    s.query.mockRejectedValue(new Error('down'))
    renderHook(() => useNotifications())
    await waitFor(() => expect(s.log.error).toHaveBeenCalledWith('Saved notifications could not be loaded', { error: 'down' }))
  })

  it('a failed state write is logged, and the panel keeps the local change', async () => {
    s.mutate.mockRejectedValue(new Error('offline'))
    const { result } = renderHook(() => useNotifications())
    await waitFor(() => expect(s.calls).toHaveLength(1))
    act(() => { result.current.clearAll() })
    await waitFor(() => expect(s.log.error).toHaveBeenCalledWith('Notification state not saved on the server', { error: 'offline' }))
    expect(result.current.notifications).toHaveLength(0)
  })

  it('saved and live notifications merge by id, keeping the saved version', async () => {
    const { result } = renderHook(() => useNotifications())
    await waitFor(() => expect(s.calls).toHaveLength(1))
    act(() => { s.calls[0]!.onmessage(frame({ id: 'dup' })) })
    s.query.mockResolvedValue({ data: { myNotifications: [{
      id: 'dup', type: 'x', title: 't', titleFallback: null, message: 'm', messageKey: null, messageParams: null,
      severity: 'warning', entityId: null, entityType: null, timestamp: '2026-09-22T10:00:00Z', read: true,
    }] } })
    await act(async () => { await s.calls[0]!.onopen({ ok: true, status: 200 }) })
    await waitFor(() => expect(result.current.notifications[0]).toMatchObject({ id: 'dup', read: true }))
    expect(result.current.notifications).toHaveLength(1)
  })
})
