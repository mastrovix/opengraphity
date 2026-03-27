import { useLocation, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Bell } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useAuth } from '@/hooks/useAuth'

// ── colours (aligned with Sidebar) ───────────────────────────────────────────
const C = {
  bg:          '#3d4856',
  border:      '#2e3744',
  textDefault: '#e2e8f0',
  textMuted:   '#94a3b8',
  brand:       '#38bdf8',
  hoverBg:     'rgba(255,255,255,0.08)',
}

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
    new:                t('common.create'),
    anomalies:          t('sidebar.anomalies'),
    topology:           t('pages.topology.title'),
  }

  const formatSegment = (part: string): string => {
    if (LABELS[part]) return LABELS[part]
    if (/^[0-9a-f-]{20,}$/i.test(part)) return 'Detail'
    if (/^\d+$/.test(part)) return 'Detail'
    return part.charAt(0).toUpperCase() + part.slice(1).replace(/_/g, ' ')
  }
  const parts = pathname.split('/').filter(Boolean)

  if (parts.length === 0) {
    return <span style={{ color: C.textDefault, fontWeight: 600, fontSize: 14 }}>Dashboard</span>
  }

  return (
    <nav style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14 }}>
      {parts.map((part, i) => {
        const isLast = i === parts.length - 1
        const path   = '/' + parts.slice(0, i + 1).join('/')
        const label  = formatSegment(part)
        return (
          <span key={path} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {i > 0 && <span style={{ color: C.textMuted }}>/</span>}
            {isLast ? (
              <span style={{ color: C.textDefault, fontWeight: 600 }}>{label}</span>
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

const NOTIFICATIONS = 3

export function Topbar() {
  const { t } = useTranslation()
  const { logout } = useAuth()

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
        {/* Bell */}
        <button
          style={{
            position:        'relative',
            display:         'flex',
            alignItems:      'center',
            justifyContent:  'center',
            width:           32,
            height:          32,
            borderRadius:    6,
            border:          'none',
            backgroundColor: 'transparent',
            color:           C.brand,
            cursor:          'pointer',
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = C.hoverBg }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent' }}
        >
          <Bell size={16} />
          {NOTIFICATIONS > 0 && (
            <span
              style={{
                position:        'absolute',
                top:             4,
                right:           4,
                width:           6,
                height:          6,
                borderRadius:    '50%',
                backgroundColor: 'var(--color-trigger-sla-breach)',
              }}
            />
          )}
        </button>

        {/* Divider */}
        <div style={{ width: 1, height: 20, backgroundColor: C.border }} />

        {/* User dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger
            style={{
              display:         'flex',
              alignItems:      'center',
              gap:             10,
              padding:         '4px 8px',
              borderRadius:    6,
              border:          'none',
              backgroundColor: 'transparent',
              cursor:          'pointer',
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = C.hoverBg }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent' }}
          >
            <div
              style={{
                width:           32,
                height:          32,
                borderRadius:    '50%',
                backgroundColor: C.brand,
                color:           '#0f172a',
                fontSize:        11,
                fontWeight:      700,
                display:         'flex',
                alignItems:      'center',
                justifyContent:  'center',
                letterSpacing:   '0.02em',
                flexShrink:      0,
              }}
            >
              AD
            </div>
            <span style={{ fontSize: 14, color: C.textDefault, fontWeight: 500 }}>
              admin@demo
            </span>
          </DropdownMenuTrigger>

          <DropdownMenuContent align="end" style={{ width: 176 }}>
            <DropdownMenuItem style={{ fontSize: 14 }}>{t('sidebar.profile')}</DropdownMenuItem>
            <DropdownMenuItem style={{ fontSize: 14 }}>{t('sidebar.settings')}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={logout}
              style={{ fontSize: 14, color: 'var(--color-trigger-sla-breach)' }}
            >
              {t('auth.logout')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
