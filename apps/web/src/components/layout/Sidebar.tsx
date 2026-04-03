import { useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { GET_ANOMALY_STATS } from '@/graphql/queries'
import {
  LayoutDashboard,
  AlertCircle,
  Bug,
  GitPullRequest,
  Inbox,
  ListChecks,
  SlidersHorizontal,
  Route,
  Server,
  Users,
  UsersRound,
  User,
  BarChart2,
  BrainCircuit,
  LayoutGrid,
  ScrollText,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Layers,
  Settings,
  Settings2,
  Activity,
  ShieldAlert,
  ShieldCheck,
  Share2,
  Bell,
  CircleUser,
  UserCircle,
  Tag,
} from 'lucide-react'
import { keycloak } from '../../lib/keycloak'
import { useMetamodel } from '@/contexts/MetamodelContext'
import { CIIcon } from '@/lib/ciIcon'

const NAV_ITEM_DEFS = [
  { to: '/dashboard', labelKey: 'sidebar.dashboard', icon: LayoutDashboard },
]

const ANALYSIS_ITEM_DEFS = [
  { to: '/anomalies', labelKey: 'sidebar.anomalies', icon: ShieldAlert },
  { to: '/topology',  labelKey: 'sidebar.topologyMap', icon: Share2    },
]

const CONFIG_ITEM_DEFS = [
  { to: '/settings/ci-types',        labelKey: 'sidebar.ciTypeDesigner',  icon: Layers   },
  { to: '/settings/itil-designer',   labelKey: 'sidebar.itilDesigner',    icon: Settings2 },
  { to: '/settings/enum-designer',   labelKey: 'sidebar.enumDesigner',    icon: Tag      },
  { to: '/workflow',                  labelKey: 'sidebar.workflowDesigner', icon: Route    },
  { to: '/profile',                   labelKey: 'sidebar.profile',          icon: UserCircle },
]

const ITSM_ITEM_DEFS = [
  { to: '/incidents', labelKey: 'sidebar.incidents', icon: AlertCircle    },
  { to: '/problems',  labelKey: 'sidebar.problems',  icon: Bug            },
  { to: '/changes',   labelKey: 'sidebar.changes',   icon: GitPullRequest },
  { to: '/requests',  labelKey: 'sidebar.requests',  icon: Inbox          },
]

const REPORTING_ITEM_DEFS = [
  { to: '/reports',        labelKey: 'sidebar.aiAnalysis',    icon: BrainCircuit },
  { to: '/custom-reports', labelKey: 'sidebar.reportBuilder', icon: LayoutGrid   },
]

const ADMIN_NAV_ITEM_DEFS = [
  { to: '/logs',              labelKey: 'sidebar.logs',       icon: ScrollText  },
  { to: '/admin/audit',       labelKey: 'sidebar.auditLog',   icon: ShieldCheck },
  { to: '/admin/monitoring',  labelKey: 'sidebar.monitoring', icon: Activity    },
]

// ── colours ──────────────────────────────────────────────────────────────────
const C = {
  bg:           '#3d4856',
  border:       '#4f5e70',
  textDefault:  '#e2e8f0',
  textSection:  '#94a3b8',
  textChevron:  '#94a3b8',
  hoverBg:      'rgba(255,255,255,0.08)',
  activeBg:     'rgba(255,255,255,0.08)',
  brand:        '#38bdf8',
}

interface SidebarProps {
  collapsed: boolean
  width:     number
  onToggle:  () => void
}

export function Sidebar({ collapsed, width, onToggle }: SidebarProps) {
  const { t } = useTranslation()
  const { pathname } = useLocation()
  const [configOpen, setConfigOpen] = useState(
    () => pathname.startsWith('/settings/ci-types') || pathname.startsWith('/settings/itil-designer') || pathname.startsWith('/settings/enum-designer') || pathname.startsWith('/workflow') || pathname.startsWith('/profile'),
  )
  const [itsmOpen, setItsmOpen] = useState(
    () => ITSM_ITEM_DEFS.some(({ to }) => pathname.startsWith(to)),
  )
  const [cmdbOpen, setCmdbOpen] = useState(
    () => pathname.startsWith('/cmdb') || pathname.startsWith('/ci/'),
  )
  const [teamsOpen, setTeamsOpen] = useState(
    () => pathname.startsWith('/teams') || pathname.startsWith('/users'),
  )
  const [settingsOpen, setSettingsOpen] = useState(
    () => pathname.startsWith('/settings') || pathname === '/settings/notification-rules',
  )
  const [reportingOpen, setReportingOpen] = useState(
    () => pathname.startsWith('/reports') || pathname.startsWith('/custom-reports'),
  )
  const [analysisOpen, setAnalysisOpen] = useState(
    () => ANALYSIS_ITEM_DEFS.some(({ to }) => pathname.startsWith(to)),
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
    color:           isActive ? C.brand : C.textDefault,
    backgroundColor: isActive ? C.activeBg : 'transparent',
    borderLeft:      isActive ? `2px solid ${C.brand}` : '2px solid transparent',
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
    color:          isActive ? C.brand : C.textDefault,
    fontWeight:     isActive ? 600 : 400,
    textDecoration: 'none',
    cursor:         'pointer',
    marginBottom:   1,
  })

  const configActive    = CONFIG_ITEM_DEFS.some(({ to }) => pathname.startsWith(to))
  const itsmActive      = ITSM_ITEM_DEFS.some(({ to }) => pathname.startsWith(to))
  const reportingActive = pathname.startsWith('/reports') || pathname.startsWith('/custom-reports')
  const analysisActive  = ANALYSIS_ITEM_DEFS.some(({ to }) => pathname.startsWith(to))

  const cmdbActive = pathname.startsWith('/cmdb') || pathname.startsWith('/ci/')
    || pathname.startsWith('/applications') || pathname.startsWith('/databases')
    || pathname.startsWith('/database-instances') || pathname.startsWith('/servers')
    || pathname.startsWith('/certificates')

  const hoverOn  = (e: React.MouseEvent, active: boolean) => {
    if (!active) (e.currentTarget as HTMLElement).style.backgroundColor = C.hoverBg
  }
  const hoverOff = (e: React.MouseEvent, active: boolean) => {
    if (!active) (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent'
  }

  const parentGroupStyle = (isActive: boolean): React.CSSProperties => ({
    display:         'flex',
    alignItems:      'center',
    justifyContent:  'space-between',
    padding:         '7px 10px',
    borderRadius:    6,
    cursor:          'pointer',
    backgroundColor: isActive ? C.activeBg : 'transparent',
    borderLeft:      isActive ? `2px solid ${C.brand}` : '2px solid transparent',
    transition:      'background 150ms',
    margin:          '1px 0',
  })

  return (
    <aside
      style={{
        position:        'fixed',
        left:            0,
        top:             0,
        bottom:          0,
        width:           width,
        backgroundColor: C.bg,
        borderRight:     `1px solid ${C.border}`,
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
          borderBottom:    `1px solid ${C.border}`,
          display:         'flex',
          alignItems:      'center',
          justifyContent:  collapsed ? 'center' : 'flex-start',
          padding:         collapsed ? 0 : '0 16px',
          gap:             10,
          flexShrink:      0,
        }}
      >
        {collapsed ? (
          <img src="/opengrafo-icon-dark.svg" alt="OPENGRAFO" style={{ width: 32, height: 32 }} />
        ) : (
          <img src="/opengrafo_logo_v2.svg" alt="OPENGRAFO" style={{ height: 36, width: 'auto' }} />
        )}
      </div>

      {/* Nav */}
      <nav
        aria-label="Menu principale"
        style={{
          flex:      1,
          overflowY: 'auto',
          padding:   '16px 8px 8px',
        }}
      >
        {!collapsed && (
          <p
            style={{
              color:         C.textSection,
              fontSize:      10,
              fontWeight:    600,
              letterSpacing: '0.08em',
              padding:       '0 8px 8px',
              margin:        0,
            }}
          >
            {t('sidebar.workspace')}
          </p>
        )}

        {NAV_ITEM_DEFS.map(({ to, labelKey, icon: Icon }) => {
          const label = t(labelKey)
          const isActive = pathname === to || (to !== '/dashboard' && pathname.startsWith(to))

          return (
            <NavLink
              key={to}
              to={to}
              title={collapsed ? label : undefined}
              style={navItemStyle(isActive, collapsed)}
              onMouseEnter={(e) => hoverOn(e, isActive)}
              onMouseLeave={(e) => hoverOff(e, isActive)}
            >
              <Icon size={16} aria-hidden="true" style={{ flexShrink: 0, color: C.brand }} />
              {!collapsed && <span style={{ flex: 1 }}>{label}</span>}
            </NavLink>
          )
        })}

        {/* ITIL Processes — collapsible */}
        {collapsed ? (
          <NavLink
            to="/incidents"
            title={t('sidebar.itilProcesses')}
            style={navItemStyle(itsmActive, true)}
            onMouseEnter={(e) => hoverOn(e, itsmActive)}
            onMouseLeave={(e) => hoverOff(e, itsmActive)}
          >
            <ListChecks size={16} aria-hidden="true" style={{ flexShrink: 0, color: C.brand }} />
          </NavLink>
        ) : (
          <div style={{ marginBottom: 2 }}>
            <div
              onClick={() => setItsmOpen((p) => !p)}
              style={parentGroupStyle(itsmActive)}
              onMouseEnter={(e) => hoverOn(e, itsmActive)}
              onMouseLeave={(e) => hoverOff(e, itsmActive)}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <ListChecks size={16} aria-hidden="true" style={{ flexShrink: 0, color: C.brand }} />
                <span style={{ fontSize: 13, fontWeight: itsmActive ? 600 : 400, color: itsmActive ? C.brand : C.textDefault }}>
                  {t('sidebar.itilProcesses')}
                </span>
              </div>
              {itsmOpen
                ? <ChevronDown size={12} aria-hidden="true" color={C.textChevron} />
                : <ChevronRight size={12} aria-hidden="true" color={C.textChevron} />}
            </div>

            {itsmOpen && (
              <div style={{ paddingLeft: 28, marginTop: 2 }}>
                {ITSM_ITEM_DEFS.map(({ to, labelKey, icon: Icon }) => (
                  <NavLink key={to} to={to} style={({ isActive }) => subItemStyle(isActive)}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Icon size={12} aria-hidden="true" style={{ color: C.brand, flexShrink: 0 }} />
                      {t(labelKey)}
                    </span>
                  </NavLink>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Reporting — collapsible */}
        {collapsed ? (
          <NavLink
            to="/reports"
            title={t('sidebar.reporting')}
            style={navItemStyle(reportingActive, true)}
            onMouseEnter={(e) => hoverOn(e, reportingActive)}
            onMouseLeave={(e) => hoverOff(e, reportingActive)}
          >
            <BarChart2 size={16} aria-hidden="true" style={{ flexShrink: 0, color: C.brand }} />
          </NavLink>
        ) : (
          <div style={{ marginBottom: 2 }}>
            <div
              onClick={() => setReportingOpen((p) => !p)}
              style={parentGroupStyle(reportingActive)}
              onMouseEnter={(e) => hoverOn(e, reportingActive)}
              onMouseLeave={(e) => hoverOff(e, reportingActive)}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <BarChart2 size={16} aria-hidden="true" style={{ flexShrink: 0, color: C.brand }} />
                <span style={{ fontSize: 13, fontWeight: reportingActive ? 600 : 400, color: reportingActive ? C.brand : C.textDefault }}>
                  {t('sidebar.reporting')}
                </span>
              </div>
              {reportingOpen
                ? <ChevronDown size={12} aria-hidden="true" color={C.textChevron} />
                : <ChevronRight size={12} aria-hidden="true" color={C.textChevron} />}
            </div>

            {reportingOpen && (
              <div style={{ paddingLeft: 28, marginTop: 2 }}>
                {REPORTING_ITEM_DEFS.map(({ to, labelKey, icon: Icon }) => (
                  <NavLink key={to} to={to} style={({ isActive }) => subItemStyle(isActive)}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Icon size={12} aria-hidden="true" style={{ color: C.brand, flexShrink: 0 }} />
                      {t(labelKey)}
                    </span>
                  </NavLink>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Analysis — collapsible */}
        {collapsed ? (
          <NavLink
            to="/anomalies"
            title={t('sidebar.analysis')}
            style={navItemStyle(analysisActive, true)}
            onMouseEnter={(e) => hoverOn(e, analysisActive)}
            onMouseLeave={(e) => hoverOff(e, analysisActive)}
          >
            <Activity size={16} aria-hidden="true" style={{ flexShrink: 0, color: C.brand }} />
          </NavLink>
        ) : (
          <div style={{ marginBottom: 2 }}>
            <div
              onClick={() => setAnalysisOpen((p) => !p)}
              style={parentGroupStyle(analysisActive)}
              onMouseEnter={(e) => hoverOn(e, analysisActive)}
              onMouseLeave={(e) => hoverOff(e, analysisActive)}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Activity size={16} aria-hidden="true" style={{ flexShrink: 0, color: C.brand }} />
                <span style={{ fontSize: 13, fontWeight: analysisActive ? 600 : 400, color: analysisActive ? C.brand : C.textDefault }}>
                  {t('sidebar.analysis')}
                </span>
              </div>
              {analysisOpen
                ? <ChevronDown size={12} aria-hidden="true" color={C.textChevron} />
                : <ChevronRight size={12} aria-hidden="true" color={C.textChevron} />}
            </div>

            {analysisOpen && (
              <div style={{ paddingLeft: 28, marginTop: 2 }}>
                {ANALYSIS_ITEM_DEFS.map(({ to, labelKey, icon: Icon }) => (
                  <NavLink key={to} to={to} style={({ isActive }) => subItemStyle(isActive)}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Icon size={12} aria-hidden="true" style={{ color: C.brand, flexShrink: 0 }} />
                      {t(labelKey)}
                    </span>
                    {to === '/anomalies' && anomalyCritical > 0 && (
                      <span
                        aria-label={`${anomalyCritical} anomalie critiche`}
                        style={{
                          fontSize: 10, fontWeight: 700, lineHeight: 1,
                          padding: '2px 5px', borderRadius: 8,
                          background: 'var(--danger)', color: '#fff',
                        }}
                      >
                        {anomalyCritical}
                      </span>
                    )}
                  </NavLink>
                ))}
              </div>
            )}
          </div>
        )}

        {/* CMDB — collapsible */}
        {collapsed ? (
          <NavLink
            to="/cmdb"
            title={t('sidebar.cmdb')}
            style={navItemStyle(cmdbActive, true)}
            onMouseEnter={(e) => hoverOn(e, cmdbActive)}
            onMouseLeave={(e) => hoverOff(e, cmdbActive)}
          >
            <Server size={16} aria-hidden="true" style={{ flexShrink: 0, color: C.brand }} />
          </NavLink>
        ) : (
          <div style={{ marginBottom: 2 }}>
            <div
              onClick={() => setCmdbOpen((p) => !p)}
              style={parentGroupStyle(cmdbActive)}
              onMouseEnter={(e) => hoverOn(e, cmdbActive)}
              onMouseLeave={(e) => hoverOff(e, cmdbActive)}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Server size={16} aria-hidden="true" style={{ flexShrink: 0, color: C.brand }} />
                <span style={{ fontSize: 13, fontWeight: cmdbActive ? 600 : 400, color: cmdbActive ? C.brand : C.textDefault }}>
                  {t('sidebar.cmdb')}
                </span>
              </div>
              {cmdbOpen
                ? <ChevronDown size={12} aria-hidden="true" color={C.textChevron} />
                : <ChevronRight size={12} aria-hidden="true" color={C.textChevron} />}
            </div>

            {cmdbOpen && (
              <div style={{ paddingLeft: 28, marginTop: 2 }}>
                <NavLink to="/cmdb" end style={({ isActive }) => subItemStyle(isActive)}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Server size={12} aria-hidden="true" style={{ color: C.brand, flexShrink: 0 }} />
                    {t('sidebar.all')}
                  </span>
                </NavLink>
                {ciTypes.map(ct => {
                  const to = `/ci/${ct.name}`
                  const isActive = pathname === to || pathname.startsWith(`${to}/`)
                  const CI_LABEL_KEYS: Record<string, string> = {
                    application:       'sidebar.application',
                    server:            'sidebar.server',
                    database:          'sidebar.database',
                    database_instance: 'sidebar.dbInstance',
                    certificate:       'sidebar.certificate',
                    ssl_certificate:   'sidebar.certificate',
                  }
                  const labelKey = CI_LABEL_KEYS[ct.name]
                  const label = labelKey ? t(labelKey) : ct.label
                  return (
                    <NavLink key={ct.name} to={to} style={() => subItemStyle(isActive)}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <CIIcon icon={ct.icon} size={12} color={C.brand} />
                        {label}
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
              style={parentGroupStyle(false)}
              onMouseEnter={(e) => hoverOn(e, false)}
              onMouseLeave={(e) => hoverOff(e, false)}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Users size={16} aria-hidden="true" style={{ flexShrink: 0, color: C.brand }} />
                <span style={{ fontSize: 13, fontWeight: 400, color: C.textDefault }}>{t('sidebar.teamsUsers')}</span>
              </div>
              {teamsOpen
                ? <ChevronDown size={12} aria-hidden="true" color={C.textChevron} />
                : <ChevronRight size={12} aria-hidden="true" color={C.textChevron} />}
            </div>

            {teamsOpen && (
              <div style={{ paddingLeft: 28, marginTop: 2 }}>
                <NavLink to="/teams" style={({ isActive }) => subItemStyle(isActive)}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <UsersRound size={12} aria-hidden="true" style={{ color: C.brand, flexShrink: 0 }} />
                    {t('sidebar.teams')}
                  </span>
                </NavLink>
                <NavLink to="/users" style={({ isActive }) => subItemStyle(isActive)}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <User size={12} aria-hidden="true" style={{ color: C.brand, flexShrink: 0 }} />
                    {t('sidebar.users')}
                  </span>
                </NavLink>
              </div>
            )}
          </div>
        )}

        {/* Configuration — collapsible */}
        {collapsed ? (
          <NavLink
            to="/workflow"
            title={t('sidebar.configuration')}
            style={navItemStyle(configActive, true)}
            onMouseEnter={(e) => hoverOn(e, configActive)}
            onMouseLeave={(e) => hoverOff(e, configActive)}
          >
            <SlidersHorizontal size={16} aria-hidden="true" style={{ flexShrink: 0, color: C.brand }} />
          </NavLink>
        ) : (
          <div style={{ marginBottom: 2 }}>
            <div
              onClick={() => setConfigOpen((p) => !p)}
              style={parentGroupStyle(configActive)}
              onMouseEnter={(e) => hoverOn(e, configActive)}
              onMouseLeave={(e) => hoverOff(e, configActive)}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <SlidersHorizontal size={16} aria-hidden="true" style={{ flexShrink: 0, color: C.brand }} />
                <span style={{ fontSize: 13, fontWeight: configActive ? 600 : 400, color: configActive ? C.brand : C.textDefault }}>
                  {t('sidebar.configuration')}
                </span>
              </div>
              {configOpen
                ? <ChevronDown size={12} aria-hidden="true" color={C.textChevron} />
                : <ChevronRight size={12} aria-hidden="true" color={C.textChevron} />}
            </div>
            {configOpen && (
              <div style={{ paddingLeft: 28, marginTop: 2 }}>
                {CONFIG_ITEM_DEFS.map(({ to, labelKey, icon: Icon }) => (
                  <NavLink key={to} to={to} style={({ isActive }) => subItemStyle(isActive)}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Icon size={12} aria-hidden="true" style={{ color: C.brand, flexShrink: 0 }} />
                      {t(labelKey)}
                    </span>
                  </NavLink>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Admin items + Settings */}
        {isAdmin && (
          <>
            {!collapsed && (
              <p style={{ color: C.textSection, fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', padding: '8px 8px 4px', margin: 0 }}>
                {t('sidebar.admin')}
              </p>
            )}
            {ADMIN_NAV_ITEM_DEFS.map(({ to, labelKey, icon: Icon }) => {
              const label = t(labelKey)
              const isActive = pathname === to || pathname.startsWith(to + '/')
              return (
                <NavLink
                  key={to}
                  to={to}
                  title={collapsed ? label : undefined}
                  style={navItemStyle(isActive, collapsed)}
                  onMouseEnter={(e) => hoverOn(e, isActive)}
                  onMouseLeave={(e) => hoverOff(e, isActive)}
                >
                  <Icon size={16} aria-hidden="true" style={{ flexShrink: 0, color: C.brand }} />
                  {!collapsed && label}
                </NavLink>
              )
            })}

            {/* Settings — collapsible, dentro ADMIN */}
            {collapsed ? (
              <NavLink
                to="/settings/notifications"
                title={t('sidebar.settings')}
                style={navItemStyle(settingsActive, true)}
                onMouseEnter={(e) => hoverOn(e, settingsActive)}
                onMouseLeave={(e) => hoverOff(e, settingsActive)}
              >
                <Settings size={16} aria-hidden="true" style={{ flexShrink: 0, color: C.brand }} />
              </NavLink>
            ) : (
              <div style={{ marginBottom: 2 }}>
                <div
                  onClick={() => setSettingsOpen((p) => !p)}
                  style={parentGroupStyle(settingsActive)}
                  onMouseEnter={(e) => hoverOn(e, settingsActive)}
                  onMouseLeave={(e) => hoverOff(e, settingsActive)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <Settings size={16} aria-hidden="true" style={{ flexShrink: 0, color: C.brand }} />
                    <span style={{ fontSize: 13, fontWeight: settingsActive ? 600 : 400, color: settingsActive ? C.brand : C.textDefault }}>
                      {t('sidebar.settings')}
                    </span>
                  </div>
                  {settingsOpen
                    ? <ChevronDown size={12} aria-hidden="true" color={C.textChevron} />
                    : <ChevronRight size={12} aria-hidden="true" color={C.textChevron} />}
                </div>
                {settingsOpen && (
                  <div style={{ paddingLeft: 28, marginTop: 2 }}>
                    <NavLink to="/settings/notifications" style={({ isActive }) => subItemStyle(isActive)}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Bell size={12} aria-hidden="true" style={{ color: C.brand, flexShrink: 0 }} />
                        {t('sidebar.notificationChannels')}
                      </span>
                    </NavLink>
                    <NavLink to="/settings/notification-rules" style={({ isActive }) => subItemStyle(isActive)}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Bell size={12} aria-hidden="true" style={{ color: C.brand, flexShrink: 0 }} />
                        {t('sidebar.notificationRules')}
                      </span>
                    </NavLink>
                    <NavLink to="/settings/sync" style={({ isActive }) => subItemStyle(isActive)}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Activity size={12} aria-hidden="true" style={{ color: C.brand, flexShrink: 0 }} />
                        {t('sidebar.cmdbSync')}
                      </span>
                    </NavLink>
                    <NavLink to="/admin/queues" style={({ isActive }) => subItemStyle(isActive)}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Activity size={12} aria-hidden="true" style={{ color: C.brand, flexShrink: 0 }} />
                        {t('sidebar.bullBoard')}
                      </span>
                    </NavLink>
                    <NavLink to="/settings/profile" style={({ isActive }) => subItemStyle(isActive)}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <CircleUser size={12} aria-hidden="true" style={{ color: C.brand, flexShrink: 0 }} />
                        {t('sidebar.profile')}
                      </span>
                    </NavLink>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </nav>

      {/* Collapse toggle */}
      <button
        onClick={onToggle}
        aria-label={collapsed ? t('sidebar.expand', 'Espandi sidebar') : t('sidebar.collapse', 'Comprimi sidebar')}
        style={{
          display:         'flex',
          alignItems:      'center',
          justifyContent:  collapsed ? 'center' : 'flex-start',
          gap:             8,
          padding:         collapsed ? '12px 0' : '12px 16px',
          background:      'none',
          border:          'none',
          borderTop:       `1px solid ${C.border}`,
          color:           C.textSection,
          cursor:          'pointer',
          width:           '100%',
          flexShrink:      0,
          fontSize:        12,
          transition:      'background 150ms',
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = C.hoverBg }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent' }}
      >
        {collapsed
          ? <ChevronRight size={14} aria-hidden="true" />
          : <><ChevronLeft size={14} aria-hidden="true" /><span>{t('sidebar.collapse', 'Collapse')}</span></>
        }
      </button>
    </aside>
  )
}
