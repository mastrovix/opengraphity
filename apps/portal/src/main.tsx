import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ApolloProvider } from '@apollo/client/react'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import { apolloClient } from '@/lib/apollo'
import { initKeycloak, keycloak } from '@/lib/keycloak'
import { PortalLayout } from '@/components/PortalLayout'
import { HomePage }        from '@/pages/HomePage'
import { TicketListPage }  from '@/pages/TicketListPage'
import { TicketNewPage }   from '@/pages/TicketNewPage'
import { TicketDetailPage } from '@/pages/TicketDetailPage'
import { KBListPage }      from '@/pages/KBListPage'
import { KBArticlePage }   from '@/pages/KBArticlePage'
import '@/index.css'
import '@/i18n/i18n'

const router = createBrowserRouter([
  {
    path:    '/',
    element: <PortalLayout />,
    children: [
      { index: true,             element: <HomePage /> },
      { path: 'tickets',         element: <TicketListPage /> },
      { path: 'tickets/new',     element: <TicketNewPage /> },
      { path: 'tickets/:id',     element: <TicketDetailPage /> },
      { path: 'kb',              element: <KBListPage /> },
      { path: 'kb/:slug',        element: <KBArticlePage /> },
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
      <ApolloProvider client={apolloClient}>
        <RouterProvider router={router} />
      </ApolloProvider>
    </StrictMode>,
  )
}).catch((err: Error) => {
  root.innerHTML = `<div style="display:flex;height:100vh;align-items:center;justify-content:center;flex-direction:column;gap:12px;font-family:system-ui">
    <div style="font-size:20px;font-weight:600;color:#EF4444">Errore di autenticazione</div>
    <div style="color:#64748B;font-size:14px">${err.message}</div>
  </div>`
})
