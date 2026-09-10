import { useState } from 'react'
import { useLocation, Link, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Bell } from 'lucide-react'
import { GlobalSearch } from './GlobalSearch'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useAuth } from '@/hooks/useAuth'
import { useMe } from '@/hooks/useMe'
import { keycloak } from '@/lib/keycloak'
import { layoutPalette as C, alpha, colors } from '@/lib/tokens'
import { useNotificationContext } from '@/contexts/NotificationContext'
import { NotificationPanel } from '@/components/ui/NotificationPanel'

function Breadcrumb() {
  const { t } = useTranslation()
  const { pathname } = useLocation()

  const LABELS: Record<string, string> = {
    dashboard:          t('sidebar.dashboard'),
    incidents:          t('sidebar.incidents'),
    problems:           t('sidebar.problems'),
    changes:            t('sidebar.changes'),
    requests:           t('sidebar.requests'),
    workflow:           t('sidebar.workflowDesigner'),
    reports:            t('sidebar.aiAnalysis'),
    'custom-reports':   t('sidebar.reportBuilder'),
    cmdb:               t('sidebar.cmdb'),
    ci:                 t('sidebar.cmdb'),
    teams:              t('sidebar.teams'),
    users:              t('sidebar.users'),
    logs:               t('sidebar.logs'),
    settings:           t('sidebar.settings'),
    notifications:      t('sidebar.notifications'),
    profile:            t('sidebar.profile'),
    certificate:        t('sidebar.certificate'),
    application:        t('sidebar.application'),
    server:             t('sidebar.server'),
    database:           t('sidebar.database'),
    database_instance:  t('sidebar.dbInstance'),
    'ci-types':         t('sidebar.ciTypeDesigner'),
    sync:               t('sidebar.cmdbSync'),
    new:                t('common.create'),
    anomalies:          t('sidebar.anomalies'),
    topology:           t('pages.topology.title'),
    events:             t('sidebar.events'),
    monitoring:         t('sidebar.monitoring'),
    health:             t('sidebar.ciHealth'),
    services:           t('sidebar.services'),
    sources:            t('sidebar.monitoringSources'),
    'event-policy':     t('sidebar.eventPolicy'),
  }
  // Etichette per percorso intero, dove il segmento da solo è ambiguo:
  // /admin/monitoring è "Platform monitoring", /monitoring è il gruppo ITSM.
  const PATH_LABELS: Record<string, string> = {
    '/admin/monitoring': t('sidebar.platformMonitoring'),
  }

  const formatSegment = (part: string): string => {
    if (LABELS[part]) return LABELS[part]
    if (/^[0-9a-f-]{20,}$/i.test(part)) return t('topbar.detail')
    if (/^\d+$/.test(part)) return t('topbar.detail')
    return part.charAt(0).toUpperCase() + part.slice(1).replace(/_/g, ' ')
  }
  const parts = pathname.split('/').filter(Boolean)

  if (parts.length === 0) {
    return <span style={{ color: C.textDefault, fontWeight: 600, fontSize: 12 }}>{t('sidebar.dashboard')}</span>
  }

  return (
    <nav aria-label={t('topbar.breadcrumb')} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
      {parts.map((part, i) => {
        const isLast = i === parts.length - 1
        const path   = '/' + parts.slice(0, i + 1).join('/')
        const label  = PATH_LABELS[path] ?? formatSegment(part)
        return (
          <span key={path} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {i > 0 && <span aria-hidden="true" style={{ color: C.textMuted }}>/</span>}
            {isLast ? (
              <span aria-current="page" style={{ color: C.textDefault, fontWeight: 600 }}>{label}</span>
            ) : (
              <Link
                to={path}
                style={{ color: C.textMuted, textDecoration: 'none' }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = C.textDefault }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = C.textMuted }}
              >
                {label}
              </Link>
            )}
          </span>
        )
      })}
    </nav>
  )
}

function getUserInfo() {
  const parsed = keycloak.tokenParsed as Record<string, string> | undefined
  const email  = parsed?.['email']              ?? ''
  const name   = parsed?.['name']               ?? parsed?.['preferred_username'] ?? ''

  let initials: string
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length >= 2) {
    initials = (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase()
  } else if (name.trim().length >= 2) {
    initials = name.trim().slice(0, 2).toUpperCase()
  } else {
    initials = email.slice(0, 2).toUpperCase()
  }

  const display = name.trim() || email.split('@')[0] || '—'

  return { email, display, initials }
}

export function Topbar() {
  const { t } = useTranslation()
  const { logout } = useAuth()
  const navigate = useNavigate()
  // Same role source as RequireRole/Sidebar (`me.role`): the "Settings" entry
  // leads to admin-only routes, so it is only offered to admins.
  const { isAdmin } = useMe()
  const { display, initials } = getUserInfo()
  const { unreadCount, connected: sseConnected } = useNotificationContext()
  const [panelOpen, setPanelOpen] = useState(false)

  return (
    <header
      style={{
        height:          56,
        backgroundColor: C.bg,
        borderBottom:    `1px solid ${C.border}`,
        display:         'flex',
        alignItems:      'center',
        justifyContent:  'space-between',
        padding:         '0 24px',
        flexShrink:      0,
        position:        'sticky',
        top:             0,
        zIndex:          30,
      }}
    >
      <Breadcrumb />

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {/* Global search */}
        <GlobalSearch />

        {/* Bell */}
        <div style={{ position: 'relative' }}>
          <button
            type="button"
            onClick={() => setPanelOpen(v => !v)}
            aria-expanded={panelOpen}
            aria-label={unreadCount > 0 ? t('topbar.notificationsUnread', { count: unreadCount }) : t('notifications.title')}
            className="hover-bg"
            style={{
              position:        'relative',
              display:         'flex',
              alignItems:      'center',
              justifyContent:  'center',
              width:           32,
              height:          32,
              borderRadius:    6,
              border:          'none',
              backgroundColor: panelOpen ? C.hoverBg : 'transparent',
              color:           C.brand,
              cursor:          'pointer',
              ['--hover-bg' as string]: C.hoverBg,
            }}
          >
            <Bell size={16} aria-hidden="true" />
            {/* Realtime channel down: amber dot — the user must know
                notifications are NOT arriving, not just see silence. */}
            {!sseConnected && (
              <span
                role="status"
                title={t('topbar.sseDisconnected')}
                aria-label={t('topbar.sseDisconnected')}
                style={{
                  position:        'absolute',
                  bottom:          3,
                  right:           3,
                  width:           8,
                  height:          8,
                  borderRadius:    4,
                  backgroundColor: 'var(--warning)',
                  border:          `1px solid ${colors.white}`,
                }}
              />
            )}
            {unreadCount > 0 && (
              <span
                aria-hidden="true"
                style={{
                  position:        'absolute',
                  top:             3,
                  right:           3,
                  minWidth:        14,
                  height:          14,
                  borderRadius:    7,
                  backgroundColor: 'var(--color-danger)',
                  color:           colors.white,
                  fontSize:        9,
                  fontWeight:      700,
                  display:         'flex',
                  alignItems:      'center',
                  justifyContent:  'center',
                  padding:         '0 3px',
                  lineHeight:      1,
                }}
              >
                {unreadCount > 9 ? '9+' : unreadCount}
              </span>
            )}
          </button>
          {panelOpen && <NotificationPanel onClose={() => setPanelOpen(false)} />}
        </div>

        {/* Divider */}
        <div aria-hidden="true" style={{ width: 1, height: 20, backgroundColor: C.border }} />

        {/* User dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger
            className="hover-bg"
            aria-label={t('topbar.userMenu', { name: display })}
            style={{
              display:         'flex',
              alignItems:      'center',
              gap:             10,
              padding:         '4px 8px',
              borderRadius:    6,
              border:          'none',
              cursor:          'pointer',
              background:      'transparent',
              ['--hover-bg' as string]: C.hoverBg,
            }}
          >
            <div
              aria-hidden="true"
              style={{
                width:           32,
                height:          32,
                borderRadius:    '50%',
                backgroundColor: C.brand,
                color:           'var(--color-slate-dark)',
                fontSize:        11,
                fontWeight:      700,
                display:         'flex',
                alignItems:      'center',
                justifyContent:  'center',
                letterSpacing:   '0.02em',
                flexShrink:      0,
              }}
            >
              {initials}
            </div>
            <span style={{ fontSize: 12, color: C.textDefault, fontWeight: 500 }}>
              {display}
            </span>
          </DropdownMenuTrigger>

          <DropdownMenuContent
            align="end"
            style={{
              backgroundColor: colors.white,
              border: '1px solid var(--border)',
              borderRadius: 10,
              boxShadow: `0 4px 12px ${alpha.black10}`,
              minWidth: 180,
              padding: '8px 0',
              zIndex: 50,
            }}
          >
            <DropdownMenuItem onClick={() => navigate('/profile')} style={{ fontSize: 12, padding: '10px 16px' }}>
              {t('sidebar.profile')}
            </DropdownMenuItem>
            {isAdmin && (
              <DropdownMenuItem onClick={() => navigate('/settings/notifications')} style={{ fontSize: 12, padding: '10px 16px' }}>
                {t('sidebar.settings')}
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={logout}
              style={{ fontSize: 12, padding: '10px 16px', color: 'var(--color-danger)' }}
            >
              {t('auth.logout')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
