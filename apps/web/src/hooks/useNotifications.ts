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

/**
 * DOPO QUANTE CADUTE DI FILA È UN GUASTO (20 set 2026).
 *
 * Una connessione SSE cade: un proxy che chiude, un portatile che si
 * sospende, la rete che salta un colpo. Si riconnette, e il fatto che si sia
 * riconnessa dice che NON era un guasto. Fino a stasera ogni caduta veniva
 * scritta come `error`, e su `c-one` si erano accumulate 1.074 righe di
 * «SSE notification channel down — reconnecting»: l'87% di tutti gli errori
 * del browser di quel cliente.
 *
 * Non era un problema finché non le leggeva nessuno. Da oggi le legge
 * l'admin del cliente nella sua pagina Log, e le legge l'Autoanalisi: la
 * prima cosa che avrebbe trovato sarebbe stato quel rumore, e avrebbe aperto
 * un incident su una riconnessione riuscita.
 *
 * Quindi: le prime cadute sono `warn` — è successo, si vede, non è un
 * guasto. Dalla terza di fila senza mai riuscire a riconnettersi diventa
 * `error`, ed è vero: il canale è giù davvero. Il contatore si azzera alla
 * prima riconnessione riuscita.
 */
const CADUTE_PRIMA_DI_CHIAMARLO_GUASTO = 3

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
  /** The reconnection waiting after a drop: the cleanup cancels it with the stream. */
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Cadute consecutive senza riuscire a riconnettersi. Zero = il canale sta su. */
  const caduteDiFilaRef = useRef(0)

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

      async onopen(res) {
        if (res.ok) {
          // Riconnessa: quello che è successo prima non era un guasto.
          caduteDiFilaRef.current = 0
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
        caduteDiFilaRef.current += 1
        const cadute = caduteDiFilaRef.current
        const dettagli = { error: err instanceof Error ? err.message : String(err), consecutive: cadute }
        if (cadute >= CADUTE_PRIMA_DI_CHIAMARLO_GUASTO) {
          // Tre volte di fila senza mai riuscire: il canale è giù davvero.
          clientLogger.error('SSE notification channel down — not recovering', dettagli)
        } else {
          // Una caduta che si riconnette non è un errore, ed è quello che è
          // stato fino a stasera: 1.074 righe di rumore su un tenant solo.
          clientLogger.warn('SSE notification channel dropped — reconnecting', dettagli)
        }
        reconnectTimerRef.current = setTimeout(connect, RECONNECT_DELAY_MS)
      }
    })
  }, [loadSaved])

  /*
   * One channel per run of the effect: the cleanup aborts the stream AND
   * cancels a reconnection still waiting, so a second run (StrictMode at
   * mount, Fast Refresh, an `Activity` shown again) opens the only live one.
   * A `connectedRef` guard for StrictMode stood here and could never fire,
   * because the cleanup reset it before the second run (tour of 23 Sep 2026);
   * the waiting reconnection, instead, opened a second channel.
   */
  useEffect(() => {
    mountedRef.current = true
    void loadSaved()
    connect()
    return () => {
      mountedRef.current = false
      if (reconnectTimerRef.current !== null) clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
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
