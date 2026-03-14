import { NavLink, useLocation } from 'react-router-dom'
import {
  LayoutDashboard,
  AlertCircle,
  Bug,
  GitPullRequest,
  Inbox,
  Server,
  GitBranch,
  Bell,
  User,
  BarChart2,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react'

const NAV_ITEMS = [
  { to: '/dashboard',              label: 'Dashboard',  icon: LayoutDashboard },
  { to: '/incidents',              label: 'Incidents',  icon: AlertCircle },
  { to: '/problems',               label: 'Problems',   icon: Bug },
  { to: '/changes',                label: 'Changes',    icon: GitPullRequest },
  { to: '/requests',               label: 'Requests',   icon: Inbox },
  { to: '/cmdb',                   label: 'CMDB',       icon: Server },
  { to: '/workflow/incident',      label: 'Workflow',   icon: GitBranch },
  { to: '/reports',                label: 'Report',     icon: BarChart2 },
  { to: '/settings/notifications', label: 'Notifiche',  icon: Bell },
  { to: '/settings/profile',       label: 'Profilo',    icon: User },
]

interface SidebarProps {
  collapsed: boolean
  width:     number
  onToggle:  () => void
}

export function Sidebar({ collapsed, width, onToggle }: SidebarProps) {
  const { pathname } = useLocation()

  return (
    <aside
      style={{
        position:        'fixed',
        left:            0,
        top:             0,
        bottom:          0,
        width:           width,
        backgroundColor: '#ffffff',
        borderRight:     '1px solid #e2e6f0',
        display:         'flex',
        flexDirection:   'column',
        zIndex:          40,
        overflow:        'hidden',
        transition:      'width 200ms ease',
      }}
    >
      {/* Logo */}
      <div
        style={{
          height:          56,
          borderBottom:    '1px solid #e2e6f0',
          display:         'flex',
          alignItems:      'center',
          justifyContent:  collapsed ? 'center' : 'flex-start',
          padding:         collapsed ? 0 : '0 16px',
          gap:             10,
          flexShrink:      0,
        }}
      >
        <div
          style={{
            width:           32,
            height:          32,
            borderRadius:    8,
            backgroundColor: '#4f46e5',
            display:         'flex',
            alignItems:      'center',
            justifyContent:  'center',
            flexShrink:      0,
          }}
        >
          <span style={{ color: '#fff', fontSize: 12, fontWeight: 700, letterSpacing: '-0.03em' }}>
            OG
          </span>
        </div>
        {!collapsed && (
          <span style={{ color: '#0f1629', fontSize: 15, fontWeight: 700, letterSpacing: '-0.02em', whiteSpace: 'nowrap' }}>
            OpenGraphity
          </span>
        )}
      </div>

      {/* Nav */}
      <nav
        style={{
          flex:      1,
          overflowY: 'auto',
          padding:   '16px 8px 8px',
        }}
      >
        {!collapsed && (
          <p
            style={{
              color:         '#8892a4',
              fontSize:      10,
              fontWeight:    600,
              letterSpacing: '0.08em',
              padding:       '0 8px 8px',
              margin:        0,
            }}
          >
            WORKSPACE
          </p>
        )}

        {NAV_ITEMS.map(({ to, label, icon: Icon }) => {
          const isActive = pathname === to || (to !== '/dashboard' && pathname.startsWith(to))

          return (
            <NavLink
              key={to}
              to={to}
              title={collapsed ? label : undefined}
              style={{
                display:         'flex',
                alignItems:      'center',
                gap:             collapsed ? 0 : 10,
                justifyContent:  collapsed ? 'center' : 'flex-start',
                padding:         collapsed ? 0 : '7px 10px',
                width:           collapsed ? 40 : 'auto',
                height:          collapsed ? 40 : 'auto',
                margin:          collapsed ? '2px auto' : '1px 0',
                borderRadius:    6,
                textDecoration:  'none',
                fontWeight:      isActive ? 600 : 400,
                fontSize:        13,
                color:           isActive ? '#4f46e5' : '#4a5468',
                backgroundColor: isActive ? '#eef2ff' : 'transparent',
                borderLeft:      isActive ? '2px solid #4f46e5' : '2px solid transparent',
                transition:      'background 150ms, color 150ms',
                cursor:          'pointer',
                boxSizing:       'border-box',
              }}
              onMouseEnter={(e) => {
                if (!isActive) {
                  (e.currentTarget as HTMLElement).style.backgroundColor = '#f1f3f9'
                  ;(e.currentTarget as HTMLElement).style.color = '#0f1629'
                }
              }}
              onMouseLeave={(e) => {
                if (!isActive) {
                  (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent'
                  ;(e.currentTarget as HTMLElement).style.color = '#4a5468'
                }
              }}
            >
              <Icon size={16} style={{ flexShrink: 0, color: isActive ? '#4f46e5' : 'inherit' }} />
              {!collapsed && label}
            </NavLink>
          )
        })}
      </nav>

      {/* Collapse toggle */}
      <button
        onClick={onToggle}
        style={{
          display:         'flex',
          alignItems:      'center',
          justifyContent:  collapsed ? 'center' : 'flex-start',
          gap:             8,
          padding:         collapsed ? '12px 0' : '12px 16px',
          background:      'none',
          border:          'none',
          borderTop:       '1px solid #e2e6f0',
          color:           '#8892a4',
          cursor:          'pointer',
          width:           '100%',
          flexShrink:      0,
          fontSize:        12,
          transition:      'background 150ms',
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = '#f1f3f9' }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent' }}
      >
        {collapsed
          ? <ChevronRight size={14} />
          : <><ChevronLeft size={14} /><span>Collapse</span></>
        }
      </button>
    </aside>
  )
}
