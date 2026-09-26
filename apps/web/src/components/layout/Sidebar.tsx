import { useCILabels } from '@/hooks/useCILabels'
import { useLocation } from 'react-router-dom'
// F-21: i contatori della barra non interrogano l'API a scheda nascosta.
import { pausedWhenHidden } from '@/lib/polling'
import { useQuery } from '@apollo/client/react'
import { gql } from '@apollo/client'
import { useTranslation } from 'react-i18next'
import { GET_ANOMALY_STATS } from '@/graphql/queries'
import { ListChecks, Server, BarChart2, Activity, Radar, HeartPulse } from 'lucide-react'
import { useMe } from '@/hooks/useMe'
import { routePermissions } from '@/lib/routePermissions'
import { useMetamodel } from '@/contexts/MetamodelContext'
import { CIIcon } from '@/lib/ciIcon'
import { C, NavItem, SubItem } from './SidebarNavItems'
import { SidebarGroup, useGroupOpen } from './SidebarGroup'
import { voceAttiva } from './menuActive'
import { NAV_ITEM_DEFS, ANALYSIS_ITEM_DEFS, MONITORING_ITEM_DEFS, PROFILE_ITEM, ITSM_ITEM_DEFS, REPORTING_ITEM_DEFS, ADMIN_GROUPS, type MenuGroupDef } from './menu'
import { SidebarCollapseButton } from './SidebarUserMenu'
import { colors } from '@/lib/tokens'

const MY_PENDING_APPROVALS_COUNT = gql`
  query MyPendingApprovalsCount {
    myPendingApprovals { id }
    pendingTicketApprovals { kind entityId onBehalf }
  }
`

/**
 * Chiave i18n dei tipi CI SPEDITI, usata SOLO quando il cliente non ha scritto
 * un'etichetta sua (revisione totale · F-22): prima la chiave scavalcava
 * `ciType.label`, quindi chi rinominava «Server» in «Host fisico» lo vedeva
 * nel titolo della pagina e non nel menu, nel breadcrumb e nella lista.
 * A livello di modulo: non si ricostruisce a ogni render (E-12).
 */
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
  const ciLabels = useCILabels()
  const { pathname } = useLocation()

  // Same source of truth as the route guards: the PERMISSIONS of `me.role`
  // (wave 7), read from the one table `lib/routePermissions`. An item shows
  // only when its page opens, and a group only when it has items — no menu
  // entry may lead to a "forbidden" page.
  const { can } = useMe()
  const opens = (to: string) => can(...routePermissions(to))
  const visible = <T extends { to: string }>(defs: readonly T[]): T[] => defs.filter((d) => opens(d.to))
  const nav        = visible(NAV_ITEM_DEFS)
  const itsm       = visible(ITSM_ITEM_DEFS)
  const reporting  = visible(REPORTING_ITEM_DEFS)
  const analysis   = visible(ANALYSIS_ITEM_DEFS)
  const monitoring = visible(MONITORING_ITEM_DEFS)
  // A group only when the role opens at least one of its pages.
  const adminGroups = ADMIN_GROUPS.map((g) => ({ ...g, items: visible(g.items) })).filter((g) => g.items.length > 0)
  const { ciTypes } = useMetamodel()

  // Una voce accesa sola, la più specifica fra TUTTE quelle del menu.
  const attiva = voceAttiva(pathname, [
    ...NAV_ITEM_DEFS, ...ITSM_ITEM_DEFS, ...REPORTING_ITEM_DEFS, ...ANALYSIS_ITEM_DEFS,
    ...MONITORING_ITEM_DEFS, ...ADMIN_GROUPS.flatMap((g) => g.items), PROFILE_ITEM,
  ].map((d) => d.to).concat('/cmdb', '/cmdb/health', ciTypes.map((ct) => `/ci/${ct.name}`)))

  // Active flags derived from the location; open state re-opens on entry (E-12).
  const itsmActive      = startsWithAny(pathname, ITSM_ITEM_DEFS)
  const reportingActive = pathname.startsWith('/reports') || pathname.startsWith('/custom-reports')
  const analysisActive  = startsWithAny(pathname, ANALYSIS_ITEM_DEFS)
  const monitoringActive = pathname.startsWith('/events') || pathname.startsWith('/monitoring') || pathname.startsWith('/settings/event-policy')
  const cmdbActive      = CMDB_LEGACY_PREFIXES.some((p) => pathname.startsWith(p))

  const [itsmOpen, toggleItsm]           = useGroupOpen(itsmActive)
  const [reportingOpen, toggleReporting] = useGroupOpen(reportingActive)
  const [analysisOpen, toggleAnalysis]   = useGroupOpen(analysisActive)
  const [monitoringOpen, toggleMonitoring] = useGroupOpen(monitoringActive)
  const [cmdbOpen, toggleCmdb]           = useGroupOpen(cmdbActive)

  const { data: anomalyStatsData, error: anomalyError } = useQuery<{ anomalyStats: { critical: number; open: number } }>(
    GET_ANOMALY_STATS,
    { ...pausedWhenHidden(60_000), fetchPolicy: 'cache-and-network', skip: !opens('/anomalies') },
  )
  const anomalyCritical = anomalyStatsData?.anomalyStats?.critical ?? 0

  // Il badge conta tutto quello che la pagina Approvazioni elenca: le richieste
  // generiche e le approvazioni che si decidono nel ticket (change, richieste).
  const { data: pendingApprovalsData } = useQuery<{ myPendingApprovals: { id: string }[]; pendingTicketApprovals: { kind: string; entityId: string; onBehalf: boolean }[] }>(
    MY_PENDING_APPROVALS_COUNT,
    { ...pausedWhenHidden(60_000), fetchPolicy: 'cache-and-network', skip: !opens('/approvals') },
  )
  // Only the approvals of my teams: what I could decide for another team does not count (24 Sep 2026).
  const pendingApprovalsCount = (pendingApprovalsData?.myPendingApprovals?.length ?? 0)
    + (pendingApprovalsData?.pendingTicketApprovals ?? []).filter((a) => !a.onBehalf).length

  const anomalyBadge = (anomalyCritical > 0 || anomalyError) ? (
    <span
      aria-label={anomalyError ? t('sidebar.anomalyLoadError') : t('sidebar.criticalAnomalies', { count: anomalyCritical })}
      title={anomalyError ? anomalyError.message : undefined}
      style={{
        fontSize: 'var(--font-size-label)', fontWeight: 700, lineHeight: 1,
        padding: '2px 5px', borderRadius: 8,
        background: 'var(--danger)', color: colors.white,
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
          // The icon's drawing has room around it: at 32 px it read as a dot (tour of 24 Sep 2026, G6).
          <img src="/opengrafo-icon-dark.svg" alt="OPENGRAFO" style={{ width: 44, height: 44 }} />
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

        {nav.map(({ to, labelKey, icon: Icon }) => {
          const label = t(labelKey)
          const isActive = to === attiva
          const badge = to === '/approvals' && pendingApprovalsCount > 0 ? pendingApprovalsCount : 0
          return (
            <NavItem key={to} to={to} label={label} icon={Icon} collapsed={collapsed} isActive={isActive} badge={badge} />
          )
        })}

        {/* ITIL Processes */}
        {itsm.length > 0 && (
          <SidebarGroup title={t('sidebar.itilProcesses')} icon={ListChecks} active={itsmActive} open={itsmOpen} onToggle={toggleItsm} collapsed={collapsed} collapsedTo={itsm[0]!.to}>
            {itsm.map(({ to, labelKey, icon }) => <SubItem key={to} to={to} label={t(labelKey)} icon={icon} isActive={to === attiva} />)}
          </SidebarGroup>
        )}

        {/* Reporting */}
        {reporting.length > 0 && (
          <SidebarGroup title={t('sidebar.reporting')} icon={BarChart2} active={reportingActive} open={reportingOpen} onToggle={toggleReporting} collapsed={collapsed} collapsedTo={reporting[0]!.to}>
            {reporting.map(({ to, labelKey, icon }) => <SubItem key={to} to={to} label={t(labelKey)} icon={icon} isActive={to === attiva} />)}
          </SidebarGroup>
        )}

        {/* Analysis */}
        {analysis.length > 0 && (
          <SidebarGroup title={t('sidebar.analysis')} icon={Activity} active={analysisActive} open={analysisOpen} onToggle={toggleAnalysis} collapsed={collapsed} collapsedTo={analysis[0]!.to}>
            {analysis.map(({ to, labelKey, icon }) => (
              <SubItem key={to} to={to} label={t(labelKey)} icon={icon} isActive={to === attiva} trailing={to === '/anomalies' ? anomalyBadge : undefined} />
            ))}
          </SidebarGroup>
        )}

        {/* Monitoraggio (Event Management) */}
        {monitoring.length > 0 && (
          <SidebarGroup title={t('sidebar.monitoring')} icon={Radar} active={monitoringActive} open={monitoringOpen} onToggle={toggleMonitoring} collapsed={collapsed} collapsedTo={monitoring[0]!.to}>
            {monitoring.map(({ to, labelKey, icon }) => (
              <SubItem key={to} to={to} label={t(labelKey)} icon={icon} isActive={to === attiva} />
            ))}
          </SidebarGroup>
        )}

        {/* CMDB */}
        {opens('/cmdb') && (
        <SidebarGroup title={t('sidebar.cmdb')} icon={Server} active={cmdbActive} open={cmdbOpen} onToggle={toggleCmdb} collapsed={collapsed} collapsedTo="/cmdb">
          <SubItem to="/cmdb" label={t('sidebar.all')} icon={Server} isActive={attiva === '/cmdb'} />
          {/* The quality of the CMDB's data, live (24 Sep 2026): same permission as the CMDB. */}
          <SubItem to="/cmdb/health" label={t('sidebar.cmdbHealth')} icon={HeartPulse} isActive={attiva === '/cmdb/health'} />
          {ciTypes.map(ct => {
            const to = `/ci/${ct.name}`
            // L'etichetta del cliente vince; la chiave spedita è il ripiego.
            const labelKey = CI_LABEL_KEYS[ct.name]
            return (
              <SubItem
                key={ct.name}
                to={to}
                // useCILabels: the customer's per-language labels first (review of 23 Sep 2026).
                label={(ct.label || ct.labels?.length) ? ciLabels.typeLabel(ct.name) : (labelKey ? t(labelKey) : ct.name)}
                iconNode={<CIIcon icon={ct.icon} size={12} color={C.brand} />}
                isActive={to === attiva}
              />
            )
          })}
        </SidebarGroup>
        )}

        {/* Profile — personal, the whole workspace */}
        {opens(PROFILE_ITEM.to) && (
          <NavItem
            to={PROFILE_ITEM.to}
            label={t(PROFILE_ITEM.labelKey)}
            icon={PROFILE_ITEM.icon}
            collapsed={collapsed}
            isActive={attiva === PROFILE_ITEM.to}
          />
        )}

        {/* Administration: one group per topic (26 Sep 2026) */}
        {adminGroups.length > 0 && (
          <>
            {!collapsed && (
              <p style={{ color: C.textSection, fontSize: 'var(--font-size-label)', fontWeight: 600, letterSpacing: '0.08em', padding: '8px 8px 4px', margin: 0 }}>
                {t('sidebar.admin')}
              </p>
            )}
            {adminGroups.map((g) => <AdminGroup key={g.groupKey} group={g} attiva={attiva} collapsed={collapsed} />)}
          </>
        )}
      </nav>

      {/* Collapse toggle */}
      <SidebarCollapseButton collapsed={collapsed} onToggle={onToggle} />
    </aside>
  )
}

/**
 * One administration group: open while one of its pages is the current one,
 * like every other group. Its own component, so each group holds its own
 * open state (a hook per group, never in a loop).
 */
function AdminGroup({ group, attiva, collapsed }: { group: MenuGroupDef; attiva: string | null; collapsed: boolean }) {
  const { t } = useTranslation()
  const active = group.items.some((i) => i.to === attiva)
  const [open, toggle] = useGroupOpen(active)
  return (
    <SidebarGroup title={t(group.groupKey)} icon={group.icon} active={active} open={open} onToggle={toggle} collapsed={collapsed} collapsedTo={group.items[0]!.to}>
      {group.items.map(({ to, labelKey, icon }) => <SubItem key={to} to={to} label={t(labelKey)} icon={icon} isActive={to === attiva} />)}
    </SidebarGroup>
  )
}
