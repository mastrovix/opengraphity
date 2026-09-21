/**
 * Revisione del 14 set 2026 · F10: il pannello era la memoria del browser. Una
 * ricarica lo svuotava, «letto» non sopravviveva, e un evento in ritardo di
 * oltre 60 secondi veniva scartato. Ora carica le notifiche salvate e ne
 * scrive lo stato.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'

vi.mock('@microsoft/fetch-event-source', () => ({ fetchEventSource: vi.fn(() => new Promise(() => {})) }))
vi.mock('@/lib/apiBase', () => ({ apiBase: '', apiUrl: (p: string) => p, authHeader: () => ({}) }))
const query = vi.fn()
const mutate = vi.fn(async (_opts: unknown) => ({ data: {} }))
vi.mock('@/lib/apollo', () => ({ apolloClient: { query: (opts: unknown) => query(opts), mutate: (opts: unknown) => mutate(opts) } }))

const { useNotifications } = await import('./useNotifications')

const saved = {
  id: 'n-1', type: 'mention', title: 'notification.mention.title', titleFallback: null, message: 'm',
  messageKey: 'inApp.mention.message', messageParams: '{"author":"Bob"}', severity: 'info',
  entityId: 'inc-1', entityType: 'incident', timestamp: '2020-01-01T00:00:00.000Z', read: true,
}

describe('useNotifications', () => {
  beforeEach(() => { vi.clearAllMocks(); query.mockResolvedValue({ data: { myNotifications: [saved] } }) })

  it('all\'avvio carica le notifiche salvate, anche vecchie, con lo stato letto', async () => {
    const { result } = renderHook(() => useNotifications())
    await waitFor(() => expect(result.current.notifications).toHaveLength(1))
    expect(result.current.notifications[0]).toMatchObject({ id: 'n-1', read: true, message_key: 'inApp.mention.message', message_params: { author: 'Bob' }, entity_id: 'inc-1' })
    expect(result.current.unreadCount).toBe(0)
  })

  it('letto, tutto letto e svuota passano dal server', async () => {
    query.mockResolvedValue({ data: { myNotifications: [{ ...saved, read: false }] } })
    const { result } = renderHook(() => useNotifications())
    await waitFor(() => expect(result.current.unreadCount).toBe(1))
    act(() => { result.current.markAsRead('n-1') })
    expect(result.current.unreadCount).toBe(0)
    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ variables: { id: 'n-1' } }))
    act(() => { result.current.markAllAsRead() })
    act(() => { result.current.clearAll() })
    expect(result.current.notifications).toHaveLength(0)
    expect(mutate).toHaveBeenCalledTimes(3)
  })
})
