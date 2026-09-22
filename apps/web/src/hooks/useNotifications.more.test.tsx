/**
 * The saved notifications arrive asynchronously, and the panel can be gone by
 * then (the user logs out, navigates to a page without the top bar). A late
 * answer must be dropped, not written into an unmounted hook. The same goes
 * for the edge cases of what the server stores: an answer without the list,
 * a notification with no optional fields, and a failed load or failed state
 * write — each must leave the panel usable and leave a trace in the log,
 * never a crash or a broken row.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'

const s = vi.hoisted(() => ({
  query: vi.fn(), mutate: vi.fn(),
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))
vi.mock('@microsoft/fetch-event-source', () => ({ fetchEventSource: vi.fn(() => new Promise(() => {})) }))
vi.mock('@/lib/apiBase', () => ({ apiUrl: (p: string) => p, authHeader: () => ({}) }))
vi.mock('@/lib/apollo', () => ({ apolloClient: { query: (o: unknown) => s.query(o), mutate: (o: unknown) => s.mutate(o) } }))
vi.mock('@/lib/clientLogger', () => ({ clientLogger: s.log }))

const { useNotifications } = await import('./useNotifications')

const bare = {
  id: 'n-2', type: 'generic', title: 't', titleFallback: null, message: 'm',
  messageKey: null, messageParams: null, severity: null,
  entityId: null, entityType: null, timestamp: '2026-09-22T10:00:00Z', read: false,
}

beforeEach(() => {
  vi.clearAllMocks()
  s.mutate.mockResolvedValue({ data: {} })
})

describe('useNotifications — saved notifications, edge cases', () => {
  it('an answer that arrives after unmount is dropped without touching state', async () => {
    let resolve!: (v: unknown) => void
    s.query.mockReturnValue(new Promise((r) => { resolve = r }))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { unmount } = renderHook(() => useNotifications())
    unmount()
    await act(async () => { resolve({ data: { myNotifications: [bare] } }) })
    // No "state update on an unmounted component" and nothing logged as a failure.
    expect(errors).not.toHaveBeenCalled()
    expect(s.log.error).not.toHaveBeenCalled()
    errors.mockRestore()
  })

  it('an answer without the list is an empty panel, not a crash', async () => {
    s.query.mockResolvedValue({ data: null })
    const { result } = renderHook(() => useNotifications())
    await waitFor(() => expect(s.query).toHaveBeenCalled())
    expect(result.current.notifications).toEqual([])
  })

  it('a stored notification with no optional fields gets safe defaults (severity info, no params)', async () => {
    s.query.mockResolvedValue({ data: { myNotifications: [bare] } })
    const { result } = renderHook(() => useNotifications())
    await waitFor(() => expect(result.current.notifications).toHaveLength(1))
    expect(result.current.notifications[0]).toEqual({
      id: 'n-2', type: 'generic', title: 't', title_fallback: undefined, message: 'm',
      message_key: undefined, message_params: undefined, severity: 'info',
      entity_id: undefined, entity_type: undefined, timestamp: '2026-09-22T10:00:00Z', read: false,
    })
    expect(result.current.unreadCount).toBe(1)
  })

  it('unreadable message params are logged, and the notification is still shown', async () => {
    s.query.mockResolvedValue({ data: { myNotifications: [{ ...bare, messageParams: '{not json' }] } })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { result } = renderHook(() => useNotifications())
    await waitFor(() => expect(result.current.notifications).toHaveLength(1))
    expect(result.current.notifications[0].message_params).toBeUndefined()
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('message params are not readable'), 'n-2', expect.anything())
    errors.mockRestore()
  })

  it('saved notifications are shown newest first, whatever order the server sends', async () => {
    s.query.mockResolvedValue({ data: { myNotifications: [
      { ...bare, id: 'old', timestamp: '2026-09-20T10:00:00Z' },
      { ...bare, id: 'new', timestamp: '2026-09-22T10:00:00Z' },
      { ...bare, id: 'mid', timestamp: '2026-09-21T10:00:00Z' },
    ] } })
    const { result } = renderHook(() => useNotifications())
    await waitFor(() => expect(result.current.notifications).toHaveLength(3))
    expect(result.current.notifications.map((n) => n.id)).toEqual(['new', 'mid', 'old'])
  })

  it('a failed load is logged with its reason', async () => {
    s.query.mockRejectedValue('server said no')
    renderHook(() => useNotifications())
    await waitFor(() => expect(s.log.error).toHaveBeenCalledWith('Saved notifications could not be loaded', { error: 'server said no' }))
  })

  it('a state write that fails keeps the local change and is logged', async () => {
    s.query.mockResolvedValue({ data: { myNotifications: [bare] } })
    s.mutate.mockRejectedValue(new Error('write refused'))
    const { result } = renderHook(() => useNotifications())
    await waitFor(() => expect(result.current.unreadCount).toBe(1))
    act(() => { result.current.markAsRead('n-2') })
    expect(result.current.unreadCount).toBe(0)
    await waitFor(() => expect(s.log.error).toHaveBeenCalledWith('Notification state not saved on the server', { error: 'write refused' }))
  })
})
