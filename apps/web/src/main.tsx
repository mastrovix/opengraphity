import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ApolloProvider } from '@apollo/client/react'
import { createBrowserRouter, RouterProvider, useRouteError } from 'react-router-dom'
import { Toaster } from '@/components/ui/sonner'
import { apolloClient } from '@/lib/apollo'
import { AppLayout } from '@/components/layout/AppLayout'
import { LoginPage } from '@/pages/LoginPage'
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
import { CMDBDetailPage } from '@/pages/cmdb/CMDBDetailPage'
import { WorkflowDesignerPage } from '@/pages/workflow/WorkflowDesignerPage'
import NotificationsPage from '@/pages/settings/NotificationsPage'
import ProfilePage from '@/pages/settings/ProfilePage'
import ReportsPage from '@/pages/reports/ReportsPage'
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
    path:         '/login',
    element:      <LoginPage />,
    errorElement: <RouteError />,
  },
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
      { path: 'cmdb',              element: <CMDBPage />,                errorElement: <RouteError /> },
      { path: 'cmdb/:id',              element: <CMDBDetailPage />,          errorElement: <RouteError /> },
      { path: 'workflow/incident',          element: <WorkflowDesignerPage />,    errorElement: <RouteError /> },
      { path: 'settings/notifications',     element: <NotificationsPage />,       errorElement: <RouteError /> },
      { path: 'settings/profile',          element: <ProfilePage />,             errorElement: <RouteError /> },
      { path: 'reports',                   element: <ReportsPage />,             errorElement: <RouteError /> },
    ],
  },
])

const root = document.getElementById('root')!

createRoot(root).render(
  <StrictMode>
    <ApolloProvider client={apolloClient}>
      <RouterProvider router={router} />
      <Toaster richColors position="top-right" />
    </ApolloProvider>
  </StrictMode>,
)
