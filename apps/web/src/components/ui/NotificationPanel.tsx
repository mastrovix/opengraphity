import { useEffect, useRef } from 'react'
import { lookupOrError, alpha, colors, palette } from '@/lib/tokens'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, GitPullRequest, Shield, Clock, Bell, CheckCheck } from 'lucide-react'
import { notificationEntityPath } from '@opengraphity/types'
import { useNotificationContext } from '@/contexts/NotificationContext'
import type { InAppNotification } from '@/hooks/useNotifications'
import { timeAgo } from '@/lib/datetime'

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Dove porta la notifica: la tabella `entity_type → percorso` è quella
 * condivisa con il link delle email (`@opengraphity/types`), così incident,
 * change, problem, richieste, CI, allarmi, servizi e sorgenti aprono la loro
 * pagina; un tipo senza pagina (sync, portal) resta non cliccabile.
 */
function entityPath(notif: InAppNotification): string | null {
  return notificationEntityPath(notif.entity_type, notif.entity_id)
}

// ── Severity icon ─────────────────────────────────────────────────────────────

const SEVERITY_ICON: Record<string, { icon: React.FC<{ size: number; color: string }>; color: string }> = {
  error:   { icon: AlertTriangle, color: 'var(--color-danger)' },
  warning: { icon: Clock,         color: 'var(--color-warning)' },
  success: { icon: Shield,        color: colors.success },
  info:    { icon: Bell,          color: 'var(--color-trigger-manual)' },
}

function entityIcon(notif: InAppNotification) {
  if (notif.entity_type === 'change') return { icon: GitPullRequest, color: palette.purple.base }
  return lookupOrError(SEVERITY_ICON, notif.severity ?? 'info', 'SEVERITY_ICON', SEVERITY_ICON['error']!)
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
        backgroundColor: notif.read ? colors.white : palette.info.light,
        borderBottom:    `1px solid ${palette.neutral.borderLight}`,
        transition:      'background 0.15s',
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = 'var(--color-slate-bg)' }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = notif.read ? colors.white : palette.info.light }}
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
          color:       'var(--color-slate-dark)',
          marginBottom: 2,
          whiteSpace:  'nowrap',
          overflow:    'hidden',
          textOverflow:'ellipsis',
        }}>
          {t(notif.title)}
        </div>
        <div style={{
          fontSize:    12,
          color:       'var(--color-slate)',
          whiteSpace:  'nowrap',
          overflow:    'hidden',
          textOverflow:'ellipsis',
        }}>
          {notif.message}
        </div>
      </div>

      {/* Timestamp + unread dot */}
      <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
        <span style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', whiteSpace: 'nowrap' }}>
          {timeAgo(notif.timestamp)}
        </span>
        {!notif.read && (
          <span style={{
            width:           6,
            height:          6,
            borderRadius:    '50%',
            backgroundColor: 'var(--color-trigger-manual)',
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
        backgroundColor: colors.white,
        border:          '1px solid var(--border)',
        borderRadius:    10,
        boxShadow:       `0 8px 24px ${alpha.black12}`,
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
        borderBottom:   `1px solid ${palette.neutral.borderLight}`,
        flexShrink:     0,
      }}>
        <span style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)' }}>
          {t('notifications.title')}
        </span>
        {notifications.length > 0 && (
          <button type="button"
            onClick={markAllAsRead}
            style={{
              display:         'flex',
              alignItems:      'center',
              gap:             4,
              fontSize:        12,
              color:           'var(--color-trigger-manual)',
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
            color:          'var(--color-slate-light)',
          }}>
            <Bell size={24} color={colors.slateLight} />
            <span style={{ fontSize: 'var(--font-size-body)' }}>{t('notifications.empty')}</span>
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
