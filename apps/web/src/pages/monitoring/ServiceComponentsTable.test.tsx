/**
 * Tabella dei componenti (ondata 2): sola lettura senza permessi; per
 * l'admin modifica in riga di «pesa», peso e critico su più righe, invio dei
 * SOLI nodi cambiati con `expectedVersion`, peso disabilitato con «mai»,
 * peso fuori scala che blocca il salvataggio, Ripristina, conflitto di
 * versione e anteprima coi componenti in corso di modifica.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { ServiceComponentsTable } from './ServiceComponentsTable'
import { GET_SERVICE_IMPACT_PREVIEW } from '@/graphql/queries'
import { UPDATE_SERVICE_MAP_NODES } from '@/graphql/mutations'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { mapDetail, preview } from '@/test/mocks/services'
import type { ServiceMapDetail } from '@/types/services'

const detail = (over: Record<string, unknown> = {}) => mapDetail(over) as unknown as ServiceMapDetail

const previewMock: GqlMock = {
  request: { query: GET_SERVICE_IMPACT_PREVIEW, variables: () => true },
  result: { data: { serviceImpactPreview: preview() } },
  maxUsageCount: Number.POSITIVE_INFINITY,
}

function renderTable(canEdit: boolean, opts: { map?: ServiceMapDetail; extra?: GqlMock[]; onReload?: () => void } = {}) {
  return renderWithProviders(
    <ServiceComponentsTable map={opts.map ?? detail()} canEdit={canEdit} ciTypeLabel={(type) => type} onReload={opts.onReload ?? (() => {})} />,
    { mocks: [previewMock, ...(opts.extra ?? [])] },
  )
}

const rowOf = (ciId: string) => screen.getAllByTestId('component-row').find((r) => r.getAttribute('data-ci-id') === ciId)!
const bar = () => screen.getByTestId('components-dirty')

describe('ServiceComponentsTable', () => {
  it('senza permessi: valori in parole, nessun controllo, nessuna barra né anteprima', () => {
    renderTable(false)
    expect(within(rowOf('cert-billing')).getByText('Never')).toBeInTheDocument()
    expect(within(rowOf('api-03')).getByText('critical')).toBeInTheDocument()
    expect(screen.queryByTestId('components-dirty')).not.toBeInTheDocument()
    expect(screen.queryByTestId('components-preview')).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('admin: una riga per componente con «pesa», peso e critico; niente da salvare all\'inizio', () => {
    renderTable(true)
    expect(screen.getAllByTestId('component-row')).toHaveLength(4)
    expect(screen.getByLabelText('How db-01 counts')).toHaveValue('weighted')
    expect(screen.getByLabelText('Weight of db-01')).toHaveValue(5)
    expect(screen.getByLabelText('api-03 is critical')).toBeChecked()
    expect(bar()).toHaveTextContent('Nothing to save')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    // il peso di un componente che non pesa mai è disabilitato
    expect(screen.getByLabelText('Weight of cert-billing')).toBeDisabled()
  })

  it('admin: modifica di più righe → conteggio, e si mandano SOLO i nodi cambiati', async () => {
    const seen: unknown[] = []
    const save: GqlMock = {
      request: { query: UPDATE_SERVICE_MAP_NODES, variables: (v) => { seen.push(v); return true } },
      result: { data: { updateServiceMapNodes: mapDetail({ version: 4 }) } },
    }
    const { user } = renderTable(true, { extra: [save] })

    const weight = screen.getByLabelText('Weight of db-01')
    await user.clear(weight)
    await user.type(weight, '9')
    expect(bar()).toHaveTextContent('1 component changed')

    await user.click(screen.getByLabelText('cache-02 is critical'))
    expect(bar()).toHaveTextContent('2 components changed')

    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(seen).toEqual([{
      id: 'map-1', expectedVersion: 3,
      nodes: [
        { ciId: 'cache-02', propagate: 'weighted', weight: 3, critical: true },
        { ciId: 'db-01', propagate: 'weighted', weight: 9, critical: false },
      ],
    }]))
  })

  it('admin: «mai» disabilita il peso; Ripristina riporta ogni riga al valore letto', async () => {
    const { user } = renderTable(true)
    await user.selectOptions(screen.getByLabelText('How db-01 counts'), 'never')
    expect(screen.getByLabelText('Weight of db-01')).toBeDisabled()
    expect(bar()).toHaveTextContent('1 component changed')
    await user.click(screen.getByRole('button', { name: 'Reset' }))
    expect(screen.getByLabelText('How db-01 counts')).toHaveValue('weighted')
    expect(screen.getByLabelText('Weight of db-01')).toBeEnabled()
    expect(bar()).toHaveTextContent('Nothing to save')
  })

  it('admin: peso fuori scala → salvataggio bloccato e campo segnalato', async () => {
    const { user } = renderTable(true)
    const weight = screen.getByLabelText('Weight of db-01')
    await user.clear(weight)
    await user.type(weight, '42')
    expect(bar()).toHaveTextContent('Weight out of scale: whole number between 1 and 10.')
    expect(weight).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(screen.queryByTestId('components-preview')).not.toBeInTheDocument()
  })

  it('admin: conflitto di versione → riga d\'errore con il messaggio del server e «Ricarica»', async () => {
    const onReload = vi.fn()
    const failing: GqlMock = {
      request: { query: UPDATE_SERVICE_MAP_NODES, variables: () => true },
      error: new Error('the map has been changed by someone else (version 5)'),
    }
    const { user } = renderTable(true, { extra: [failing], onReload })
    await user.click(screen.getByLabelText('db-01 is critical'))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Components not saved: the map has been changed by someone else (version 5).')
    await user.click(within(alert).getByRole('button', { name: 'Reload' }))
    expect(onReload).toHaveBeenCalledTimes(1)
  })

  it('admin: l\'anteprima manda i soli componenti cambiati', async () => {
    const seen: Record<string, unknown>[] = []
    const spy: GqlMock = {
      request: { query: GET_SERVICE_IMPACT_PREVIEW, variables: (v) => { seen.push(v as Record<string, unknown>); return true } },
      result: { data: { serviceImpactPreview: preview({ health: 'down', impactScore: 88, contributingCount: 1 }) } },
      maxUsageCount: Number.POSITIVE_INFINITY,
    }
    const { user } = renderWithProviders(
      <ServiceComponentsTable map={detail()} canEdit ciTypeLabel={(t) => t} onReload={() => {}} />,
      { mocks: [spy] },
    )
    expect(await screen.findByTestId('components-preview')).toHaveTextContent('score 88')
    await user.click(screen.getByLabelText('db-01 is critical'))
    await waitFor(() => expect(seen.at(-1)?.nodes).toEqual([{ ciId: 'db-01', propagate: 'weighted', weight: 5, critical: true }]))
    expect(seen[0]?.nodes).toBeNull()
  })

  it('mappa senza componenti: nota esplicita, nessuna tabella', () => {
    renderTable(true, { map: detail({ nodes: [], nodeCount: 0 }) })
    expect(screen.getByText('The map has no components.')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })
})
