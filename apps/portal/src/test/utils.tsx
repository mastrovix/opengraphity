/**
 * Helper di rendering per i test del portale: `MockedProvider` (Apollo senza
 * rete) + `MemoryRouter`. Con `path` il componente è montato come route
 * parametrica (`/tickets/:id`) così `useParams` funziona; `LocationSpy`
 * espone la location corrente (`screen.getByTestId('location')`).
 */
import type { ReactElement, ReactNode } from 'react'
import { render, type RenderOptions } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { InMemoryCache } from '@apollo/client'
import { MockedProvider } from '@apollo/client/testing/react'
import type { MockLink } from '@apollo/client/testing'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

export type GqlMock = MockLink.MockedResponse

export interface ProvidersOptions {
  mocks?:  readonly GqlMock[]
  route?:  string
  path?:   string
  showWarnings?: boolean
}

export function LocationSpy() {
  const loc = useLocation()
  return <span data-testid="location" hidden>{loc.pathname + loc.search}</span>
}

export function Providers({ children, mocks = [], route = '/', path, showWarnings = true }: ProvidersOptions & { children: ReactNode }) {
  return (
    <MockedProvider mocks={mocks} cache={new InMemoryCache()} showWarnings={showWarnings} mockLinkDefaultOptions={{ delay: 0 }}>
      <MemoryRouter initialEntries={[route]}>
        {path
          ? <Routes><Route path={path} element={<>{children}<LocationSpy /></>} /><Route path="*" element={<LocationSpy />} /></Routes>
          : <>{children}<LocationSpy /></>}
      </MemoryRouter>
    </MockedProvider>
  )
}

export function renderWithProviders(ui: ReactElement, options: ProvidersOptions & Omit<RenderOptions, 'wrapper'> = {}) {
  const { mocks, route, path, showWarnings, ...renderOptions } = options
  const user = userEvent.setup()
  const result = render(ui, {
    wrapper: ({ children }) => <Providers mocks={mocks} route={route} path={path} showWarnings={showWarnings}>{children}</Providers>,
    ...renderOptions,
  })
  return { ...result, user }
}

export { userEvent }
