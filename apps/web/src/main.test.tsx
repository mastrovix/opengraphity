/**
 * THE APP'S ENTRY POINT: sign-in first, then the router.
 *
 * `main.tsx` has no exports: importing it signs in with Keycloak and mounts the
 * app into `#root`. So these tests do what the browser does — they give it a
 * `#root` and import it — with every page replaced by a stub that shows its
 * name, its route parameters and how many times it was mounted. What is real
 * is what `main.tsx` itself decides:
 *  - without a session it goes to the Keycloak login and mounts nothing;
 *  - with one it starts the token refresh and mounts the router;
 *  - when sign-in cannot even start (no tenant in the address, Keycloak down)
 *    it says why on the page, as TEXT: the message comes from the network or
 *    the configuration and must never be read as markup (F-19);
 *  - every address opens its page behind the guard of its OWN row of the
 *    permission table — a page wired to the wrong row opens for the wrong
 *    people;
 *  - a page with parameters is mounted again when they change, so a half
 *    written comment never follows the user to another ticket;
 *  - the old addresses of the CMDB lead to the dynamic CI pages;
 *  - an unknown address says «Page not found», and a page that crashes says
 *    «Unexpected error» in place of the page, with the rest of the app intact.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { screen, waitFor, act, within } from '@testing-library/react'
import { ROUTE_PERMISSIONS } from '@/lib/routePermissions'

const pages = vi.hoisted(() => ({
  mounts: 0,
  broken: new Set<string>(),
  /** A module whose page (named and default export) shows its name, params and mount number. */
  make: (name: string) => async () => {
    const { createElement, useState } = await import('react')
    const { useParams } = await import('react-router-dom')
    function Page() {
      const params = useParams()
      const [mount] = useState(() => ++pages.mounts)
      if (pages.broken.has(name)) throw new Error(`${name} crashed`)
      return createElement('main', { 'data-page': name, 'data-params': JSON.stringify(params), 'data-mount': String(mount) }, name)
    }
    return { [name]: Page, default: Page }
  },
}))
const kc = vi.hoisted(() => ({ init: vi.fn(), login: vi.fn() }))
const refreshLoop = vi.hoisted(() => vi.fn())

vi.mock('@/lib/keycloak', () => ({ initKeycloak: kc.init, keycloak: { login: kc.login } }))
vi.mock('@/lib/tokenRefresh', () => ({ startTokenRefreshLoop: refreshLoop }))
vi.mock('@/lib/apollo', () => ({ apolloClient: { name: 'test client' } }))
vi.mock('@/components/ui/sonner', () => ({ Toaster: () => null }))
vi.mock('@/components/layout/AppLayout', async () => {
  const { createElement } = await import('react')
  const { Outlet } = await import('react-router-dom')
  return { AppLayout: () => createElement('div', { 'data-testid': 'layout' }, createElement(Outlet)) }
})
// The guard's own logic has its tests: here it shows WHICH permissions it was given.
vi.mock('@/components/RequirePermission', async () => {
  const { createElement } = await import('react')
  return {
    RequirePermission: ({ anyOf, children }: { anyOf: readonly string[]; children: unknown }) =>
      createElement('section', { 'data-guard': anyOf.join(',') }, children as never),
  }
})
vi.mock('@/contexts/MetamodelContext', () => ({ MetamodelProvider: ({ children }: { children: unknown }) => children }))
vi.mock('@/contexts/DomainVocabularyContext', () => ({ DomainVocabularyProvider: ({ children }: { children: unknown }) => children }))
vi.mock('@/contexts/RiskBandContext', () => ({ RiskBandProvider: ({ children }: { children: unknown }) => children }))
vi.mock('@/contexts/NotificationContext', () => ({ NotificationProvider: ({ children }: { children: unknown }) => children }))

vi.mock('@/pages/DashboardPage', pages.make('DashboardPage'))
vi.mock('@/pages/incidents/IncidentListPage', pages.make('IncidentListPage'))
vi.mock('@/pages/incidents/IncidentDetailPage', pages.make('IncidentDetailPage'))
vi.mock('@/pages/incidents/CreateIncidentPage', pages.make('CreateIncidentPage'))
vi.mock('@/pages/problems/ProblemListPage', pages.make('ProblemListPage'))
vi.mock('@/pages/problems/ProblemDetailPage', pages.make('ProblemDetailPage'))
vi.mock('@/pages/problems/CreateProblemPage', pages.make('CreateProblemPage'))
vi.mock('@/pages/changes/ChangeListPage', pages.make('ChangeListPage'))
vi.mock('@/pages/changes/CreateChangePage', pages.make('CreateChangePage'))
vi.mock('@/pages/changes/ChangeDetailPage', pages.make('ChangeDetailPage'))
vi.mock('@/pages/changes/ChangeCalendarPage', pages.make('ChangeCalendarPage'))
vi.mock('@/pages/tasks/TaskViewPage', pages.make('TaskViewPage'))
vi.mock('@/pages/MyTasksPage', pages.make('MyTasksPage'))
vi.mock('@/pages/admin/QuestionAdminPage', pages.make('QuestionAdminPage'))
vi.mock('@/pages/requests/RequestListPage', pages.make('RequestListPage'))
vi.mock('@/pages/requests/CreateServiceRequestPage', pages.make('CreateServiceRequestPage'))
vi.mock('@/pages/requests/ServiceRequestDetailPage', pages.make('ServiceRequestDetailPage'))
vi.mock('@/pages/cmdb/CMDBPage', pages.make('CMDBPage'))
vi.mock('@/pages/ci/CIListPage', pages.make('CIListPage'))
vi.mock('@/pages/ci/CIDetailPage', pages.make('CIDetailPage'))
vi.mock('@/pages/profile/ProfilePage', pages.make('ProfilePage'))
vi.mock('@/pages/ci/CIByIdRedirect', pages.make('CIByIdRedirect'))
vi.mock('@/pages/analysis/WhatIfPage', pages.make('WhatIfPage'))
vi.mock('@/pages/anomaly/AnomalyPage', pages.make('AnomalyPage'))
vi.mock('@/pages/proposals/ProposalsPage', pages.make('ProposalsPage'))
vi.mock('@/pages/proposals/DailyWorkPage', pages.make('DailyWorkPage'))
vi.mock('@/pages/anomaly/AnomalyRulesPage', pages.make('AnomalyRulesPage'))
vi.mock('@/pages/events/EventsPage', pages.make('EventsPage'))
vi.mock('@/pages/events/EventDetailPage', pages.make('EventDetailPage'))
vi.mock('@/pages/settings/EventPolicyPage', pages.make('EventPolicyPage'))
vi.mock('@/pages/monitoring/MonitoringSourcesPage', pages.make('MonitoringSourcesPage'))
vi.mock('@/pages/monitoring/CIHealthPage', pages.make('CIHealthPage'))
vi.mock('@/pages/monitoring/ServicesPage', pages.make('ServicesPage'))
vi.mock('@/pages/monitoring/ServiceDetailPage', pages.make('ServiceDetailPage'))
vi.mock('@/pages/monitoring/NewSourceWizard', pages.make('NewSourceWizard'))
vi.mock('@/pages/monitoring/EditSourcePage', pages.make('EditSourcePage'))
vi.mock('@/pages/topology/TopologyPage', pages.make('TopologyPage'))
vi.mock('@/pages/workflow/WorkflowListPage', pages.make('WorkflowListPage'))
vi.mock('@/pages/workflow/WorkflowDesignerPage', pages.make('WorkflowDesignerPage'))
vi.mock('@/pages/settings/NotificationsPage', pages.make('NotificationsPage'))
vi.mock('@/pages/settings/NotificationRulesPage', pages.make('NotificationRulesPage'))
vi.mock('@/pages/settings/CITypeDesignerPage', pages.make('CITypeDesignerPage'))
vi.mock('@/pages/settings/ITILTypeDesignerPage', pages.make('ITILTypeDesignerPage'))
vi.mock('@/pages/settings/CatalogFormsPage', pages.make('CatalogFormsPage'))
vi.mock('@/pages/settings/EnumDesignerPage.js', pages.make('EnumDesignerPage'))
vi.mock('@/pages/settings/ConfigurationDiagnosticsPage', pages.make('ConfigurationDiagnosticsPage'))
vi.mock('@/pages/settings/OrganizationPage', pages.make('OrganizationPage'))
vi.mock('@/pages/settings/DomainMatricesPage', pages.make('DomainMatricesPage'))
vi.mock('@/pages/settings/SyncPage', pages.make('SyncPage'))
vi.mock('@/pages/reports/ReportsPage', pages.make('ReportsPage'))
vi.mock('@/pages/reports/CustomReportsPage', pages.make('CustomReportsPage'))
vi.mock('@/pages/teams/TeamsPage', pages.make('TeamsPage'))
vi.mock('@/pages/teams/TeamDetailPage', pages.make('TeamDetailPage'))
vi.mock('@/pages/users/UsersPage', pages.make('UsersPage'))
vi.mock('@/pages/users/UserDetailPage', pages.make('UserDetailPage'))
vi.mock('@/pages/logs/LogsPage', pages.make('LogsPage'))
vi.mock('@/pages/admin/QueueStatsPage', pages.make('QueueStatsPage'))
vi.mock('@/pages/admin/AuditLogPage', pages.make('AuditLogPage'))
vi.mock('@/pages/admin/MonitoringPage', pages.make('MonitoringPage'))
vi.mock('@/pages/approvals/ApprovalsPage', pages.make('ApprovalsPage'))
vi.mock('@/pages/knowledge-base/KnowledgeBasePage', pages.make('KnowledgeBasePage'))
vi.mock('@/pages/assistant/AssistantPage', pages.make('AssistantPage'))
vi.mock('@/pages/knowledge-base/KBArticlePage', pages.make('KBArticlePage'))
vi.mock('@/pages/knowledge-base/KBArticleByIdRedirect', pages.make('KBArticleByIdRedirect'))
vi.mock('@/pages/admin/KBAdminPage', pages.make('KBAdminPage'))
vi.mock('@/pages/admin/AutoTriggersPage', pages.make('AutoTriggersPage'))
vi.mock('@/pages/admin/BusinessRulesPage', pages.make('BusinessRulesPage'))
vi.mock('@/pages/admin/SLAPoliciesPage', pages.make('SLAPoliciesPage'))
vi.mock('@/pages/admin/OLAContractsPage', pages.make('OLAContractsPage'))
vi.mock('@/pages/admin/ServiceCatalogAdminPage', pages.make('ServiceCatalogAdminPage'))
vi.mock('@/pages/reports/SLAReportPage', pages.make('SLAReportPage'))
vi.mock('@/pages/reports/OLAReportPage', pages.make('OLAReportPage'))
vi.mock('@/pages/admin/IntegrationsPage', pages.make('IntegrationsPage'))
vi.mock('@/pages/security/LoginSecurityPage', pages.make('LoginSecurityPage'))
vi.mock('@/pages/roles/RolesPage', pages.make('RolesPage'))
vi.mock('@/pages/roles/RoleEditorPage', pages.make('RoleEditorPage'))

/** A fresh `#root`, as `index.html` provides it; the previous one (if any) goes. */
function freshRoot(): HTMLElement {
  document.getElementById('root')?.remove()
  const root = document.createElement('div')
  root.id = 'root'
  document.body.appendChild(root)
  return root
}

/** Navigate as the browser's back/forward buttons do: change the address, then `popstate`. */
async function go(url: string) {
  await act(async () => {
    window.history.pushState({}, '', url)
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
}

const shownPage = () => document.querySelector<HTMLElement>('#root [data-page]')
const path = () => window.location.pathname

async function opens(url: string, page: string) {
  await go(url)
  await waitFor(() => expect(shownPage()?.dataset['page']).toBe(page))
  return shownPage()!
}

describe('signed in', () => {
  // What happened while the app started (the config's `restoreMocks` clears call records before each test).
  const atStartup = { refreshLoops: 0, logins: 0 }

  beforeAll(async () => {
    window.history.replaceState({}, '', '/')
    freshRoot()
    kc.init.mockResolvedValue(true)
    await act(async () => { await import('./main') })
    await waitFor(() => expect(shownPage()).not.toBeNull())
    atStartup.refreshLoops = refreshLoop.mock.calls.length
    atStartup.logins = kc.login.mock.calls.length
  })

  afterEach(() => { pages.broken.clear(); vi.restoreAllMocks() })

  it('starts the token refresh, does not ask for a login, and opens the dashboard behind its guard', () => {
    expect(atStartup).toEqual({ refreshLoops: 1, logins: 0 })
    expect(screen.getByTestId('layout')).toBeInTheDocument()
    const page = shownPage()!
    expect(page.dataset['page']).toBe('DashboardPage')
    expect(page.closest<HTMLElement>('[data-guard]')!.dataset['guard']).toBe('dashboard.use')
  })

  // [address, route pattern of the permission row, page]
  const ROUTES: Array<[string, string, string]> = [
    ['/dashboard', 'dashboard', 'DashboardPage'],
    ['/incidents', 'incidents', 'IncidentListPage'],
    ['/incidents/new', 'incidents/new', 'CreateIncidentPage'],
    ['/incidents/7', 'incidents/:id', 'IncidentDetailPage'],
    ['/problems', 'problems', 'ProblemListPage'],
    ['/problems/new', 'problems/new', 'CreateProblemPage'],
    ['/problems/7', 'problems/:id', 'ProblemDetailPage'],
    ['/changes', 'changes', 'ChangeListPage'],
    ['/changes/new', 'changes/new', 'CreateChangePage'],
    ['/changes/calendar', 'changes/calendar', 'ChangeCalendarPage'],
    ['/changes/7', 'changes/:id', 'ChangeDetailPage'],
    ['/tasks/7', 'tasks/:taskId', 'TaskViewPage'],
    ['/my-tasks', 'my-tasks', 'MyTasksPage'],
    ['/requests', 'requests', 'RequestListPage'],
    ['/requests/new', 'requests/new', 'CreateServiceRequestPage'],
    ['/requests/7', 'requests/:id', 'ServiceRequestDetailPage'],
    ['/cmdb', 'cmdb', 'CMDBPage'],
    ['/ci/server', 'ci/:typeName', 'CIListPage'],
    ['/ci/server/7', 'ci/:typeName/:id', 'CIDetailPage'],
    ['/cis/7', 'cis/:id', 'CIByIdRedirect'],
    ['/analysis/what-if', 'analysis/what-if', 'WhatIfPage'],
    ['/anomalies', 'anomalies', 'AnomalyPage'],
    ['/proposals', 'proposals', 'ProposalsPage'],
    ['/analysis/daily-work', 'analysis/daily-work', 'DailyWorkPage'],
    ['/events', 'events', 'EventsPage'],
    ['/events/7', 'events/:id', 'EventDetailPage'],
    ['/monitoring/health', 'monitoring/health', 'CIHealthPage'],
    ['/monitoring/services', 'monitoring/services', 'ServicesPage'],
    ['/monitoring/services/7', 'monitoring/services/:id', 'ServiceDetailPage'],
    ['/monitoring/sources', 'monitoring/sources', 'MonitoringSourcesPage'],
    ['/monitoring/sources/new', 'monitoring/sources/new', 'NewSourceWizard'],
    ['/monitoring/sources/7', 'monitoring/sources/:id', 'EditSourcePage'],
    ['/topology', 'topology', 'TopologyPage'],
    ['/workflow', 'workflow', 'WorkflowListPage'],
    ['/workflow/7', 'workflow/:id', 'WorkflowDesignerPage'],
    ['/settings/notifications', 'settings/notifications', 'NotificationsPage'],
    ['/settings/notification-rules', 'settings/notification-rules', 'NotificationRulesPage'],
    ['/profile', 'profile', 'ProfilePage'],
    ['/settings/diagnostics', 'settings/diagnostics', 'ConfigurationDiagnosticsPage'],
    ['/settings/organization', 'settings/organization', 'OrganizationPage'],
    ['/settings/ci-types', 'settings/ci-types', 'CITypeDesignerPage'],
    ['/settings/itil-designer', 'settings/itil-designer', 'ITILTypeDesignerPage'],
    ['/settings/catalog-forms', 'settings/catalog-forms', 'CatalogFormsPage'],
    ['/settings/enum-designer', 'settings/enum-designer', 'EnumDesignerPage'],
    ['/settings/domain-matrices', 'settings/domain-matrices', 'DomainMatricesPage'],
    ['/settings/anomaly-rules', 'settings/anomaly-rules', 'AnomalyRulesPage'],
    ['/settings/sync', 'settings/sync', 'SyncPage'],
    ['/settings/event-policy', 'settings/event-policy', 'EventPolicyPage'],
    ['/reports', 'reports', 'ReportsPage'],
    ['/custom-reports', 'custom-reports', 'CustomReportsPage'],
    ['/teams', 'teams', 'TeamsPage'],
    ['/teams/7', 'teams/:id', 'TeamDetailPage'],
    ['/users', 'users', 'UsersPage'],
    ['/users/7', 'users/:id', 'UserDetailPage'],
    ['/roles', 'roles', 'RolesPage'],
    ['/roles/new', 'roles/new', 'RoleEditorPage'],
    ['/roles/auditor', 'roles/:key', 'RoleEditorPage'],
    ['/security/login', 'security/login', 'LoginSecurityPage'],
    ['/logs', 'logs', 'LogsPage'],
    ['/admin/queues', 'admin/queues', 'QueueStatsPage'],
    ['/admin/audit', 'admin/audit', 'AuditLogPage'],
    ['/admin/monitoring', 'admin/monitoring', 'MonitoringPage'],
    ['/admin/knowledge-base', 'admin/knowledge-base', 'KBAdminPage'],
    ['/admin/triggers', 'admin/triggers', 'AutoTriggersPage'],
    ['/admin/business-rules', 'admin/business-rules', 'BusinessRulesPage'],
    ['/admin/sla-policies', 'admin/sla-policies', 'SLAPoliciesPage'],
    ['/admin/ola-uc', 'admin/ola-uc', 'OLAContractsPage'],
    ['/admin/service-catalog', 'admin/service-catalog', 'ServiceCatalogAdminPage'],
    ['/reports/sla', 'reports/sla', 'SLAReportPage'],
    ['/reports/ola-uc', 'reports/ola-uc', 'OLAReportPage'],
    ['/admin/integrations', 'admin/integrations', 'IntegrationsPage'],
    ['/admin/assessment-questions', 'admin/assessment-questions', 'QuestionAdminPage'],
    ['/approvals', 'approvals', 'ApprovalsPage'],
    ['/knowledge-base', 'knowledge-base', 'KnowledgeBasePage'],
    ['/assistant', 'assistant', 'AssistantPage'],
    ['/knowledge-base/vpn-guide', 'knowledge-base/:slug', 'KBArticlePage'],
    ['/kb-articles/7', 'kb-articles/:id', 'KBArticleByIdRedirect'],
  ]

  it.each(ROUTES)('%s opens %s\'s page (%s), behind the permissions of its own row', async (url, pattern, page) => {
    const shown = await opens(url, page)
    expect(shown.closest<HTMLElement>('[data-guard]')!.dataset['guard']).toBe(ROUTE_PERMISSIONS[pattern]!.join(','))
    expect(path()).toBe(url)
  })

  it('a page is given the parameters of its address', async () => {
    expect(JSON.parse((await opens('/ci/database_instance/42', 'CIDetailPage')).dataset['params']!)).toEqual({ typeName: 'database_instance', id: '42' })
    expect(JSON.parse((await opens('/knowledge-base/vpn-guide', 'KBArticlePage')).dataset['params']!)).toEqual({ slug: 'vpn-guide' })
  })

  it('a page is mounted again when its parameters change, and kept when only the query changes', async () => {
    const first = (await opens('/incidents/7', 'IncidentDetailPage')).dataset['mount']
    await go('/incidents/7?tab=history')
    await waitFor(() => expect(path()).toBe('/incidents/7'))
    expect(shownPage()!.dataset['mount']).toBe(first)
    await go('/incidents/8')
    await waitFor(() => expect(JSON.parse(shownPage()!.dataset['params']!)).toEqual({ id: '8' }))
    expect(shownPage()!.dataset['mount']).not.toBe(first)
  })

  it.each([
    ['/applications', '/ci/application'], ['/databases', '/ci/database'], ['/database-instances', '/ci/database_instance'],
    ['/servers', '/ci/server'], ['/certificates', '/ci/certificate'],
  ])('the old address %s leads to the list %s', async (oldUrl, newUrl) => {
    await opens(oldUrl, 'CIListPage')
    expect(path()).toBe(newUrl)
  })

  it.each([
    ['/applications/7', 'application'], ['/databases/7', 'database'], ['/database-instances/7', 'database_instance'],
    ['/servers/7', 'server'], ['/certificates/7', 'certificate'],
  ])('the old address %s leads to the CI page of a %s', async (oldUrl, typeName) => {
    const page = await opens(oldUrl, 'CIDetailPage')
    expect(JSON.parse(page.dataset['params']!)).toEqual({ typeName, id: '7' })
    expect(path()).toBe(`/ci/${typeName}/7`)
  })

  it('the old personal settings address leads to the profile (E-13)', async () => {
    await opens('/settings/profile', 'ProfilePage')
    expect(path()).toBe('/profile')
  })

  it('an unknown address says «Page not found», with the way back to the dashboard', async () => {
    await go('/no-such-page')
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument()
    expect(screen.getByText('Not Found')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to Dashboard' })).toHaveAttribute('href', '/dashboard')
  })

  it('a page that crashes is replaced by «Unexpected error», and the rest of the app stays', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    pages.broken.add('LogsPage')
    await go('/logs')
    const heading = await screen.findByRole('heading', { name: 'Unexpected error' })
    expect(within(heading.parentElement!).getByText('Something went wrong')).toBeInTheDocument()
    expect(screen.getByTestId('layout')).toContainElement(heading)
  })
})

describe('before the app: signing in', () => {
  it('without a session it sends the person to the login and mounts nothing', async () => {
    vi.resetModules()
    const root = freshRoot()
    kc.init.mockResolvedValueOnce(false)
    refreshLoop.mockClear()
    await act(async () => { await import('./main') })
    await waitFor(() => expect(kc.login).toHaveBeenCalledTimes(1))
    expect(refreshLoop).not.toHaveBeenCalled()
    expect(root).toBeEmptyDOMElement()
  })

  it('when sign-in cannot start it says why on the page, as text and never as markup (F-19)', async () => {
    vi.resetModules()
    const root = freshRoot()
    kc.init.mockRejectedValueOnce(new Error('No tenant in the subdomain ("<img src=x onerror=alert(1)>")'))
    await act(async () => { await import('./main') })
    await waitFor(() => expect(root).toHaveTextContent('Authentication error'))
    expect(root).toHaveTextContent('No tenant in the subdomain ("<img src=x onerror=alert(1)>")')
    expect(root.querySelector('img')).toBeNull()
  })
})
