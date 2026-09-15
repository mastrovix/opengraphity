import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import { ApolloProvider } from '@apollo/client/react'
import { createBrowserRouter, RouterProvider, useRouteError, Navigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Toaster } from '@/components/ui/sonner'
import { apolloClient } from '@/lib/apollo'
import { AppLayout } from '@/components/layout/AppLayout'
import { DashboardPage } from '@/pages/DashboardPage'
import { IncidentListPage } from '@/pages/incidents/IncidentListPage'
import { IncidentDetailPage } from '@/pages/incidents/IncidentDetailPage'
import { CreateIncidentPage } from '@/pages/incidents/CreateIncidentPage'
import { ProblemListPage } from '@/pages/problems/ProblemListPage'
import { ProblemDetailPage } from '@/pages/problems/ProblemDetailPage'
import { CreateProblemPage } from '@/pages/problems/CreateProblemPage'
import { ChangeListPage } from '@/pages/changes/ChangeListPage'
import { CreateChangePage } from '@/pages/changes/CreateChangePage'
import { ChangeDetailPage } from '@/pages/changes/ChangeDetailPage'
import { TaskViewPage } from '@/pages/tasks/TaskViewPage'
import { MyTasksPage } from '@/pages/MyTasksPage'
import { QuestionAdminPage } from '@/pages/admin/QuestionAdminPage'
import { RequestListPage } from '@/pages/requests/RequestListPage'
import { CreateServiceRequestPage } from '@/pages/requests/CreateServiceRequestPage'
import { ServiceRequestDetailPage } from '@/pages/requests/ServiceRequestDetailPage'
import { CMDBPage } from '@/pages/cmdb/CMDBPage'
import { CIListPage } from '@/pages/ci/CIListPage'
import { CIDetailPage } from '@/pages/ci/CIDetailPage'
import { ProfilePage as UserProfilePage } from '@/pages/profile/ProfilePage'
function CIDetailRedirect({ typeName }: { typeName: string }) {
  const { id } = useParams<{ id: string }>()
  return <Navigate to={`/ci/${typeName}/${id}`} replace />
}
// /cis/:id (link delle notifiche senza il tipo) → /ci/:typeName/:id.
import { CIByIdRedirect } from '@/pages/ci/CIByIdRedirect'
const WhatIfPage = lazy(() => import('@/pages/analysis/WhatIfPage').then(m => ({ default: m.WhatIfPage })))
import { AnomalyPage } from '@/pages/anomaly/AnomalyPage'
import { AnomalyRulesPage } from '@/pages/anomaly/AnomalyRulesPage'
import { EventsPage } from '@/pages/events/EventsPage'
import { EventDetailPage } from '@/pages/events/EventDetailPage'
import { EventPolicyPage } from '@/pages/settings/EventPolicyPage'
import { MonitoringSourcesPage } from '@/pages/monitoring/MonitoringSourcesPage'
import { CIHealthPage } from '@/pages/monitoring/CIHealthPage'
import { ServicesPage } from '@/pages/monitoring/ServicesPage'
import { ServiceDetailPage } from '@/pages/monitoring/ServiceDetailPage'
import { NewSourceWizard } from '@/pages/monitoring/NewSourceWizard'
import { EditSourcePage } from '@/pages/monitoring/EditSourcePage'
const TopologyPage = lazy(() => import('@/pages/topology/TopologyPage').then(m => ({ default: m.TopologyPage })))
import { WorkflowListPage }     from '@/pages/workflow/WorkflowListPage'
const WorkflowDesignerPage = lazy(() => import('@/pages/workflow/WorkflowDesignerPage').then(m => ({ default: m.WorkflowDesignerPage })))
import NotificationsPage from '@/pages/settings/NotificationsPage'
import NotificationRulesPage from '@/pages/settings/NotificationRulesPage'
import { CITypeDesignerPage } from '@/pages/settings/CITypeDesignerPage'
import { ITILTypeDesignerPage } from '@/pages/settings/ITILTypeDesignerPage'
import { EnumDesignerPage }     from '@/pages/settings/EnumDesignerPage.js'
import { OrganizationPage }     from '@/pages/settings/OrganizationPage'
import { DomainMatricesPage }   from '@/pages/settings/DomainMatricesPage'
import { SyncPage }             from '@/pages/settings/SyncPage'
const ReportsPage = lazy(() => import('@/pages/reports/ReportsPage'))
const CustomReportsPage = lazy(() => import('@/pages/reports/CustomReportsPage').then(m => ({ default: m.CustomReportsPage })))
import { TeamsPage } from '@/pages/teams/TeamsPage'
import { TeamDetailPage } from '@/pages/teams/TeamDetailPage'
import { UsersPage } from '@/pages/users/UsersPage'
import { UserDetailPage } from '@/pages/users/UserDetailPage'
import { LogsPage } from '@/pages/logs/LogsPage'
import { QueueStatsPage } from '@/pages/admin/QueueStatsPage'
import { AuditLogPage } from '@/pages/admin/AuditLogPage'
const MonitoringPage = lazy(() => import('@/pages/admin/MonitoringPage').then(m => ({ default: m.MonitoringPage })))
import { ApprovalsPage } from '@/pages/approvals/ApprovalsPage'
import { KnowledgeBasePage } from '@/pages/knowledge-base/KnowledgeBasePage'
import { AssistantPage } from '@/pages/assistant/AssistantPage'
import { KBArticlePage } from '@/pages/knowledge-base/KBArticlePage'
import { KBAdminPage } from '@/pages/admin/KBAdminPage'
import { AutoTriggersPage } from '@/pages/admin/AutoTriggersPage'
import { BusinessRulesPage } from '@/pages/admin/BusinessRulesPage'
import { SLAPoliciesPage } from '@/pages/admin/SLAPoliciesPage'
import { OLAContractsPage } from '@/pages/admin/OLAContractsPage'
import { ServiceCatalogAdminPage } from '@/pages/admin/ServiceCatalogAdminPage'
const SLAReportPage = lazy(() => import('@/pages/reports/SLAReportPage').then(m => ({ default: m.SLAReportPage })))
const OLAReportPage = lazy(() => import('@/pages/reports/OLAReportPage').then(m => ({ default: m.OLAReportPage })))
import { IntegrationsPage } from '@/pages/admin/IntegrationsPage'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { PageLoader } from '@/components/PageLoader'
import { LoginSecurityPage } from '@/pages/security/LoginSecurityPage'
import { RolesPage } from '@/pages/roles/RolesPage'
import { RoleEditorPage } from '@/pages/roles/RoleEditorPage'
import { RequirePermission } from '@/components/RequirePermission'
import { routePermissions } from '@/lib/routePermissions'
import { MetamodelProvider } from '@/contexts/MetamodelContext'
import { DomainVocabularyProvider } from '@/contexts/DomainVocabularyContext'
import { RiskBandProvider } from '@/contexts/RiskBandContext'
import { NotificationProvider } from '@/contexts/NotificationContext'
import { initKeycloak, keycloak } from '@/lib/keycloak'
import { startTokenRefreshLoop } from '@/lib/tokenRefresh'
import '@/index.css'
import '@xyflow/react/dist/style.css'
import i18n from '@/i18n/i18n'

function RouteError() {
  const error = useRouteError() as { status?: number; statusText?: string }
  const { t } = useTranslation()
  return (
    <div style={{
      display:        'flex',
      flexDirection:  'column',
      alignItems:     'center',
      justifyContent: 'center',
      height:         '100vh',
      gap:            16,
      background:     'var(--color-slate-bg)',
    }}>
      <div style={{ fontSize: 48 }} aria-hidden="true">⚠️</div>
      <h1 style={{ fontSize: 'var(--font-size-page-title)', fontWeight: 600, color: 'var(--color-slate-dark)', margin: 0 }}>
        {error?.status === 404 ? t('routeError.notFound') : t('routeError.unexpected')}
      </h1>
      <p style={{ color: 'var(--color-slate-light)', margin: 0 }}>
        {error?.statusText ?? t('routeError.generic')}
      </p>
      <a href="/dashboard" style={{ color: 'var(--color-brand)', textDecoration: 'none', fontSize: 'var(--font-size-body)' }}>
        {t('routeError.backToDashboard')}
      </a>
    </div>
  )
}

// Ogni pagina con parametri di route è keyata su TUTTI i suoi params (:id,
// :taskId, :typeName/:id, :slug…): navigando entità → entità (link "Ticket
// collegati", relazioni CI, ecc.) il componente viene rimontato, così lo stato
// locale (commento a metà, form aperto, edit mode) non migra su un'altra entità.
function Keyed({ Page }: { Page: React.ComponentType }) {
  const params = useParams()
  return <Page key={JSON.stringify(params)} />
}

// Guardia di ogni pagina (ondata 7 di «Nulla cablato»): i PERMESSI del ruolo
// di `me` (DB), letti dalla tabella unica `lib/routePermissions`, la stessa
// che usa la barra laterale. Prima erano liste di nomi di ruolo (E-01).
function guarded(path: string, element: React.ReactElement) {
  return { path, element: <RequirePermission anyOf={routePermissions(path)}>{element}</RequirePermission>, errorElement: <RouteError /> }
}

const router = createBrowserRouter([
  {
    path:         '/',
    element:      <AppLayout />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <RequirePermission anyOf={routePermissions('')}><DashboardPage /></RequirePermission>, errorElement: <RouteError /> },
      guarded('dashboard', <DashboardPage />),
      guarded('incidents', <IncidentListPage />),
      guarded('incidents/new', <CreateIncidentPage />),
      guarded('incidents/:id', <Keyed Page={IncidentDetailPage} />),
      guarded('problems', <ProblemListPage />),
      guarded('problems/new', <CreateProblemPage />),
      guarded('problems/:id', <Keyed Page={ProblemDetailPage} />),
      guarded('changes', <ChangeListPage />),
      guarded('changes/new', <CreateChangePage />),
      guarded('changes/:id', <Keyed Page={ChangeDetailPage} />),
      guarded('tasks/:taskId', <Keyed Page={TaskViewPage} />),
      guarded('my-tasks', <MyTasksPage />),
      guarded('requests', <RequestListPage />),
      guarded('requests/new', <CreateServiceRequestPage />),
      guarded('requests/:id', <Keyed Page={ServiceRequestDetailPage} />),
      guarded('cmdb', <CMDBPage />),
      // Dynamic CI routes
      guarded('ci/:typeName', <CIListPage />),
      guarded('ci/:typeName/:id', <Keyed Page={CIDetailPage} />),
      guarded('cis/:id', <Keyed Page={CIByIdRedirect} />),
      // Backward-compat redirects
      { path: 'applications',                  element: <Navigate to="/ci/application" replace /> },
      { path: 'applications/:id',              element: <CIDetailRedirect typeName="application" /> },
      { path: 'databases',                     element: <Navigate to="/ci/database" replace /> },
      { path: 'databases/:id',                 element: <CIDetailRedirect typeName="database" /> },
      { path: 'database-instances',            element: <Navigate to="/ci/database_instance" replace /> },
      { path: 'database-instances/:id',        element: <CIDetailRedirect typeName="database_instance" /> },
      { path: 'servers',                       element: <Navigate to="/ci/server" replace /> },
      { path: 'servers/:id',                   element: <CIDetailRedirect typeName="server" /> },
      { path: 'certificates',                  element: <Navigate to="/ci/certificate" replace /> },
      { path: 'certificates/:id',              element: <CIDetailRedirect typeName="certificate" /> },
      guarded('analysis/what-if', <Suspense fallback={<PageLoader />}><WhatIfPage /></Suspense>),
      guarded('anomalies', <AnomalyPage />),
      // Event Management (console allarmi): le azioni si vedono con event.work.
      guarded('events', <EventsPage />),
      guarded('events/:id', <Keyed Page={EventDetailPage} />),
      // Salute dei CI: il CTA "Aggiungi sorgente" si vede con config.monitoring.
      guarded('monitoring/health', <CIHealthPage />),
      // Servizi monitorati: le azioni (crea, pausa, elimina) si vedono con config.services, la rivalutazione con service.reevaluate.
      guarded('monitoring/services', <ServicesPage />),
      guarded('monitoring/services/:id', <Keyed Page={ServiceDetailPage} />),
      // Sorgenti di monitoraggio (webhook in ingresso con entityType = event).
      guarded('monitoring/sources', <MonitoringSourcesPage />),
      guarded('monitoring/sources/new', <NewSourceWizard />),
      guarded('monitoring/sources/:id', <Keyed Page={EditSourcePage} />),
      guarded('topology', <Suspense fallback={<PageLoader />}><TopologyPage /></Suspense>),
      // Workflow designer (list + editor)
      guarded('workflow', <WorkflowListPage />),
      guarded('workflow/:id', <Suspense fallback={<PageLoader />}><Keyed Page={WorkflowDesignerPage} /></Suspense>),
      // Tenant-wide settings (channels, rules, metamodel designers, sync).
      // The personal page (`profile`: language + Slack) stays open to the whole workspace;
      // the old `settings/profile` URL redirects there (E-13).
      guarded('settings/notifications', <NotificationsPage />),
      guarded('settings/notification-rules', <NotificationRulesPage />),
      { path: 'settings/profile',          element: <Navigate to="/profile" replace /> },
      guarded('profile', <UserProfilePage />),
      // Organizzazione: le scelte che valgono per tutti (la lingua predefinita
      // dell'azienda, che era una costante nel codice). La lingua di una
      // PERSONA sta nel Profilo, aperto a ogni ruolo.
      guarded('settings/organization', <OrganizationPage />),
      guarded('settings/ci-types', <CITypeDesignerPage />),
      guarded('settings/itil-designer', <ITILTypeDesignerPage />),
      guarded('settings/enum-designer', <EnumDesignerPage />),
      guarded('settings/domain-matrices', <DomainMatricesPage />),
      guarded('settings/anomaly-rules', <AnomalyRulesPage />),
      guarded('settings/sync', <SyncPage />),
      guarded('settings/event-policy', <EventPolicyPage />),
      guarded('reports', <Suspense fallback={<PageLoader />}><ReportsPage /></Suspense>),
      guarded('custom-reports', <Suspense fallback={<PageLoader />}><CustomReportsPage /></Suspense>),
      // Teams & users: both pages carry admin.users mutations (createTeam,
      // setTeamManager, createUser, updateUserTeams) → whole page admin.users.
      guarded('teams', <TeamsPage />),
      guarded('teams/:id', <Keyed Page={TeamDetailPage} />),
      guarded('users', <UsersPage />),
      guarded('users/:id', <Keyed Page={UserDetailPage} />),
      // Ruoli e permessi (ondata 7 di «Nulla cablato»)
      guarded('roles', <RolesPage />),
      guarded('roles/new', <RoleEditorPage />),
      guarded('roles/:key', <Keyed Page={RoleEditorPage} />),
      // Accesso e password dell'organizzazione (ondata 8)
      guarded('security/login', <LoginSecurityPage />),
      guarded('logs', <LogsPage />),
      guarded('admin/queues', <QueueStatsPage />),
      guarded('admin/audit', <AuditLogPage />),
      guarded('admin/monitoring', <Suspense fallback={<PageLoader />}><MonitoringPage /></Suspense>),
      // kb.write, come l'API (createKBArticle/updateKBArticle): la guardia della
      // pagina era più stretta e gli operatori non potevano scrivere articoli (#45).
      guarded('admin/knowledge-base', <KBAdminPage />),
      guarded('admin/triggers', <AutoTriggersPage />),
      guarded('admin/business-rules', <BusinessRulesPage />),
      guarded('admin/sla-policies', <SLAPoliciesPage />),
      guarded('admin/ola-uc', <OLAContractsPage />),
      guarded('admin/service-catalog', <ServiceCatalogAdminPage />),
      guarded('reports/sla', <Suspense fallback={<PageLoader />}><SLAReportPage /></Suspense>),
      guarded('reports/ola-uc', <Suspense fallback={<PageLoader />}><OLAReportPage /></Suspense>),
      guarded('admin/integrations', <IntegrationsPage />),
      guarded('admin/assessment-questions', <QuestionAdminPage />),
      guarded('approvals', <ApprovalsPage />),
      guarded('knowledge-base', <KnowledgeBasePage />),
      guarded('assistant', <AssistantPage />),
      guarded('knowledge-base/:slug', <Keyed Page={KBArticlePage} />),
    ],
  },
])

const root = document.getElementById('root')!

initKeycloak().then((authenticated) => {
  if (!authenticated) {
    keycloak.login()
    return
  }

  // Keep the token fresh: onTokenExpired + 30s safety interval. A network
  // blip towards Keycloak retries with backoff (toast), only an invalid
  // session redirects to login (E-05).
  startTokenRefreshLoop()

  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary>
        <ApolloProvider client={apolloClient}>
          <MetamodelProvider>
            {/* Ondata 7 · D-15: i vocabolari del cliente, UNA query, per le palette per valore. */}
            <DomainVocabularyProvider>
              {/* Le fasce di rischio del cliente (soglie da Matrici di dominio), UNA query, per i badge del rischio. */}
              <RiskBandProvider>
                <NotificationProvider>
                  <RouterProvider router={router} />
                  <Toaster richColors position="top-right" />
                </NotificationProvider>
              </RiskBandProvider>
            </DomainVocabularyProvider>
          </MetamodelProvider>
        </ApolloProvider>
      </ErrorBoundary>
    </StrictMode>,
  )
}).catch((err: Error) => {
  // initKeycloak throws for: no tenant in subdomain, missing VITE_KEYCLOAK_URL,
  // unknown realm, Keycloak unreachable. Without this the user sees a blank page.
  root.innerHTML = `<div style="display:flex;height:100vh;align-items:center;justify-content:center;flex-direction:column;gap:12px;font-family:system-ui">
    <div style="font-size:20px;font-weight:600;color:var(--color-danger)">${i18n.t('auth.error')}</div>
    <div style="color:var(--color-slate);font-size:14px">${err.message}</div>
  </div>`
})
