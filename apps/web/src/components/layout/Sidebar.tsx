import { NavLink, useLocation } from 'react-router-dom'
import { useQuery } from '@apollo/client/react'
import { gql } from '@apollo/client'
import { useTranslation } from 'react-i18next'
import { GET_ANOMALY_STATS } from '@/graphql/queries'
import {
  LayoutDashboard,
  AlertCircle,
  Search,
  GitPullRequest,
  HelpCircle,
  ClipboardList,
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
  Layers,
  Settings,
  Settings2,
  Activity,
  ShieldAlert,
  ShieldCheck,
  Share2,
  Bell,
  UserCircle,
  Tag,
  CheckSquare,
  BookOpen,
  Zap,
  GitBranch,
  Clock,
  Plug,
  FlaskConical,
  Sparkles,
  ShoppingCart,
  Gauge,
  Radar,
  HeartPulse,
} from 'lucide-react'
import { useMe } from '@/hooks/useMe'
import { isStaff } from '@/lib/roles'
import { useMetamodel } from '@/contexts/MetamodelContext'
import { CIIcon } from '@/lib/ciIcon'
import { C, navItemStyle, NavItem, SubItem } from './SidebarNavItems'
import { SidebarGroup, useGroupOpen } from './SidebarGroup'
import { SidebarCollapseButton } from './SidebarUserMenu'

const MY_PENDING_APPROVALS_COUNT = gql`
  query MyPendingApprovalsCount {
    myPendingApprovals { id }
  }
`

const NAV_ITEM_DEFS = [
  { to: '/dashboard',      labelKey: 'sidebar.dashboard',     icon: LayoutDashboard },
  { to: '/approvals',      labelKey: 'sidebar.approvals',     icon: CheckSquare },
  { to: '/knowledge-base', labelKey: 'sidebar.knowledgeBase', icon: BookOpen },
  { to: '/assistant',      labelKey: 'sidebar.assistant',     icon: Sparkles },
]

const ANALYSIS_ITEM_DEFS = [
  { to: '/anomalies',        labelKey: 'sidebar.anomalies',   icon: ShieldAlert  },
  { to: '/topology',         labelKey: 'sidebar.topologyMap', icon: Share2       },
  { to: '/analysis/what-if', labelKey: 'sidebar.whatIf',      icon: FlaskConical },
]

// Monitoraggio (Event Management): console allarmi e pagina Salute CI (staff:
// stesso predicato `isStaff` delle rotte `staff(...)` in main.tsx, il gruppo
// intero è nascosto agli end user), sorgenti e policy (admin: le voci sono
// filtrate per ruolo nel render). La mappa con la salute evidenziata resta
// raggiungibile da "Vedi sulla mappa".
const MONITORING_ITEM_DEFS = [
  { to: '/events',                labelKey: 'sidebar.events',            icon: Radar,      adminOnly: false },
  { to: '/monitoring/health',     labelKey: 'sidebar.ciHealth',          icon: HeartPulse, adminOnly: false },
  { to: '/monitoring/sources',    labelKey: 'sidebar.monitoringSources', icon: Plug,       adminOnly: true  },
  { to: '/settings/event-policy', labelKey: 'sidebar.eventPolicy',       icon: Settings2,  adminOnly: true  },
]

const CONFIG_ITEM_DEFS = [
  { to: '/settings/ci-types',        labelKey: 'sidebar.ciTypeDesigner',  icon: Layers   },
  { to: '/settings/itil-designer',   labelKey: 'sidebar.itilDesigner',    icon: Settings2 },
  { to: '/settings/enum-designer',   labelKey: 'sidebar.enumDesigner',    icon: Tag      },
  { to: '/workflow',                  labelKey: 'sidebar.workflowDesigner', icon: Route    },
]

// Personal page, every role (E-13): language + Slack link.
const PROFILE_ITEM = { to: '/profile', labelKey: 'sidebar.profile', icon: UserCircle }

const ITSM_ITEM_DEFS = [
  { to: '/incidents', labelKey: 'sidebar.incidents', icon: AlertCircle    },
  { to: '/problems',  labelKey: 'sidebar.problems',  icon: Search         },
  { to: '/changes',   labelKey: 'sidebar.changes',   icon: GitPullRequest },
  { to: '/my-tasks',  labelKey: 'sidebar.myTasks',   icon: ClipboardList  },
  { to: '/requests',  labelKey: 'sidebar.requests',  icon: Inbox          },
]

const REPORTING_ITEM_DEFS = [
  { to: '/reports',        labelKey: 'sidebar.aiAnalysis',    icon: BrainCircuit },
  { to: '/reports/sla',    labelKey: 'sidebar.slaReport',     icon: Gauge        },
  { to: '/custom-reports', labelKey: 'sidebar.reportBuilder', icon: LayoutGrid   },
]

const TEAMS_ITEM_DEFS = [
  { to: '/teams', labelKey: 'sidebar.teams', icon: UsersRound },
  { to: '/users', labelKey: 'sidebar.users', icon: User },
]

const SETTINGS_ITEM_DEFS = [
  { to: '/settings/notifications',      labelKey: 'sidebar.notificationChannels', icon: Bell },
  { to: '/settings/notification-rules', labelKey: 'sidebar.notificationRules',    icon: Bell },
  { to: '/settings/sync',               labelKey: 'sidebar.cmdbSync',             icon: Activity },
  { to: '/admin/queues',                labelKey: 'sidebar.bullBoard',            icon: Activity },
]

const ADMIN_NAV_ITEM_DEFS = [
  { to: '/logs',                   labelKey: 'sidebar.logs',           icon: ScrollText  },
  { to: '/admin/audit',            labelKey: 'sidebar.auditLog',       icon: ShieldCheck },
  { to: '/admin/monitoring',       labelKey: 'sidebar.platformMonitoring', icon: Activity },
  { to: '/admin/knowledge-base',   labelKey: 'sidebar.kbAdmin',        icon: BookOpen    },
  { to: '/admin/triggers',         labelKey: 'sidebar.autoTriggers',   icon: Zap         },
  { to: '/admin/business-rules',   labelKey: 'sidebar.businessRules',  icon: GitBranch   },
  { to: '/admin/sla-policies',     labelKey: 'sidebar.slaPolicies',    icon: Clock       },
  { to: '/admin/service-catalog',  labelKey: 'sidebar.serviceCatalog', icon: ShoppingCart},
  { to: '/admin/integrations',         labelKey: 'sidebar.integrations',        icon: Plug        },
  { to: '/admin/assessment-questions', labelKey: 'sidebar.assessmentQuestions', icon: HelpCircle  },
]

// CI type → sidebar label key (module scope: not rebuilt on every render, E-12).
const CI_LABEL_KEYS: Record<string, string> = {
  application:       'sidebar.application',
  server:            'sidebar.server',
  database:          'sidebar.database',
  database_instance: 'sidebar.dbInstance',
  certificate:       'sidebar.certificate',
  ssl_certificate:   'sidebar.certificate',
}

const CMDB_LEGACY_PREFIXES = ['/cmdb', '/ci/', '/applications', '/databases', '/database-instances', '/servers', '/certificates']

const startsWithAny = (pathname: string, defs: readonly { to: string }[]) => defs.some(({ to }) => pathname.startsWith(to))

interface SidebarProps {
  collapsed: boolean
  width:     number
  onToggle:  () => void
}

export function Sidebar({ collapsed, width, onToggle }: SidebarProps) {
  const { t } = useTranslation()
  const { pathname } = useLocation()

  // Same source of truth as the pages and the RequireRole route guard:
  // `me.role` from the DB, not the Keycloak realm role. Groups whose every
  // route is wrapped in `admin(...)` in main.tsx (Teams & Users,
  // Configuration, Admin) are hidden from everyone else — no menu entry may
  // lead to a "forbidden" page.
  const { isAdmin, role } = useMe()
  const staff = isStaff(role)
  const { ciTypes } = useMetamodel()

  // Active flags derived from the location; open state re-opens on entry (E-12).
  const itsmActive      = startsWithAny(pathname, ITSM_ITEM_DEFS)
  const reportingActive = pathname.startsWith('/reports') || pathname.startsWith('/custom-reports')
  const analysisActive  = startsWithAny(pathname, ANALYSIS_ITEM_DEFS)
  const monitoringActive = pathname.startsWith('/events') || pathname.startsWith('/monitoring') || pathname.startsWith('/settings/event-policy')
  const cmdbActive      = CMDB_LEGACY_PREFIXES.some((p) => pathname.startsWith(p))
  const teamsActive     = startsWithAny(pathname, TEAMS_ITEM_DEFS)
  const configActive    = startsWithAny(pathname, CONFIG_ITEM_DEFS)
  // La policy eventi vive sotto /settings ma appartiene al gruppo Monitoraggio: un solo gruppo attivo.
  const settingsActive  = (pathname.startsWith('/settings') && !pathname.startsWith('/settings/event-policy')) || pathname.startsWith('/admin/queues')

  const [itsmOpen, toggleItsm]           = useGroupOpen(itsmActive)
  const [reportingOpen, toggleReporting] = useGroupOpen(reportingActive)
  const [analysisOpen, toggleAnalysis]   = useGroupOpen(analysisActive)
  const [monitoringOpen, toggleMonitoring] = useGroupOpen(monitoringActive)
  const [cmdbOpen, toggleCmdb]           = useGroupOpen(cmdbActive)
  const [teamsOpen, toggleTeams]         = useGroupOpen(teamsActive)
  const [configOpen, toggleConfig]       = useGroupOpen(configActive)
  const [settingsOpen, toggleSettings]   = useGroupOpen(settingsActive)

  const { data: anomalyStatsData, error: anomalyError } = useQuery<{ anomalyStats: { critical: number; open: number } }>(
    GET_ANOMALY_STATS,
    { pollInterval: 60_000, fetchPolicy: 'cache-and-network' },
  )
  const anomalyCritical = anomalyStatsData?.anomalyStats?.critical ?? 0

  const { data: pendingApprovalsData } = useQuery<{ myPendingApprovals: { id: string }[] }>(
    MY_PENDING_APPROVALS_COUNT,
    { pollInterval: 60_000, fetchPolicy: 'cache-and-network' },
  )
  const pendingApprovalsCount = pendingApprovalsData?.myPendingApprovals?.length ?? 0

  const anomalyBadge = (anomalyCritical > 0 || anomalyError) ? (
    <span
      aria-label={anomalyError ? t('sidebar.anomalyLoadError') : t('sidebar.criticalAnomalies', { count: anomalyCritical })}
      title={anomalyError ? anomalyError.message : undefined}
      style={{
        fontSize: 'var(--font-size-label)', fontWeight: 700, lineHeight: 1,
        padding: '2px 5px', borderRadius: 8,
        background: 'var(--danger)', color: '#fff',
      }}
    >
      {anomalyError ? '!' : anomalyCritical}
    </span>
  ) : undefined

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
        aria-label={t('sidebar.mainMenu')}
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
              fontSize:      'var(--font-size-label)',
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
          const badge = to === '/approvals' && pendingApprovalsCount > 0 ? pendingApprovalsCount : 0
          return (
            <NavItem key={to} to={to} label={label} icon={Icon} collapsed={collapsed} isActive={isActive} badge={badge} />
          )
        })}

        {/* ITIL Processes */}
        <SidebarGroup title={t('sidebar.itilProcesses')} icon={ListChecks} active={itsmActive} open={itsmOpen} onToggle={toggleItsm} collapsed={collapsed} collapsedTo="/incidents">
          {ITSM_ITEM_DEFS.map(({ to, labelKey, icon }) => <SubItem key={to} to={to} label={t(labelKey)} icon={icon} />)}
        </SidebarGroup>

        {/* Reporting */}
        <SidebarGroup title={t('sidebar.reporting')} icon={BarChart2} active={reportingActive} open={reportingOpen} onToggle={toggleReporting} collapsed={collapsed} collapsedTo="/reports">
          {REPORTING_ITEM_DEFS.map(({ to, labelKey, icon }) => <SubItem key={to} to={to} label={t(labelKey)} icon={icon} />)}
        </SidebarGroup>

        {/* Analysis */}
        <SidebarGroup title={t('sidebar.analysis')} icon={Activity} active={analysisActive} open={analysisOpen} onToggle={toggleAnalysis} collapsed={collapsed} collapsedTo="/anomalies">
          {ANALYSIS_ITEM_DEFS.map(({ to, labelKey, icon }) => (
            <SubItem key={to} to={to} label={t(labelKey)} icon={icon} trailing={to === '/anomalies' ? anomalyBadge : undefined} />
          ))}
        </SidebarGroup>

        {/* Monitoraggio (Event Management) — staff only (routes are staff(...) in main.tsx) */}
        {staff && (
          <SidebarGroup title={t('sidebar.monitoring')} icon={Radar} active={monitoringActive} open={monitoringOpen} onToggle={toggleMonitoring} collapsed={collapsed} collapsedTo="/events">
            {MONITORING_ITEM_DEFS.filter((d) => isAdmin || !d.adminOnly).map(({ to, labelKey, icon }) => (
              <SubItem key={to} to={to} label={t(labelKey)} icon={icon} isActive={pathname === to || pathname.startsWith(`${to}/`)} />
            ))}
          </SidebarGroup>
        )}

        {/* CMDB */}
        <SidebarGroup title={t('sidebar.cmdb')} icon={Server} active={cmdbActive} open={cmdbOpen} onToggle={toggleCmdb} collapsed={collapsed} collapsedTo="/cmdb">
          <SubItem to="/cmdb" end label={t('sidebar.all')} icon={Server} />
          {ciTypes.map(ct => {
            const to = `/ci/${ct.name}`
            const labelKey = CI_LABEL_KEYS[ct.name]
            return (
              <SubItem
                key={ct.name}
                to={to}
                label={labelKey ? t(labelKey) : ct.label}
                iconNode={<CIIcon icon={ct.icon} size={12} color={C.brand} />}
                isActive={pathname === to || pathname.startsWith(`${to}/`)}
              />
            )
          })}
        </SidebarGroup>

        {/* Profile — personal, every role */}
        <NavItem
          to={PROFILE_ITEM.to}
          label={t(PROFILE_ITEM.labelKey)}
          icon={PROFILE_ITEM.icon}
          collapsed={collapsed}
          isActive={pathname.startsWith(PROFILE_ITEM.to)}
        />

        {/* Teams & Users — admin only (routes are admin(...) in main.tsx) */}
        {isAdmin && (
          <SidebarGroup title={t('sidebar.teamsUsers')} icon={Users} active={teamsActive} open={teamsOpen} onToggle={toggleTeams} collapsed={collapsed} collapsedTo="/teams">
            {TEAMS_ITEM_DEFS.map(({ to, labelKey, icon }) => <SubItem key={to} to={to} label={t(labelKey)} icon={icon} />)}
          </SidebarGroup>
        )}

        {/* Configuration — admin only (routes are admin(...) in main.tsx) */}
        {isAdmin && (
          <SidebarGroup title={t('sidebar.configuration')} icon={SlidersHorizontal} active={configActive} open={configOpen} onToggle={toggleConfig} collapsed={collapsed} collapsedTo="/workflow">
            {CONFIG_ITEM_DEFS.map(({ to, labelKey, icon }) => <SubItem key={to} to={to} label={t(labelKey)} icon={icon} />)}
          </SidebarGroup>
        )}

        {/* Admin items + Settings */}
        {isAdmin && (
          <>
            {!collapsed && (
              <p style={{ color: C.textSection, fontSize: 'var(--font-size-label)', fontWeight: 600, letterSpacing: '0.08em', padding: '8px 8px 4px', margin: 0 }}>
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
                  className="hover-bg"
                >
                  <Icon size={16} aria-hidden="true" style={{ flexShrink: 0, color: C.brand }} />
                  {!collapsed && label}
                </NavLink>
              )
            })}

            {/* Settings — collapsible, dentro ADMIN */}
            <SidebarGroup title={t('sidebar.settings')} icon={Settings} active={settingsActive} open={settingsOpen} onToggle={toggleSettings} collapsed={collapsed} collapsedTo="/settings/notifications">
              {SETTINGS_ITEM_DEFS.map(({ to, labelKey, icon }) => <SubItem key={to} to={to} label={t(labelKey)} icon={icon} />)}
            </SidebarGroup>
          </>
        )}
      </nav>

      {/* Collapse toggle */}
      <SidebarCollapseButton collapsed={collapsed} onToggle={onToggle} />
    </aside>
  )
}
