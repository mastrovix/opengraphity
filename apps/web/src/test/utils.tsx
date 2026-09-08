/**
 * Helper di rendering per i test dei componenti/pagine:
 *
 *   renderWithProviders(<UsersPage />, { mocks: [...], route: '/users' })
 *
 * monta l'albero dentro `MockedProvider` (Apollo, nessuna rete), `MemoryRouter`
 * (react-router) e `ConfirmProvider` (useConfirm). Con `path` il componente è
 * montato come route parametrica (`/users/:id`) così `useParams` funziona.
 */
import type { ReactElement, ReactNode } from 'react'
import { render, type RenderOptions } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { InMemoryCache } from '@apollo/client'
import { MockedProvider } from '@apollo/client/testing/react'
import type { MockLink } from '@apollo/client/testing'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { ConfirmProvider } from '@/hooks/useConfirm'

export type GqlMock = MockLink.MockedResponse

export interface ProvidersOptions {
  mocks?:  readonly GqlMock[]
  /** URL iniziale del MemoryRouter (default "/"). */
  route?:  string
  /** Pattern di route (es. "/users/:id"): il componente è renderizzato come suo element. */
  path?:   string
  /** Mostra su console i mock non trovati (default true: un mock mancante è un errore del test). */
  showWarnings?: boolean
}

/** Espone l'ultima location del router: `screen.getByTestId('location')`. (Uno <span> senza ruolo: non interferisce con le query per role.) */
export function LocationSpy() {
  const loc = useLocation()
  return <span data-testid="location" hidden>{loc.pathname + loc.search}</span>
}

export function Providers({ children, mocks = [], route = '/', path, showWarnings = true }: ProvidersOptions & { children: ReactNode }) {
  return (
    <MockedProvider
      mocks={mocks}
      cache={new InMemoryCache()}
      showWarnings={showWarnings}
      mockLinkDefaultOptions={{ delay: 0 }}
    >
      <MemoryRouter initialEntries={[route]}>
        <ConfirmProvider>
          {path
            ? <Routes><Route path={path} element={<>{children}<LocationSpy /></>} /><Route path="*" element={<LocationSpy />} /></Routes>
            : <>{children}<LocationSpy /></>}
        </ConfirmProvider>
      </MemoryRouter>
    </MockedProvider>
  )
}

export function renderWithProviders(ui: ReactElement, options: ProvidersOptions & Omit<RenderOptions, 'wrapper'> = {}) {
  const { mocks, route, path, showWarnings, ...renderOptions } = options
  const user = userEvent.setup()
  const result = render(ui, {
    wrapper: ({ children }) => (
      <Providers mocks={mocks} route={route} path={path} showWarnings={showWarnings}>{children}</Providers>
    ),
    ...renderOptions,
  })
  return { ...result, user }
}

/** Imposta variabili CSS su `:root` (per `cssVar` / ECharts). Ritorna una funzione di pulizia. */
export function setCssVars(vars: Record<string, string>): () => void {
  const root = document.documentElement
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v)
  return () => { for (const k of Object.keys(vars)) root.style.removeProperty(k) }
}

/** Token CSS minimi richiesti da `lib/charts/echartsOptions` (theme + palette). */
export const CHART_CSS_VARS: Record<string, string> = {
  '--font-family':             'Inter, sans-serif',
  '--color-slate-dark':        '#0f172a',
  '--color-slate':             '#64748b',
  '--color-slate-light':       '#94a3b8',
  '--color-slate-bg':          '#f1f5f9',
  '--color-border':            '#e2e8f0',
  '--color-brand':             '#0284c7',
  '--color-trigger-automatic': '#059669',
  '--color-warning':           '#eab308',
  '--color-danger':            '#ef4444',
  '--color-trigger-timer':     '#d97706',
  '--font-size-body':          '14px',
  '--font-size-table':         '12px',
  '--font-size-page-title':    '24px',
}

export { userEvent }
