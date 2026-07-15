import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import { ApolloProvider } from '@apollo/client/react'
import { createBrowserRouter, RouterProvider, useRouteError, Navigate, useParams } from 'react-router-dom'
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
const WhatIfPage = lazy(() => import('@/pages/analysis/WhatIfPage').then(m => ({ default: m.WhatIfPage })))
import { AnomalyPage } from '@/pages/anomaly/AnomalyPage'
const TopologyPage = lazy(() => import('@/pages/topology/TopologyPage').then(m => ({ default: m.TopologyPage })))
import { WorkflowListPage }     from '@/pages/workflow/WorkflowListPage'
const WorkflowDesignerPage = lazy(() => import('@/pages/workflow/WorkflowDesignerPage').then(m => ({ default: m.WorkflowDesignerPage })))
import NotificationsPage from '@/pages/settings/NotificationsPage'
import NotificationRulesPage from '@/pages/settings/NotificationRulesPage'
import ProfilePage from '@/pages/settings/ProfilePage'
import { CITypeDesignerPage } from '@/pages/settings/CITypeDesignerPage'
import { ITILTypeDesignerPage } from '@/pages/settings/ITILTypeDesignerPage'
import { EnumDesignerPage }     from '@/pages/settings/EnumDesignerPage.js'
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
import { KBArticlePage } from '@/pages/knowledge-base/KBArticlePage'
import { KBAdminPage } from '@/pages/admin/KBAdminPage'
import { AutoTriggersPage } from '@/pages/admin/AutoTriggersPage'
import { BusinessRulesPage } from '@/pages/admin/BusinessRulesPage'
import { SLAPoliciesPage } from '@/pages/admin/SLAPoliciesPage'
import { IntegrationsPage } from '@/pages/admin/IntegrationsPage'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { MetamodelProvider } from '@/contexts/MetamodelContext'
import { NotificationProvider } from '@/contexts/NotificationContext'
import { initKeycloak, keycloak } from '@/lib/keycloak'
import '@/index.css'
import '@xyflow/react/dist/style.css'
import '@/i18n/i18n'

/** Fallback shown while a lazy route chunk downloads. */
function PageLoader() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh', color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)' }}>
      Caricamento…
    </div>
  )
}

function RouteError() {
  const error = useRouteError() as { status?: number; statusText?: string }
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
      <div style={{ fontSize: 48 }}>⚠️</div>
      <h1 style={{ fontSize: 'var(--font-size-page-title)', fontWeight: 600, color: 'var(--color-slate-dark)', margin: 0 }}>
        {error?.status === 404 ? 'Page not found' : 'Unexpected error'}
      </h1>
      <p style={{ color: 'var(--color-slate-light)', margin: 0 }}>
        {error?.statusText ?? 'Something went wrong'}
      </p>
      <a href="/dashboard" style={{ color: 'var(--color-brand)', textDecoration: 'none', fontSize: 'var(--font-size-body)' }}>
        Back to Dashboard
      </a>
    </div>
  )
}

const router = createBrowserRouter([
  {
    path:         '/',
    element:      <AppLayout />,
    errorElement: <RouteError />,
    children: [
      { index: true,               element: <DashboardPage />,           errorElement: <RouteError /> },
      { path: 'dashboard',         element: <DashboardPage />,           errorElement: <RouteError /> },
      { path: 'incidents',         element: <IncidentListPage />,        errorElement: <RouteError /> },
      { path: 'incidents/new',     element: <CreateIncidentPage />,      errorElement: <RouteError /> },
      { path: 'incidents/:id',     element: <IncidentDetailPage />,      errorElement: <RouteError /> },
      { path: 'problems',          element: <ProblemListPage />,         errorElement: <RouteError /> },
      { path: 'problems/new',      element: <CreateProblemPage />,       errorElement: <RouteError /> },
      { path: 'problems/:id',      element: <ProblemDetailPage />,       errorElement: <RouteError /> },
      { path: 'changes',           element: <ChangeListPage />,          errorElement: <RouteError /> },
      { path: 'changes/new',       element: <CreateChangePage />,        errorElement: <RouteError /> },
      { path: 'changes/:id',       element: <ChangeDetailPage />,        errorElement: <RouteError /> },
      { path: 'tasks/:taskId',     element: <TaskViewPage />,            errorElement: <RouteError /> },
      { path: 'my-tasks',          element: <MyTasksPage />,             errorElement: <RouteError /> },
      { path: 'requests',          element: <RequestListPage />,         errorElement: <RouteError /> },
      { path: 'requests/new',      element: <CreateServiceRequestPage />,errorElement: <RouteError /> },
      { path: 'requests/:id',      element: <ServiceRequestDetailPage />,errorElement: <RouteError /> },
      { path: 'cmdb',                          element: <CMDBPage />,                    errorElement: <RouteError /> },
      // Dynamic CI routes
      { path: 'ci/:typeName',                  element: <CIListPage />,                  errorElement: <RouteError /> },
      { path: 'ci/:typeName/:id',              element: <CIDetailPage />,                errorElement: <RouteError /> },
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
      { path: 'analysis/what-if',               element: <Suspense fallback={<PageLoader />}><WhatIfPage /></Suspense>,                  errorElement: <RouteError /> },
      { path: 'anomalies',                     element: <AnomalyPage />,                 errorElement: <RouteError /> },
      { path: 'topology',                      element: <Suspense fallback={<PageLoader />}><TopologyPage /></Suspense>,                errorElement: <RouteError /> },
      { path: 'workflow',                      element: <WorkflowListPage />,            errorElement: <RouteError /> },
      { path: 'workflow/:id',                  element: <Suspense fallback={<PageLoader />}><WorkflowDesignerPage /></Suspense>,        errorElement: <RouteError /> },
      { path: 'settings/notifications',      element: <NotificationsPage />,       errorElement: <RouteError /> },
      { path: 'settings/notification-rules', element: <NotificationRulesPage />, errorElement: <RouteError /> },
      { path: 'settings/profile',          element: <ProfilePage />,             errorElement: <RouteError /> },
      { path: 'profile',                   element: <UserProfilePage />,         errorElement: <RouteError /> },
      { path: 'settings/ci-types',         element: <CITypeDesignerPage />,      errorElement: <RouteError /> },
      { path: 'settings/itil-designer',   element: <ITILTypeDesignerPage />,    errorElement: <RouteError /> },
      { path: 'settings/enum-designer',  element: <EnumDesignerPage />,        errorElement: <RouteError /> },
      { path: 'settings/sync',            element: <SyncPage />,                errorElement: <RouteError /> },
      { path: 'reports',                   element: <Suspense fallback={<PageLoader />}><ReportsPage /></Suspense>,             errorElement: <RouteError /> },
      { path: 'custom-reports',            element: <Suspense fallback={<PageLoader />}><CustomReportsPage /></Suspense>,       errorElement: <RouteError /> },
      { path: 'teams',                     element: <TeamsPage />,               errorElement: <RouteError /> },
      { path: 'teams/:id',                 element: <TeamDetailPage />,          errorElement: <RouteError /> },
      { path: 'users',                     element: <UsersPage />,               errorElement: <RouteError /> },
      { path: 'users/:id',                 element: <UserDetailPage />,          errorElement: <RouteError /> },
      { path: 'logs',                      element: <LogsPage />,                errorElement: <RouteError /> },
      { path: 'admin/queues',              element: <QueueStatsPage />,          errorElement: <RouteError /> },
      { path: 'admin/audit',              element: <AuditLogPage />,            errorElement: <RouteError /> },
      { path: 'admin/monitoring',         element: <Suspense fallback={<PageLoader />}><MonitoringPage /></Suspense>,          errorElement: <RouteError /> },
      { path: 'admin/knowledge-base',     element: <KBAdminPage />,             errorElement: <RouteError /> },
      { path: 'admin/triggers',            element: <AutoTriggersPage />,        errorElement: <RouteError /> },
      { path: 'admin/business-rules',      element: <BusinessRulesPage />,       errorElement: <RouteError /> },
      { path: 'admin/sla-policies',        element: <SLAPoliciesPage />,         errorElement: <RouteError /> },
      { path: 'admin/integrations',        element: <IntegrationsPage />,        errorElement: <RouteError /> },
      { path: 'admin/assessment-questions', element: <QuestionAdminPage />,      errorElement: <RouteError /> },
      { path: 'approvals',                element: <ApprovalsPage />,           errorElement: <RouteError /> },
      { path: 'knowledge-base',           element: <KnowledgeBasePage />,       errorElement: <RouteError /> },
      { path: 'knowledge-base/:slug',     element: <KBArticlePage />,           errorElement: <RouteError /> },
    ],
  },
])

const root = document.getElementById('root')!

initKeycloak().then((authenticated) => {
  if (!authenticated) {
    keycloak.login()
    return
  }

  // Auto-refresh token before expiry
  setInterval(() => {
    keycloak.updateToken(60).catch(() => keycloak.login())
  }, 30_000)

  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary>
        <ApolloProvider client={apolloClient}>
          <MetamodelProvider>
            <NotificationProvider>
              <RouterProvider router={router} />
              <Toaster richColors position="top-right" />
            </NotificationProvider>
          </MetamodelProvider>
        </ApolloProvider>
      </ErrorBoundary>
    </StrictMode>,
  )
})
