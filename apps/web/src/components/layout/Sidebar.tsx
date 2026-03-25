import { useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { useQuery } from '@apollo/client/react'
import { GET_ANOMALY_STATS } from '@/graphql/queries'
import {
  LayoutDashboard,
  AlertCircle,
  Bug,
  GitPullRequest,
  Inbox,
  Server,
  GitBranch,
  Users,
  BarChart2,
  ScrollText,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Layers,
  Settings,
  ShieldAlert,
  Share2,
} from 'lucide-react'
import { keycloak } from '../../lib/keycloak'
import { useMetamodel } from '@/contexts/MetamodelContext'
import { CIIcon } from '@/lib/ciIcon'

const NAV_ITEMS = [
  { to: '/dashboard',      label: 'Dashboard',      icon: LayoutDashboard },
  { to: '/incidents',      label: 'Incidents',      icon: AlertCircle },
  { to: '/problems',       label: 'Problems',       icon: Bug },
  { to: '/changes',        label: 'Changes',        icon: GitPullRequest },
  { to: '/requests',       label: 'Requests',       icon: Inbox },
  { to: '/workflow',       label: 'Workflow',       icon: GitBranch },
  { to: '/anomalies',      label: 'Anomalie',       icon: ShieldAlert },
  { to: '/topology',       label: 'Topology',       icon: Share2 },
]

const REPORTING_ITEMS = [
  { to: '/reports',        label: 'Analisi ITSM'  },
  { to: '/custom-reports', label: 'Report Builder' },
]

const ADMIN_NAV_ITEMS = [
  { to: '/logs', label: 'Logs', icon: ScrollText },
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
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [reportingOpen, setReportingOpen] = useState(
    () => pathname.startsWith('/reports') || pathname.startsWith('/custom-reports'),
  )

  const isAdmin = keycloak.tokenParsed?.['realm_access']?.roles?.includes('admin')
  const settingsActive = pathname.startsWith('/settings')
  const { ciTypes } = useMetamodel()

  const { data: anomalyStatsData } = useQuery<{ anomalyStats: { critical: number; open: number } }>(
    GET_ANOMALY_STATS,
    { pollInterval: 60_000, fetchPolicy: 'cache-and-network' },
  )
  const anomalyCritical = anomalyStatsData?.anomalyStats?.critical ?? 0

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
    color:           isActive ? 'var(--color-brand)' : 'var(--color-slate)',
    backgroundColor: isActive ? 'rgba(2,132,199,0.12)' : 'transparent',
    borderLeft:      isActive ? '2px solid #0284c7' : '2px solid transparent',
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
    color:          isActive ? 'var(--color-brand)' : 'var(--color-slate)',
    fontWeight:     isActive ? 600 : 400,
    textDecoration: 'none',
    cursor:         'pointer',
    marginBottom:   1,
  })

  const reportingActive = pathname.startsWith('/reports') || pathname.startsWith('/custom-reports')

  const cmdbActive = pathname.startsWith('/cmdb') || pathname.startsWith('/ci/')
    || pathname.startsWith('/applications') || pathname.startsWith('/databases')
    || pathname.startsWith('/database-instances') || pathname.startsWith('/servers')
    || pathname.startsWith('/certificates')

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
        {collapsed ? (
          <img src="/opengrafo-icon.svg" alt="OPENGRAFO" style={{ width: 32, height: 32 }} />
        ) : (
          <img src="/opengrafo-logo.svg" alt="OPENGRAFO" style={{ height: 36, width: 'auto' }} />
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
              color:         'var(--color-slate-light)',
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
                  ;(e.currentTarget as HTMLElement).style.color = 'var(--color-slate-dark)'
                }
              }}
              onMouseLeave={(e) => {
                if (!isActive) {
                  (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent'
                  ;(e.currentTarget as HTMLElement).style.color = 'var(--color-slate)'
                }
              }}
            >
              <Icon size={16} style={{ flexShrink: 0, color: isActive ? 'var(--color-brand)' : 'inherit' }} />
              {!collapsed && (
                <>
                  <span style={{ flex: 1 }}>{label}</span>
                  {to === '/anomalies' && anomalyCritical > 0 && (
                    <span style={{
                      fontSize: 10, fontWeight: 700, lineHeight: 1,
                      padding: '2px 5px', borderRadius: 8,
                      background: 'var(--danger)', color: '#fff',
                    }}>
                      {anomalyCritical}
                    </span>
                  )}
                </>
              )}
            </NavLink>
          )
        })}

        {/* Reporting — collapsible */}
        {collapsed ? (
          <NavLink
            to="/reports"
            title="Reporting"
            style={navItemStyle(reportingActive, true)}
            onMouseEnter={(e) => {
              if (!reportingActive) {
                (e.currentTarget as HTMLElement).style.backgroundColor = '#f1f3f9'
                ;(e.currentTarget as HTMLElement).style.color = 'var(--color-slate-dark)'
              }
            }}
            onMouseLeave={(e) => {
              if (!reportingActive) {
                (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent'
                ;(e.currentTarget as HTMLElement).style.color = 'var(--color-slate)'
              }
            }}
          >
            <BarChart2 size={16} style={{ flexShrink: 0, color: reportingActive ? 'var(--color-brand)' : 'inherit' }} />
          </NavLink>
        ) : (
          <div style={{ marginBottom: 2 }}>
            <div
              onClick={() => setReportingOpen((p) => !p)}
              style={{
                display:         'flex',
                alignItems:      'center',
                justifyContent:  'space-between',
                padding:         '7px 10px',
                borderRadius:    6,
                cursor:          'pointer',
                backgroundColor: reportingActive ? 'rgba(2,132,199,0.12)' : 'transparent',
                borderLeft:      reportingActive ? '2px solid #0284c7' : '2px solid transparent',
                transition:      'background 150ms',
                margin:          '1px 0',
              }}
              onMouseEnter={(e) => { if (!reportingActive) (e.currentTarget as HTMLElement).style.backgroundColor = '#f1f3f9' }}
              onMouseLeave={(e) => { if (!reportingActive) (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <BarChart2 size={16} style={{ flexShrink: 0, color: reportingActive ? 'var(--color-brand)' : 'var(--color-slate)' }} />
                <span style={{ fontSize: 13, fontWeight: reportingActive ? 600 : 400, color: reportingActive ? 'var(--color-brand)' : 'var(--color-slate)' }}>
                  Reporting
                </span>
              </div>
              {reportingOpen
                ? <ChevronDown size={12} color="var(--color-slate-light)" />
                : <ChevronRight size={12} color="var(--color-slate-light)" />}
            </div>

            {reportingOpen && (
              <div style={{ paddingLeft: 28, marginTop: 2 }}>
                {REPORTING_ITEMS.map(({ to, label }) => (
                  <NavLink key={to} to={to} style={({ isActive }) => subItemStyle(isActive)}>
                    <span>{label}</span>
                  </NavLink>
                ))}
              </div>
            )}
          </div>
        )}

        {/* CMDB — collapsible with sub-items */}
        {collapsed ? (
          <NavLink
            to="/cmdb"
            title="CMDB"
            style={navItemStyle(cmdbActive, true)}
            onMouseEnter={(e) => {
              if (!cmdbActive) {
                (e.currentTarget as HTMLElement).style.backgroundColor = '#f1f3f9'
                ;(e.currentTarget as HTMLElement).style.color = 'var(--color-slate-dark)'
              }
            }}
            onMouseLeave={(e) => {
              if (!cmdbActive) {
                (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent'
                ;(e.currentTarget as HTMLElement).style.color = 'var(--color-slate)'
              }
            }}
          >
            <Server size={16} style={{ flexShrink: 0, color: cmdbActive ? 'var(--color-brand)' : 'inherit' }} />
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
                backgroundColor: cmdbActive ? 'rgba(2,132,199,0.12)' : 'transparent',
                borderLeft:      cmdbActive ? '2px solid #0284c7' : '2px solid transparent',
                transition:      'background 150ms',
                margin:          '1px 0',
              }}
              onMouseEnter={(e) => { if (!cmdbActive) (e.currentTarget as HTMLElement).style.backgroundColor = '#f1f3f9' }}
              onMouseLeave={(e) => { if (!cmdbActive) (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Server size={16} style={{ flexShrink: 0, color: cmdbActive ? 'var(--color-brand)' : 'var(--color-slate)' }} />
                <span style={{ fontSize: 13, fontWeight: cmdbActive ? 600 : 400, color: cmdbActive ? 'var(--color-brand)' : 'var(--color-slate)' }}>
                  CMDB
                </span>
              </div>
              {cmdbOpen
                ? <ChevronDown size={12} color="var(--color-slate-light)" />
                : <ChevronRight size={12} color="var(--color-slate-light)" />}
            </div>

            {/* Sub-items */}
            {cmdbOpen && (
              <div style={{ paddingLeft: 28, marginTop: 2 }}>
                <NavLink to="/cmdb" end style={({ isActive }) => subItemStyle(isActive)}>
                  <span>Tutti</span>
                </NavLink>
                {ciTypes.map(ct => {
                  const to = `/ci/${ct.name}`
                  const isActive = pathname === to || pathname.startsWith(`${to}/`)
                  return (
                    <NavLink key={ct.name} to={to} style={() => subItemStyle(isActive)}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <CIIcon icon={ct.icon} size={12} color={isActive ? 'var(--color-brand)' : 'var(--color-slate)'} />
                        {ct.label}
                      </span>
                    </NavLink>
                  )
                })}
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
                <Users size={16} style={{ flexShrink: 0, color: 'var(--color-slate)' }} />
                <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--color-slate)' }}>Teams & Users</span>
              </div>
              {teamsOpen
                ? <ChevronDown size={12} color="var(--color-slate-light)" />
                : <ChevronRight size={12} color="var(--color-slate-light)" />}
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
        {/* Settings — collapsible */}
        {!collapsed ? (
          <div style={{ marginBottom: 2 }}>
            <div
              onClick={() => setSettingsOpen((p) => !p)}
              style={{
                display:         'flex',
                alignItems:      'center',
                justifyContent:  'space-between',
                padding:         '7px 10px',
                borderRadius:    6,
                cursor:          'pointer',
                backgroundColor: settingsActive ? 'rgba(2,132,199,0.12)' : 'transparent',
                borderLeft:      settingsActive ? '2px solid #0284c7' : '2px solid transparent',
                transition:      'background 150ms',
                margin:          '1px 0',
              }}
              onMouseEnter={(e) => { if (!settingsActive) (e.currentTarget as HTMLElement).style.backgroundColor = '#f1f3f9' }}
              onMouseLeave={(e) => { if (!settingsActive) (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Settings size={16} style={{ flexShrink: 0, color: settingsActive ? 'var(--color-brand)' : 'var(--color-slate)' }} />
                <span style={{ fontSize: 13, fontWeight: settingsActive ? 600 : 400, color: settingsActive ? 'var(--color-brand)' : 'var(--color-slate)' }}>
                  Settings
                </span>
              </div>
              {settingsOpen
                ? <ChevronDown size={12} color="var(--color-slate-light)" />
                : <ChevronRight size={12} color="var(--color-slate-light)" />}
            </div>

            {settingsOpen && (
              <div style={{ paddingLeft: 28, marginTop: 2 }}>
                <NavLink to="/settings/notifications" style={({ isActive }) => subItemStyle(isActive)}>
                  <span>Notifiche</span>
                </NavLink>
                <NavLink to="/settings/profile" style={({ isActive }) => subItemStyle(isActive)}>
                  <span>Profilo</span>
                </NavLink>
                {isAdmin && (
                  <NavLink to="/settings/ci-types" style={({ isActive }) => subItemStyle(isActive)}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Layers size={12} color={pathname === '/settings/ci-types' ? 'var(--color-brand)' : 'var(--color-slate)'} />
                      Tipi CI
                    </span>
                  </NavLink>
                )}
              </div>
            )}
          </div>
        ) : (
          <NavLink
            to="/settings/notifications"
            title="Settings"
            style={navItemStyle(settingsActive, true)}
            onMouseEnter={(e) => {
              if (!settingsActive) {
                (e.currentTarget as HTMLElement).style.backgroundColor = '#f1f3f9'
                ;(e.currentTarget as HTMLElement).style.color = 'var(--color-slate-dark)'
              }
            }}
            onMouseLeave={(e) => {
              if (!settingsActive) {
                (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent'
                ;(e.currentTarget as HTMLElement).style.color = 'var(--color-slate)'
              }
            }}
          >
            <Settings size={16} style={{ flexShrink: 0, color: settingsActive ? 'var(--color-brand)' : 'inherit' }} />
          </NavLink>
        )}

        {/* Admin items */}
        {isAdmin && (
          <>
            {!collapsed && (
              <p style={{ color: 'var(--color-slate-light)', fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', padding: '8px 8px 4px', margin: 0 }}>
                ADMIN
              </p>
            )}
            {ADMIN_NAV_ITEMS.map(({ to, label, icon: Icon }) => {
              const isActive = pathname === to || pathname.startsWith(to + '/')
              return (
                <NavLink
                  key={to}
                  to={to}
                  title={collapsed ? label : undefined}
                  style={navItemStyle(isActive, collapsed)}
                  onMouseEnter={(e) => {
                    if (!isActive) {
                      (e.currentTarget as HTMLElement).style.backgroundColor = '#f1f3f9'
                      ;(e.currentTarget as HTMLElement).style.color = 'var(--color-slate-dark)'
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive) {
                      (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent'
                      ;(e.currentTarget as HTMLElement).style.color = 'var(--color-slate)'
                    }
                  }}
                >
                  <Icon size={16} style={{ flexShrink: 0, color: isActive ? 'var(--color-brand)' : 'inherit' }} />
                  {!collapsed && label}
                </NavLink>
              )
            })}
          </>
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
          color:           'var(--color-slate-light)',
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
