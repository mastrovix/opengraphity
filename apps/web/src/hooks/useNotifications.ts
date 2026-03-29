import { useState, useEffect, useRef, useCallback } from 'react'
import { fetchEventSource } from '@microsoft/fetch-event-source'
import { keycloak } from '@/lib/keycloak'

export interface InAppNotification {
  id: string
  type: string
  title: string
  message: string
  severity: 'info' | 'warning' | 'error' | 'success'
  entity_id?: string
  entity_type?: string
  timestamp: string
  read: boolean
}

const MAX_NOTIFICATIONS = 50
const RECONNECT_DELAY_MS = 5_000

export function useNotifications() {
  const [notifications, setNotifications] = useState<InAppNotification[]>([])
  const abortRef       = useRef<AbortController | null>(null)
  const mountedRef     = useRef(true)
  const connectedRef   = useRef(false)

  const connect = useCallback(() => {
    if (!mountedRef.current) return

    const controller = new AbortController()
    abortRef.current = controller

    fetchEventSource('/api/sse', {
      headers: {
        Authorization: `Bearer ${keycloak.token ?? ''}`,
      },
      signal:         controller.signal,
      openWhenHidden: true,

      onmessage(ev) {
        if (!ev.data) return
        try {
          const raw = JSON.parse(ev.data) as InAppNotification & { type: string }
          // Skip connection confirmation message
          if (raw.type === 'connected') return
          const notif: InAppNotification = { ...raw, read: false }
          setNotifications(prev => {
            if (prev.some(n => n.id === notif.id)) return prev
            return [notif, ...prev].slice(0, MAX_NOTIFICATIONS)
          })
        } catch {
          // ignore malformed frames
        }
      },

      onerror() {
        // Throw to stop fetchEventSource internal retry — we handle it ourselves below
        throw new Error('sse-error')
      },
    }).catch(() => {
      // Schedule reconnect only if not intentionally aborted
      if (mountedRef.current && !controller.signal.aborted) {
        setTimeout(connect, RECONNECT_DELAY_MS)
      }
    })
  }, [])

  useEffect(() => {
    mountedRef.current = true
    if (connectedRef.current) return   // StrictMode: already connected from first mount
    connectedRef.current = true
    connect()
    return () => {
      mountedRef.current   = false
      connectedRef.current = false
      abortRef.current?.abort()
    }
  }, [])

  const markAsRead = useCallback((id: string) => {
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: true } : n))
  }, [])

  const markAllAsRead = useCallback(() => {
    setNotifications(prev => prev.map(n => ({ ...n, read: true })))
  }, [])

  const clearAll = useCallback(() => {
    setNotifications([])
  }, [])

  const unreadCount = notifications.filter(n => !n.read).length

  return { notifications, unreadCount, markAsRead, markAllAsRead, clearAll }
}
