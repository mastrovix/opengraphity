import { useLocation, Link } from 'react-router-dom'
import { Bell } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useAuth } from '@/hooks/useAuth'

const LABELS: Record<string, string> = {
  dashboard:          'Dashboard',
  incidents:          'Incidents',
  problems:           'Problems',
  changes:            'Changes',
  requests:           'Requests',
  workflow:           'Workflow',
  reports:            'Report AI',
  'custom-reports':   'Report Builder',
  cmdb:               'CMDB',
  ci:                 'CI',
  teams:              'Teams',
  users:              'Users',
  logs:               'Logs',
  settings:           'Settings',
  notifications:      'Notifiche',
  profile:            'Profilo',
  'ci-types':         'Tipi CI',
  new:                'Nuovo',
}

const formatSegment = (part: string): string => {
  if (LABELS[part]) return LABELS[part]
  if (/^[0-9a-f-]{20,}$/i.test(part)) return 'Dettaglio'
  if (/^\d+$/.test(part)) return 'Dettaglio'
  return part.charAt(0).toUpperCase() + part.slice(1).replace(/_/g, ' ')
}

function Breadcrumb() {
  const { pathname } = useLocation()
  const parts = pathname.split('/').filter(Boolean)

  if (parts.length === 0) {
    return <span style={{ color: '#0f1629', fontWeight: 600, fontSize: 13 }}>Dashboard</span>
  }

  return (
    <nav style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
      {parts.map((part, i) => {
        const isLast = i === parts.length - 1
        const path   = '/' + parts.slice(0, i + 1).join('/')
        const label  = formatSegment(part)
        return (
          <span key={path} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {i > 0 && <span style={{ color: '#c8cfe0' }}>/</span>}
            {isLast ? (
              <span style={{ color: '#0f1629', fontWeight: 600 }}>{label}</span>
            ) : (
              <Link
                to={path}
                style={{ color: '#8892a4', textDecoration: 'none' }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#0f1629' }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#8892a4' }}
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
  const { logout } = useAuth()

  return (
    <header
      style={{
        height:          56,
        backgroundColor: '#ffffff',
        borderBottom:    '1px solid #e2e6f0',
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
            color:           '#8892a4',
            cursor:          'pointer',
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = '#f1f3f9' }}
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
                backgroundColor: '#dc2626',
              }}
            />
          )}
        </button>

        {/* Divider */}
        <div style={{ width: 1, height: 20, backgroundColor: '#e2e6f0' }} />

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
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = '#f1f3f9' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent' }}
          >
            <div
              style={{
                width:           32,
                height:          32,
                borderRadius:    '50%',
                backgroundColor: '#4f46e5',
                color:           '#fff',
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
            <span style={{ fontSize: 13, color: '#0f1629', fontWeight: 500 }}>
              admin@demo
            </span>
          </DropdownMenuTrigger>

          <DropdownMenuContent align="end" style={{ width: 176 }}>
            <DropdownMenuItem style={{ fontSize: 13 }}>Profile</DropdownMenuItem>
            <DropdownMenuItem style={{ fontSize: 13 }}>Settings</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={logout}
              style={{ fontSize: 13, color: '#dc2626' }}
            >
              Logout
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
