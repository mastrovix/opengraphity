import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ApolloProvider } from '@apollo/client/react'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import { apolloClient } from '@/lib/apollo'
import { initKeycloak, keycloak } from '@/lib/keycloak'
import { startTokenRefreshLoop } from '@/lib/tokenRefresh'
import { PortalLayout } from '@/components/PortalLayout'
import { HomePage }        from '@/pages/HomePage'
import { TicketListPage }  from '@/pages/TicketListPage'
import { TicketNewPage }   from '@/pages/TicketNewPage'
import { TicketDetailPage } from '@/pages/TicketDetailPage'
import { KBListPage }      from '@/pages/KBListPage'
import { KBArticlePage }   from '@/pages/KBArticlePage'
import { ServiceCatalogPage } from '@/pages/ServiceCatalogPage'
import { NotFoundPage }    from '@/pages/NotFoundPage'
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
      { path: 'catalog',         element: <ServiceCatalogPage /> },
      { path: 'kb',              element: <KBListPage /> },
      { path: 'kb/:slug',        element: <KBArticlePage /> },
      // Catch-all: an unknown URL renders a 404 page instead of a blank layout.
      { path: '*',               element: <NotFoundPage /> },
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
  // blip towards Keycloak retries with backoff (banner), only an invalid
  // session redirects to login — same loop as apps/web (E-05).
  startTokenRefreshLoop()

  createRoot(root).render(
    <StrictMode>
      <ApolloProvider client={apolloClient}>
        <RouterProvider router={router} />
      </ApolloProvider>
    </StrictMode>,
  )
}).catch((err: unknown) => {
  // initKeycloak throws for: no tenant in subdomain, missing VITE_KEYCLOAK_URL /
  // VITE_KEYCLOAK_CLIENT_ID, unknown realm, Keycloak unreachable (the message
  // already carries the cause). Without this the user sees a blank page.
  const message = err instanceof Error ? err.message : String(err)
  root.replaceChildren()
  const box = document.createElement('div')
  box.style.cssText = 'display:flex;height:100vh;align-items:center;justify-content:center;flex-direction:column;gap:12px;font-family:system-ui;padding:24px;text-align:center'
  const title = document.createElement('div')
  title.style.cssText = 'font-size:20px;font-weight:600;color:var(--color-danger)'
  title.textContent = 'Errore di autenticazione'
  const detail = document.createElement('div')
  detail.style.cssText = 'color:var(--color-slate);font-size:14px;max-width:640px'
  detail.textContent = message   // textContent: the message may echo the hostname/URL
  box.append(title, detail)
  root.appendChild(box)
})
