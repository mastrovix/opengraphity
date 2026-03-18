import { StrictMode } from 'react'
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
import { ChangeListPage } from '@/pages/changes/ChangeListPage'
import { CreateChangePage } from '@/pages/changes/CreateChangePage'
import { ChangeDetailPage } from '@/pages/changes/ChangeDetailPage'
import { RequestListPage } from '@/pages/requests/RequestListPage'
import { CreateServiceRequestPage } from '@/pages/requests/CreateServiceRequestPage'
import { CMDBPage } from '@/pages/cmdb/CMDBPage'
import { CIListPage } from '@/pages/ci/CIListPage'
import { CIDetailPage } from '@/pages/ci/CIDetailPage'
import { ApplicationsPage } from '@/pages/applications/ApplicationsPage'
import { ApplicationDetailPage } from '@/pages/applications/ApplicationDetailPage'
import { DatabasesPage } from '@/pages/databases/DatabasesPage'
import { DatabaseDetailPage } from '@/pages/databases/DatabaseDetailPage'
import { DatabaseInstancesPage } from '@/pages/database-instances/DatabaseInstancesPage'
import { DatabaseInstanceDetailPage } from '@/pages/database-instances/DatabaseInstanceDetailPage'
import { ServersPage } from '@/pages/servers/ServersPage'
import { ServerDetailPage } from '@/pages/servers/ServerDetailPage'
import { CertificatesPage } from '@/pages/certificates/CertificatesPage'
import { CertificateDetailPage } from '@/pages/certificates/CertificateDetailPage'
function CIDetailRedirect({ typeName }: { typeName: string }) {
  const { id } = useParams<{ id: string }>()
  return <Navigate to={`/ci/${typeName}/${id}`} replace />
}
import { WorkflowListPage }     from '@/pages/workflow/WorkflowListPage'
import { WorkflowDesignerPage } from '@/pages/workflow/WorkflowDesignerPage'
import NotificationsPage from '@/pages/settings/NotificationsPage'
import ProfilePage from '@/pages/settings/ProfilePage'
import ReportsPage from '@/pages/reports/ReportsPage'
import { TeamsPage } from '@/pages/teams/TeamsPage'
import { TeamDetailPage } from '@/pages/teams/TeamDetailPage'
import { UsersPage } from '@/pages/users/UsersPage'
import { UserDetailPage } from '@/pages/users/UserDetailPage'
import { LogsPage } from '@/pages/logs/LogsPage'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { MetamodelProvider } from '@/contexts/MetamodelContext'
import { initKeycloak, keycloak } from '@/lib/keycloak'
import '@/index.css'
import '@xyflow/react/dist/style.css'

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
      background:     '#f8f9fc',
    }}>
      <div style={{ fontSize: 48 }}>⚠️</div>
      <h1 style={{ fontSize: 24, fontWeight: 700, color: '#0f1629', margin: 0 }}>
        {error?.status === 404 ? 'Page not found' : 'Unexpected error'}
      </h1>
      <p style={{ color: '#8892a4', margin: 0 }}>
        {error?.statusText ?? 'Something went wrong'}
      </p>
      <a href="/dashboard" style={{ color: '#4f46e5', textDecoration: 'none', fontSize: 14 }}>
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
      { path: 'changes',           element: <ChangeListPage />,          errorElement: <RouteError /> },
      { path: 'changes/new',       element: <CreateChangePage />,        errorElement: <RouteError /> },
      { path: 'changes/:id',       element: <ChangeDetailPage />,        errorElement: <RouteError /> },
      { path: 'requests',          element: <RequestListPage />,         errorElement: <RouteError /> },
      { path: 'requests/new',      element: <CreateServiceRequestPage />,errorElement: <RouteError /> },
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
      // Keep old static pages as fallback (unused, but no dead imports)
      { path: 'applications-legacy',           element: <ApplicationsPage />,            errorElement: <RouteError /> },
      { path: 'applications-legacy/:id',       element: <ApplicationDetailPage />,       errorElement: <RouteError /> },
      { path: 'databases-legacy',              element: <DatabasesPage />,               errorElement: <RouteError /> },
      { path: 'databases-legacy/:id',          element: <DatabaseDetailPage />,          errorElement: <RouteError /> },
      { path: 'database-instances-legacy',     element: <DatabaseInstancesPage />,       errorElement: <RouteError /> },
      { path: 'database-instances-legacy/:id', element: <DatabaseInstanceDetailPage />,  errorElement: <RouteError /> },
      { path: 'servers-legacy',                element: <ServersPage />,                 errorElement: <RouteError /> },
      { path: 'servers-legacy/:id',            element: <ServerDetailPage />,            errorElement: <RouteError /> },
      { path: 'certificates-legacy',           element: <CertificatesPage />,            errorElement: <RouteError /> },
      { path: 'certificates-legacy/:id',       element: <CertificateDetailPage />,       errorElement: <RouteError /> },
      { path: 'workflow',                      element: <WorkflowListPage />,            errorElement: <RouteError /> },
      { path: 'workflow/:id',                  element: <WorkflowDesignerPage />,        errorElement: <RouteError /> },
      { path: 'settings/notifications',     element: <NotificationsPage />,       errorElement: <RouteError /> },
      { path: 'settings/profile',          element: <ProfilePage />,             errorElement: <RouteError /> },
      { path: 'reports',                   element: <ReportsPage />,             errorElement: <RouteError /> },
      { path: 'teams',                     element: <TeamsPage />,               errorElement: <RouteError /> },
      { path: 'teams/:id',                 element: <TeamDetailPage />,          errorElement: <RouteError /> },
      { path: 'users',                     element: <UsersPage />,               errorElement: <RouteError /> },
      { path: 'users/:id',                 element: <UserDetailPage />,          errorElement: <RouteError /> },
      { path: 'logs',                      element: <LogsPage />,                errorElement: <RouteError /> },
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
            <RouterProvider router={router} />
            <Toaster richColors position="top-right" />
          </MetamodelProvider>
        </ApolloProvider>
      </ErrorBoundary>
    </StrictMode>,
  )
})
