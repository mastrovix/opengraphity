import { useState } from 'react'
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
  Users,
  BarChart2,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
} from 'lucide-react'

const NAV_ITEMS = [
  { to: '/dashboard',              label: 'Dashboard',  icon: LayoutDashboard },
  { to: '/incidents',              label: 'Incidents',  icon: AlertCircle },
  { to: '/problems',               label: 'Problems',   icon: Bug },
  { to: '/changes',                label: 'Changes',    icon: GitPullRequest },
  { to: '/requests',               label: 'Requests',   icon: Inbox },
  { to: '/workflow',               label: 'Workflow',   icon: GitBranch },
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
  const [cmdbOpen, setCmdbOpen] = useState(true)
  const [teamsOpen, setTeamsOpen] = useState(false)

  const navItemStyle = (isActive: boolean, isCollapsed: boolean): React.CSSProperties => ({
    display:         'flex',
    alignItems:      'center',
    gap:             isCollapsed ? 0 : 10,
    justifyContent:  isCollapsed ? 'center' : 'flex-start',
    padding:         isCollapsed ? 0 : '7px 10px',
    width:           isCollapsed ? 40 : 'auto',
    height:          isCollapsed ? 40 : 'auto',
    margin:          isCollapsed ? '2px auto' : '1px 0',
    borderRadius:    6,
    textDecoration:  'none',
    fontWeight:      isActive ? 600 : 400,
    fontSize:        13,
    color:           isActive ? '#4f46e5' : '#4a5468',
    backgroundColor: isActive ? '#eef2ff' : 'transparent',
    borderLeft:      isActive ? '2px solid #4f46e5' : '2px solid transparent',
    transition:      'background 150ms, color 150ms',
    cursor:          'pointer',
    boxSizing:       'border-box' as const,
  })

  const subItemStyle = (isActive: boolean): React.CSSProperties => ({
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'space-between',
    padding:        '5px 8px',
    borderRadius:   4,
    fontSize:       12,
    color:          isActive ? '#4f46e5' : '#6b7280',
    fontWeight:     isActive ? 600 : 400,
    textDecoration: 'none',
    cursor:         'pointer',
    marginBottom:   1,
  })

  const cmdbActive = pathname.startsWith('/cmdb') || pathname.startsWith('/applications') || pathname.startsWith('/databases') || pathname.startsWith('/database-instances') || pathname.startsWith('/servers') || pathname.startsWith('/certificates')

  return (
    <aside
      style={{
        position:        'fixed',
        left:            0,
        top:             0,
        bottom:          0,
        width:           width,
        backgroundColor: '#ffffff',
        borderRight:     '1px solid #e5e7eb',
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
          borderBottom:    '1px solid #e5e7eb',
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
            OpenGrafo
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
              style={navItemStyle(isActive, collapsed)}
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

        {/* CMDB — collapsible with sub-items */}
        {collapsed ? (
          <NavLink
            to="/cmdb"
            title="CMDB"
            style={navItemStyle(cmdbActive, true)}
            onMouseEnter={(e) => {
              if (!cmdbActive) {
                (e.currentTarget as HTMLElement).style.backgroundColor = '#f1f3f9'
                ;(e.currentTarget as HTMLElement).style.color = '#0f1629'
              }
            }}
            onMouseLeave={(e) => {
              if (!cmdbActive) {
                (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent'
                ;(e.currentTarget as HTMLElement).style.color = '#4a5468'
              }
            }}
          >
            <Server size={16} style={{ flexShrink: 0, color: cmdbActive ? '#4f46e5' : 'inherit' }} />
          </NavLink>
        ) : (
          <div style={{ marginBottom: 2 }}>
            {/* Header */}
            <div
              onClick={() => setCmdbOpen((p) => !p)}
              style={{
                display:         'flex',
                alignItems:      'center',
                justifyContent:  'space-between',
                padding:         '7px 10px',
                borderRadius:    6,
                cursor:          'pointer',
                backgroundColor: cmdbActive ? '#eef2ff' : 'transparent',
                borderLeft:      cmdbActive ? '2px solid #4f46e5' : '2px solid transparent',
                transition:      'background 150ms',
                margin:          '1px 0',
              }}
              onMouseEnter={(e) => { if (!cmdbActive) (e.currentTarget as HTMLElement).style.backgroundColor = '#f1f3f9' }}
              onMouseLeave={(e) => { if (!cmdbActive) (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Server size={16} style={{ flexShrink: 0, color: cmdbActive ? '#4f46e5' : '#4a5468' }} />
                <span style={{ fontSize: 13, fontWeight: cmdbActive ? 600 : 400, color: cmdbActive ? '#4f46e5' : '#4a5468' }}>
                  CMDB
                </span>
              </div>
              {cmdbOpen
                ? <ChevronDown size={12} color="#8892a4" />
                : <ChevronRight size={12} color="#8892a4" />}
            </div>

            {/* Sub-items */}
            {cmdbOpen && (
              <div style={{ paddingLeft: 28, marginTop: 2 }}>
                <NavLink to="/cmdb" end style={({ isActive }) => subItemStyle(isActive)}>
                  <span>Tutti</span>
                </NavLink>
                <NavLink to="/applications" style={({ isActive }) => subItemStyle(isActive)}>
                  <span>Applicazioni</span>
                </NavLink>
                <NavLink to="/databases" style={({ isActive }) => subItemStyle(isActive)}>
                  <span>Database</span>
                </NavLink>
                <NavLink to="/database-instances" style={({ isActive }) => subItemStyle(isActive)}>
                  <span>DB Instance</span>
                </NavLink>
                <NavLink to="/servers" style={({ isActive }) => subItemStyle(isActive)}>
                  <span>Server</span>
                </NavLink>
                <NavLink to="/certificates" style={({ isActive }) => subItemStyle(isActive)}>
                  <span>Certificati</span>
                </NavLink>
              </div>
            )}
          </div>
        )}

        {/* Teams & Users */}
        {!collapsed && (
          <div style={{ marginBottom: 2 }}>
            <div
              onClick={() => setTeamsOpen((p) => !p)}
              style={{
                display:        'flex',
                alignItems:     'center',
                justifyContent: 'space-between',
                padding:        '7px 10px',
                borderRadius:   6,
                cursor:         'pointer',
                backgroundColor: 'transparent',
                borderLeft:     '2px solid transparent',
                transition:     'background 150ms',
                margin:         '1px 0',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = '#f1f3f9' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Users size={16} style={{ flexShrink: 0, color: '#4a5468' }} />
                <span style={{ fontSize: 13, fontWeight: 400, color: '#4a5468' }}>Teams & Users</span>
              </div>
              {teamsOpen
                ? <ChevronDown size={12} color="#8892a4" />
                : <ChevronRight size={12} color="#8892a4" />}
            </div>

            {teamsOpen && (
              <div style={{ paddingLeft: 28, marginTop: 2 }}>
                <NavLink to="/teams" style={({ isActive }) => subItemStyle(isActive)}>
                  <span>Teams</span>
                </NavLink>
                <NavLink to="/users" style={({ isActive }) => subItemStyle(isActive)}>
                  <span>Users</span>
                </NavLink>
              </div>
            )}
          </div>
        )}
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
          borderTop:       '1px solid #e5e7eb',
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
