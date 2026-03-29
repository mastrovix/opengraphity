import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, GitPullRequest, Shield, Clock, Bell, CheckCheck } from 'lucide-react'
import { useNotificationContext } from '@/contexts/NotificationContext'
import type { InAppNotification } from '@/hooks/useNotifications'

// ── Helpers ───────────────────────────────────────────────────────────────────

function timeAgo(timestamp: string, t: ReturnType<typeof useTranslation>['t']): string {
  const diff    = Date.now() - new Date(timestamp).getTime()
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1)  return t('notifications.justNow')
  if (minutes < 60) return t('notifications.minAgo',   { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24)   return t('notifications.hoursAgo', { count: hours })
  return t('notifications.daysAgo', { count: Math.floor(hours / 24) })
}

function entityPath(notif: InAppNotification): string | null {
  if (!notif.entity_id || !notif.entity_type) return null
  switch (notif.entity_type) {
    case 'incident': return `/incidents/${notif.entity_id}`
    case 'change':   return `/changes/${notif.entity_id}`
    case 'problem':  return `/problems/${notif.entity_id}`
    default:         return null
  }
}

// ── Severity icon ─────────────────────────────────────────────────────────────

const SEVERITY_ICON: Record<string, { icon: React.FC<{ size: number; color: string }>; color: string }> = {
  error:   { icon: AlertTriangle, color: '#ef4444' },
  warning: { icon: Clock,         color: '#f59e0b' },
  success: { icon: Shield,        color: '#22c55e' },
  info:    { icon: Bell,          color: '#0284c7' },
}

function entityIcon(notif: InAppNotification) {
  if (notif.entity_type === 'change') return { icon: GitPullRequest, color: '#7c3aed' }
  return SEVERITY_ICON[notif.severity ?? 'info'] ?? SEVERITY_ICON['info']!
}

// ── NotificationItem ──────────────────────────────────────────────────────────

function NotificationItem({ notif, onClose }: { notif: InAppNotification; onClose: () => void }) {
  const { t }    = useTranslation()
  const navigate = useNavigate()
  const { markAsRead } = useNotificationContext()
  const { icon: Icon, color } = entityIcon(notif)

  function handleClick() {
    markAsRead(notif.id)
    const path = entityPath(notif)
    if (path) navigate(path)
    onClose()
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(e) => e.key === 'Enter' && handleClick()}
      style={{
        display:         'flex',
        gap:             12,
        padding:         '12px 16px',
        cursor:          entityPath(notif) ? 'pointer' : 'default',
        backgroundColor: notif.read ? '#ffffff' : '#f0f9ff',
        borderBottom:    '1px solid #f1f5f9',
        transition:      'background 0.15s',
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = '#f8fafc' }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = notif.read ? '#ffffff' : '#f0f9ff' }}
    >
      {/* Icon */}
      <div style={{ flexShrink: 0, marginTop: 2 }}>
        <Icon size={16} color={color} />
      </div>

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize:    13,
          fontWeight:  notif.read ? 400 : 600,
          color:       '#0f172a',
          marginBottom: 2,
          whiteSpace:  'nowrap',
          overflow:    'hidden',
          textOverflow:'ellipsis',
        }}>
          {notif.title}
        </div>
        <div style={{
          fontSize:    12,
          color:       '#64748b',
          whiteSpace:  'nowrap',
          overflow:    'hidden',
          textOverflow:'ellipsis',
        }}>
          {notif.message}
        </div>
      </div>

      {/* Timestamp + unread dot */}
      <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
        <span style={{ fontSize: 11, color: '#94a3b8', whiteSpace: 'nowrap' }}>
          {timeAgo(notif.timestamp, t)}
        </span>
        {!notif.read && (
          <span style={{
            width:           6,
            height:          6,
            borderRadius:    '50%',
            backgroundColor: '#0284c7',
          }} />
        )}
      </div>
    </div>
  )
}

// ── NotificationPanel ─────────────────────────────────────────────────────────

interface NotificationPanelProps {
  onClose: () => void
}

export function NotificationPanel({ onClose }: NotificationPanelProps) {
  const { t } = useTranslation()
  const { notifications, markAllAsRead } = useNotificationContext()
  const panelRef = useRef<HTMLDivElement>(null)

  // Close on click outside
  useEffect(() => {
    function handleOutside(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleOutside)
    return () => document.removeEventListener('mousedown', handleOutside)
  }, [onClose])

  return (
    <div
      ref={panelRef}
      style={{
        position:        'absolute',
        top:             'calc(100% + 8px)',
        right:           0,
        width:           360,
        maxHeight:       420,
        backgroundColor: '#ffffff',
        border:          '1px solid #e5e7eb',
        borderRadius:    10,
        boxShadow:       '0 8px 24px rgba(0,0,0,0.12)',
        zIndex:          50,
        display:         'flex',
        flexDirection:   'column',
        overflow:        'hidden',
      }}
    >
      {/* Header */}
      <div style={{
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'space-between',
        padding:        '12px 16px',
        borderBottom:   '1px solid #f1f5f9',
        flexShrink:     0,
      }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>
          {t('notifications.title')}
        </span>
        {notifications.length > 0 && (
          <button
            onClick={markAllAsRead}
            style={{
              display:         'flex',
              alignItems:      'center',
              gap:             4,
              fontSize:        12,
              color:           '#0284c7',
              background:      'none',
              border:          'none',
              cursor:          'pointer',
              padding:         '2px 4px',
              borderRadius:    4,
            }}
          >
            <CheckCheck size={13} />
            {t('notifications.markAllRead')}
          </button>
        )}
      </div>

      {/* List */}
      <div style={{ overflowY: 'auto', flex: 1 }}>
        {notifications.length === 0 ? (
          <div style={{
            display:        'flex',
            flexDirection:  'column',
            alignItems:     'center',
            justifyContent: 'center',
            padding:        '32px 16px',
            gap:            8,
            color:          '#94a3b8',
          }}>
            <Bell size={24} color="#cbd5e1" />
            <span style={{ fontSize: 13 }}>{t('notifications.empty')}</span>
          </div>
        ) : (
          notifications.map(notif => (
            <NotificationItem key={notif.id} notif={notif} onClose={onClose} />
          ))
        )}
      </div>
    </div>
  )
}
