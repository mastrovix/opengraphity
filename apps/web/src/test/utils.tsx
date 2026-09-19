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
import { MetamodelContext, type CITypeDef } from '@/contexts/MetamodelContext'

export type GqlMock = MockLink.MockedResponse

export interface ProvidersOptions {
  mocks?:  readonly GqlMock[]
  /** URL iniziale del MemoryRouter (default "/"). */
  route?:  string
  /** Pattern di route (es. "/users/:id"): il componente è renderizzato come suo element. */
  path?:   string
  /** Mostra su console i mock non trovati (default true: un mock mancante è un errore del test). */
  showWarnings?: boolean
  /**
   * Tipi CI del CLIENTE da aggiungere a quelli spediti, per un test che ne
   * usa uno suo (`[['firewall', 'Firewall']]`). Il nome di un tipo si legge
   * dal metamodello, quindi un tipo che il metamodello non ha si mostra col
   * nome interno — che è giusto, ma non è quello che il test vuole provare.
   */
  ciTypes?: readonly (readonly [string, string])[]
}

/** Espone l'ultima location del router: `screen.getByTestId('location')`. (Uno <span> senza ruolo: non interferisce con le query per role.) */
export function LocationSpy() {
  const loc = useLocation()
  return <span data-testid="location" hidden>{loc.pathname + loc.search}</span>
}

/**
 * IL METAMODELLO C'È SEMPRE, ANCHE NEI TEST (20 set 2026).
 *
 * Il nome di un tipo CI viene dal metamodello (`useCILabels`). Nell'app è
 * caricato prima di ogni pagina; nei test non c'era nessun provider, e le
 * pagine cadevano sul ripiego — finché il ripiego è stato una tabella di
 * traduzioni cablate, i test leggevano «Server» senza accorgersi che il dato
 * non c'era. Qui ci sono i tipi SPEDITI col prodotto, con le etichette che
 * hanno davvero sul grafo: un test che rende una pagina vede quello che vede
 * un utente. Un test che ha bisogno dei tipi del CLIENTE monta il suo
 * provider, che vince su questo.
 */
const TIPI_SPEDITI_COPPIE = [
  ['application', 'Application'], ['server', 'Server'], ['database', 'Database'],
  ['database_instance', 'Database Instance'], ['certificate', 'Certificate'],
  ['business_application', 'Business Application'], ['business_capability', 'Business Capability'],
  ['dynamic_ci_group', 'Dynamic CI Group'],
] as const

function tipiDaCoppie(coppie: readonly (readonly [string, string])[]): CITypeDef[] {
  return coppie.map(([name, label]) => ({
    id: name, name, label, labels: [], icon: 'box', color: '#64748b', active: true,
    scope: 'base', tenantId: 'system', validationScript: null, chainFamilies: [],
    serviceRole: null, fields: [], relations: [], systemRelations: [],
  })) as unknown as CITypeDef[]
}

const TIPI_SPEDITI = tipiDaCoppie(TIPI_SPEDITI_COPPIE)

export function Providers({ children, mocks = [], route = '/', path, showWarnings = true, ciTypes = [] }: ProvidersOptions & { children: ReactNode }) {
  const tipi = ciTypes.length === 0 ? TIPI_SPEDITI : [...TIPI_SPEDITI, ...tipiDaCoppie(ciTypes)]
  const metamodello = { ciTypes: tipi, loading: false, error: null, getCIType: (name: string) => tipi.find((t) => t.name === name) }
  return (
    <MockedProvider
      mocks={mocks}
      cache={new InMemoryCache()}
      showWarnings={showWarnings}
      mockLinkDefaultOptions={{ delay: 0 }}
    >
      <MemoryRouter initialEntries={[route]}>
        <MetamodelContext.Provider value={metamodello}>
        <ConfirmProvider>
          {path
            ? <Routes><Route path={path} element={<>{children}<LocationSpy /></>} /><Route path="*" element={<LocationSpy />} /></Routes>
            : <>{children}<LocationSpy /></>}
        </ConfirmProvider>
        </MetamodelContext.Provider>
      </MemoryRouter>
    </MockedProvider>
  )
}

export function renderWithProviders(ui: ReactElement, options: ProvidersOptions & Omit<RenderOptions, 'wrapper'> = {}) {
  const { mocks, route, path, showWarnings, ciTypes, ...renderOptions } = options
  const user = userEvent.setup()
  const result = render(ui, {
    wrapper: ({ children }) => (
      <Providers mocks={mocks} route={route} path={path} showWarnings={showWarnings} ciTypes={ciTypes}>{children}</Providers>
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
