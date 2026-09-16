import { useState, useEffect, useRef, useCallback } from 'react'
import { gql } from '@apollo/client'
import { fetchEventSource } from '@microsoft/fetch-event-source'
import { apiUrl, authHeader } from '@/lib/apiBase'
import { apolloClient } from '@/lib/apollo'
import { clientLogger } from '@/lib/clientLogger'

export interface InAppNotification {
  id: string
  type: string
  /** Chiave i18n del titolo, così come la regola di notifica l'ha configurata. */
  title: string
  /**
   * Testo da mostrare quando `title` non è una chiave tradotta: per le
   * notifiche di passo è l'etichetta del passo (B-16). Senza, il pannello
   * mostrava la chiave grezza a chi aveva aggiunto un passo suo.
   */
  title_fallback?: string
  message: string
  /** Chiave i18n del messaggio e i suoi dati: il pannello compone la frase nella lingua di chi legge (CO-2). */
  message_key?: string
  message_params?: Record<string, string>
  severity: 'info' | 'warning' | 'error' | 'success'
  entity_id?: string
  entity_type?: string
  timestamp: string
  read: boolean
}

const MAX_NOTIFICATIONS = 50
const RECONNECT_DELAY_MS = 5_000

/*
  Revisione del 14 set 2026 · F10: le notifiche sono salvate sul server. Il
  pannello le carica all'avvio e a ogni riconnessione (quelle arrivate mentre
  il canale era giù non si perdono), e «letto», «tutto letto» e «svuota» si
  scrivono lì: prima erano la memoria del browser, e una ricarica le svuotava.
*/
const MY_NOTIFICATIONS = gql`
  query MyNotifications($limit: Int) {
    myNotifications(limit: $limit) {
      id type title titleFallback message messageKey messageParams severity entityId entityType timestamp read
    }
  }
`
const MARK_NOTIFICATION_READ = gql`
  mutation MarkNotificationRead($id: ID!) { markNotificationRead(id: $id) }
`
const MARK_ALL_NOTIFICATIONS_READ = gql`
  mutation MarkAllNotificationsRead { markAllNotificationsRead }
`
const DISMISS_ALL_NOTIFICATIONS = gql`
  mutation DismissAllNotifications { dismissAllNotifications }
`

interface SavedNotification {
  id: string; type: string; title: string; titleFallback: string | null; message: string
  messageKey: string | null; messageParams: string | null; severity: string | null
  entityId: string | null; entityType: string | null; timestamp: string; read: boolean
}

function fromSaved(n: SavedNotification): InAppNotification {
  let params: Record<string, string> | undefined
  if (n.messageParams) {
    /**
     * F-42: un `catch` muto lasciava la notifica con la chiave i18n non
     * interpolata a schermo («Ticket {{number}} assegnato»). I parametri non
     * si possono inventare, ma il difetto si dice nel log invece di
     * presentarsi all'utente come testo rotto.
     */
    try {
      params = JSON.parse(n.messageParams) as Record<string, string>
    } catch (e) {
      params = undefined
      console.error('[notifications] message params are not readable: the text will show without values', n.id, e)
    }
  }
  return {
    id: n.id, type: n.type, title: n.title, title_fallback: n.titleFallback ?? undefined,
    message: n.message, message_key: n.messageKey ?? undefined, message_params: params,
    severity: (n.severity ?? 'info') as InAppNotification['severity'],
    entity_id: n.entityId ?? undefined, entity_type: n.entityType ?? undefined,
    timestamp: n.timestamp, read: n.read,
  }
}

/** Una scrittura sul server che non deve bloccare il pannello, ma se fallisce si dice. */
function persistState(mutation: typeof MARK_NOTIFICATION_READ, variables?: Record<string, unknown>): void {
  apolloClient.mutate({ mutation, variables }).catch((err: unknown) => {
    clientLogger.error('Notification state not saved on the server', { error: err instanceof Error ? err.message : String(err) })
  })
}

export function useNotifications() {
  const [notifications, setNotifications] = useState<InAppNotification[]>([])
  // Truth-telling: the UI must be able to show that the realtime channel is
  // down — previously the hook reconnected forever in silence and the user
  // simply stopped receiving notifications with zero indication.
  const [connected, setConnected] = useState(false)
  const abortRef       = useRef<AbortController | null>(null)
  const mountedRef     = useRef(true)
  const connectedRef   = useRef(false)

  const loadSaved = useCallback(async () => {
    try {
      const res = await apolloClient.query<{ myNotifications: SavedNotification[] }>({
        query: MY_NOTIFICATIONS, variables: { limit: MAX_NOTIFICATIONS }, fetchPolicy: 'network-only',
      })
      if (!mountedRef.current) return
      const saved = (res.data?.myNotifications ?? []).map(fromSaved)
      setNotifications(prev => {
        const known = new Set(saved.map(n => n.id))
        return [...saved, ...prev.filter(n => !known.has(n.id))]
          .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
          .slice(0, MAX_NOTIFICATIONS)
      })
    } catch (err) {
      clientLogger.error('Saved notifications could not be loaded', { error: err instanceof Error ? err.message : String(err) })
    }
  }, [])

  const connect = useCallback(() => {
    if (!mountedRef.current) return

    const controller = new AbortController()
    abortRef.current = controller

    fetchEventSource(apiUrl('/api/sse'), {
      headers: authHeader(),
      signal:         controller.signal,
      openWhenHidden: true,

      // eslint-disable-next-line @typescript-eslint/require-await
      async onopen(res) {
        if (res.ok) {
          if (mountedRef.current) setConnected(true)
          void loadSaved()
          return
        }
        throw new Error(`SSE connection refused: HTTP ${res.status}`)
      },

      onmessage(ev) {
        if (!ev.data) return
        try {
          const raw = JSON.parse(ev.data) as InAppNotification & { type: string }
          // Skip connection confirmation message
          if (raw.type === 'connected') return
          const notif: InAppNotification = { ...raw, read: false }
          setNotifications(prev => {
            // Una notifica in ritardo non si scarta più (prima: oltre 60 s): è
            // salvata, e il pannello la mostra al suo posto. I doppioni per id no.
            if (prev.some(n => n.id === notif.id)) return prev
            return [notif, ...prev]
              .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
              .slice(0, MAX_NOTIFICATIONS)
          })
        } catch (err) {
          // A malformed frame is a server bug — log it, don't drop it silently.
          clientLogger.error('SSE notification frame malformed', {
            error: err instanceof Error ? err.message : String(err),
            frame: ev.data.slice(0, 200),
          })
        }
      },

      onerror() {
        // Throw to stop fetchEventSource internal retry — we handle it ourselves below
        throw new Error('sse-error')
      },
    }).catch((err: unknown) => {
      if (mountedRef.current) setConnected(false)
      // Schedule reconnect only if not intentionally aborted — and say so.
      if (mountedRef.current && !controller.signal.aborted) {
        clientLogger.error('SSE notification channel down — reconnecting', {
          error: err instanceof Error ? err.message : String(err),
        })
        setTimeout(connect, RECONNECT_DELAY_MS)
      }
    })
  }, [loadSaved])

  useEffect(() => {
    mountedRef.current = true
    void loadSaved()
    if (connectedRef.current) return   // StrictMode: already connected from first mount
    connectedRef.current = true
    connect()
    return () => {
      mountedRef.current   = false
      connectedRef.current = false
      abortRef.current?.abort()
    }
  }, [connect, loadSaved])

  const markAsRead = useCallback((id: string) => {
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: true } : n))
    persistState(MARK_NOTIFICATION_READ, { id })
  }, [])

  const markAllAsRead = useCallback(() => {
    setNotifications(prev => prev.map(n => ({ ...n, read: true })))
    persistState(MARK_ALL_NOTIFICATIONS_READ)
  }, [])

  const clearAll = useCallback(() => {
    setNotifications([])
    persistState(DISMISS_ALL_NOTIFICATIONS)
  }, [])

  const unreadCount = notifications.filter(n => !n.read).length

  return { notifications, unreadCount, connected, markAsRead, markAllAsRead, clearAll }
}
