/**
 * CMDB: il filtro sulla salute arriva dall'URL (`?health=none` dal riquadro
 * "Senza monitoraggio" della pagina Salute CI, `?health=down` dai link per
 * stato) e diventa una regola del filtro avanzato già applicata alla query e
 * visibile nel pannello.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { meMock } from '@/test/mocks/gql'
import { GET_ALL_CIS } from '@/graphql/queries'
import { CMDBPage, healthRuleFromParam } from './CMDBPage'

vi.mock('@/lib/ciEnums', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ciEnums')>()),
  useCIBaseEnums: () => ({ statuses: ['active'], environments: ['production'], loading: false, error: null }),
}))

type Vars = Record<string, unknown>
const cisMock = (seen: Vars[]): GqlMock => ({
  request: { query: GET_ALL_CIS, variables: (v) => { seen.push(v as Vars); return true } },
  result: { data: { allCIs: { total: 2, items: [
    { id: 'ci-1', name: 'db-01', type: 'server', status: 'active', environment: 'production', description: null, createdAt: '2026-09-01T00:00:00Z', health: null, ownerGroup: null, supportGroup: null },
    { id: 'ci-2', name: 'web-02', type: 'server', status: 'active', environment: 'production', description: null, createdAt: '2026-09-01T00:00:00Z', health: 'down', ownerGroup: null, supportGroup: null },
  ] } } },
  maxUsageCount: Number.POSITIVE_INFINITY,
})

describe('healthRuleFromParam', () => {
  it('none → "è vuoto"; uno stato → uguale; altro → nessuna regola', () => {
    expect(healthRuleFromParam('none')).toMatchObject({ field: 'health', operator: 'is_empty', value: null })
    expect(healthRuleFromParam('down')).toMatchObject({ field: 'health', operator: 'equals', value: 'down' })
    expect(healthRuleFromParam('bogus')).toBeNull()
    expect(healthRuleFromParam(null)).toBeNull()
  })
})

describe('CMDBPage — filtro salute dall\'URL', () => {
  it('?health=none → la query parte con la regola "health is_empty" e il pannello la mostra', async () => {
    const seen: Vars[] = []
    renderWithProviders(<CMDBPage />, { route: '/cmdb?health=none', path: '/cmdb', mocks: [meMock('admin'), cisMock(seen)] })
    await waitFor(() => expect(seen.length).toBeGreaterThan(0))
    const filters = JSON.parse(String(seen[0]!['filters'])) as { rules: { field: string; operator: string }[] }
    expect(filters.rules).toEqual([expect.objectContaining({ id: 'url-health', field: 'health', operator: 'is_empty' })])
    // Regola visibile nel pannello (aperto) con il campo Salute selezionato.
    const fieldSelects = await screen.findAllByDisplayValue('Health')
    expect(fieldSelects.length).toBeGreaterThan(0)
    // Colonna Salute: CI senza salute → trattino, CI giù → badge.
    expect(await screen.findByText('db-01')).toBeInTheDocument()
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
  })

  it('senza parametro → nessun filtro avanzato', async () => {
    const seen: Vars[] = []
    renderWithProviders(<CMDBPage />, { route: '/cmdb', path: '/cmdb', mocks: [meMock('admin'), cisMock(seen)] })
    await waitFor(() => expect(seen.length).toBeGreaterThan(0))
    expect(seen[0]!['filters']).toBeNull()
  })
})
