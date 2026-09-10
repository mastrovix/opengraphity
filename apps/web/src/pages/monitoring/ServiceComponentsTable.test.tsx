/**
 * Tabella dei componenti (ondata 2): sola lettura senza permessi; per
 * l'admin modifica in riga di «pesa», peso e critico su più righe, invio dei
 * SOLI nodi cambiati con `expectedVersion`, peso disabilitato con «mai»,
 * peso fuori scala che blocca il salvataggio, Ripristina, conflitto di
 * versione e anteprima coi componenti in corso di modifica.
 * Revisione 2: riallineamento PER RIGA sotto il polling (C-2: la riga
 * modificata resta, la riga sovrascritta è detta, l'errore non sparisce) e
 * «Escludi dalla mappa» con conferma (C-1).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { toast } from 'sonner'
import { ServiceComponentsTable } from './ServiceComponentsTable'
import { GET_SERVICE_IMPACT_PREVIEW } from '@/graphql/queries'
import { APPLY_SERVICE_MAP_PROPOSAL, UPDATE_SERVICE_MAP_NODES } from '@/graphql/mutations'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { mapDetail, node, preview } from '@/test/mocks/services'
import type { ServiceMapDetail } from '@/types/services'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }))
beforeEach(() => { vi.mocked(toast.success).mockClear(); vi.mocked(toast.error).mockClear() })

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

  it('C-2: il polling che aggiunge un componente non tocca le righe modificate', async () => {
    const { user, rerender } = renderTable(true)
    const weight = screen.getByLabelText('Weight of db-01')
    await user.clear(weight)
    await user.type(weight, '9')
    await user.click(screen.getByLabelText('cache-02 is critical'))
    expect(bar()).toHaveTextContent('2 components changed')

    // arriva un giro di sincronizzazione: un componente in più, gli altri identici
    const grown = detail({ nodes: [...(mapDetail().nodes as Record<string, unknown>[]), node({ id: 'lb-09', name: 'lb-09' })], nodeCount: 5 })
    rerender(<ServiceComponentsTable map={grown} canEdit ciTypeLabel={(type) => type} onReload={() => {}} />)

    expect(screen.getAllByTestId('component-row')).toHaveLength(5)
    expect(screen.getByLabelText('Weight of db-01')).toHaveValue(9)
    expect(screen.getByLabelText('cache-02 is critical')).toBeChecked()
    expect(bar()).toHaveTextContent('2 components changed')
    expect(screen.queryByTestId('components-overwritten')).not.toBeInTheDocument()
  })

  it('C-2: una modifica sovrascritta da un valore salvato diverso è detta, non scartata in silenzio', async () => {
    const { user, rerender } = renderTable(true)
    const weight = screen.getByLabelText('Weight of db-01')
    await user.clear(weight)
    await user.type(weight, '9')

    // un altro amministratore ha salvato 7 sullo stesso componente
    const nodes = (mapDetail().nodes as Record<string, unknown>[]).map((n) => (n.ci as { id: string }).id === 'db-01' ? { ...n, weight: 7 } : n)
    rerender(<ServiceComponentsTable map={detail({ nodes, version: 4 })} canEdit ciTypeLabel={(type) => type} onReload={() => {}} />)

    expect(await screen.findByTestId('components-overwritten')).toHaveTextContent('Component db-01 was changed elsewhere: your change was discarded.')
    expect(screen.getByLabelText('Weight of db-01')).toHaveValue(7)
    expect(bar()).toHaveTextContent('Nothing to save')
  })

  it('C-2: il salvataggio proprio non è una sovrascrittura, e le righe sparite se ne vanno', async () => {
    const save: GqlMock = {
      request: { query: UPDATE_SERVICE_MAP_NODES, variables: () => true },
      result: { data: { updateServiceMapNodes: mapDetail({ version: 4 }) } },
    }
    const { user, rerender } = renderTable(true, { extra: [save] })
    await user.click(screen.getByLabelText('db-01 is critical'))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    // la mappa torna dal server con la modifica appena mandata, e senza cert-billing
    const nodes = (mapDetail().nodes as Record<string, unknown>[])
      .filter((n) => (n.ci as { id: string }).id !== 'cert-billing')
      .map((n) => (n.ci as { id: string }).id === 'db-01' ? { ...n, critical: true } : n)
    rerender(<ServiceComponentsTable map={detail({ nodes, version: 4, nodeCount: 3 })} canEdit ciTypeLabel={(type) => type} onReload={() => {}} />)

    await waitFor(() => expect(screen.getAllByTestId('component-row')).toHaveLength(3))
    expect(screen.queryByTestId('components-overwritten')).not.toBeInTheDocument()
    expect(bar()).toHaveTextContent('Nothing to save')
  })

  it('C-2: l\'errore di conflitto non sparisce al primo giro di polling', async () => {
    const failing: GqlMock = {
      request: { query: UPDATE_SERVICE_MAP_NODES, variables: () => true },
      error: new Error('the map has been changed by someone else (version 5)'),
    }
    const { user, rerender } = renderTable(true, { extra: [failing] })
    await user.click(screen.getByLabelText('db-01 is critical'))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Components not saved')

    const grown = detail({ nodes: [...(mapDetail().nodes as Record<string, unknown>[]), node({ id: 'lb-09', name: 'lb-09' })], nodeCount: 5, version: 5 })
    rerender(<ServiceComponentsTable map={grown} canEdit ciTypeLabel={(type) => type} onReload={() => {}} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Components not saved')
  })

  it('C-1: «Escludi dalla mappa» chiede conferma e manda exclude: [id]; annullare non chiama nulla', async () => {
    const seen: unknown[] = []
    const exclude: GqlMock = {
      request: { query: APPLY_SERVICE_MAP_PROPOSAL, variables: (v) => { seen.push(v); return true } },
      result: { data: { applyServiceMapProposal: mapDetail({ version: 4 }) } },
    }
    const { user } = renderTable(true, { extra: [exclude] })
    await user.click(within(rowOf('db-01')).getByRole('button', { name: 'Exclude db-01 from the map' }))
    let dialog = await screen.findByRole('dialog', { name: 'Exclude db-01 from the map?' })
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(seen).toEqual([])

    await user.click(within(rowOf('db-01')).getByRole('button', { name: 'Exclude db-01 from the map' }))
    dialog = await screen.findByRole('dialog', { name: 'Exclude db-01 from the map?' })
    expect(dialog).toHaveTextContent('it stops weighing on the service health')
    await user.click(within(dialog).getByRole('button', { name: 'Exclude' }))
    await waitFor(() => expect(seen).toEqual([{ id: 'map-1', expectedVersion: 3, add: [], exclude: ['db-01'], remove: [] }]))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('db-01 excluded: it is out of the map and will not be proposed again'))
  })

  it('C-1: l\'esclusione rifiutata è una riga d\'errore che nomina il componente, mai un successo', async () => {
    const failing: GqlMock = {
      request: { query: APPLY_SERVICE_MAP_PROPOSAL, variables: () => true },
      error: new Error('the map has been changed by someone else (version 5)'),
    }
    const { user } = renderTable(true, { extra: [failing] })
    await user.click(within(rowOf('db-01')).getByRole('button', { name: 'Exclude db-01 from the map' }))
    const dialog = await screen.findByRole('dialog', { name: 'Exclude db-01 from the map?' })
    await user.click(within(dialog).getByRole('button', { name: 'Exclude' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('db-01 not excluded: the map has been changed by someone else (version 5).')
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('R1: la colonna «pesa» dice perché un componente non ha contato, e distingue le due manutenzioni', () => {
    const nodes = (mapDetail().nodes as Record<string, unknown>[]).map((n) => {
      const id = (n.ci as { id: string }).id
      if (id === 'db-01')    return { ...n, contributes: false, excludedReason: 'lifecycle_maintenance' }
      if (id === 'cache-02') return { ...n, contributes: false, inMaintenance: true, excludedReason: 'change_window' }
      return n
    })
    renderTable(false, { map: detail({ nodes }) })
    expect(within(rowOf('db-01')).getByTestId('excluded-reason')).toHaveTextContent('in maintenance (lifecycle)')
    expect(within(rowOf('cache-02')).getByTestId('excluded-reason')).toHaveTextContent('in a change window')
    expect(within(rowOf('cert-billing')).getByTestId('excluded-reason')).toHaveTextContent('never counts (setting)')
    // api-03 conta: nessun motivo da dare
    expect(within(rowOf('api-03')).queryByTestId('excluded-reason')).not.toBeInTheDocument()
  })

  it('R1: un motivo fuori vocabolario è detto in chiaro, mai una riga vuota', () => {
    const nodes = (mapDetail().nodes as Record<string, unknown>[]).map((n) =>
      (n.ci as { id: string }).id === 'db-01' ? { ...n, contributes: false, excludedReason: 'cosmic' } : n)
    renderTable(false, { map: detail({ nodes }) })
    expect(within(rowOf('db-01')).getByTestId('excluded-reason')).toHaveTextContent('Unknown (cosmic)')
  })

  it('C-1: senza permessi non c\'è nessuna colonna di azioni', () => {
    renderTable(false)
    expect(screen.queryByRole('button', { name: /Exclude/ })).not.toBeInTheDocument()
    expect(screen.queryByText('Actions')).not.toBeInTheDocument()
  })

  it('mappa senza componenti: nota esplicita, nessuna tabella', () => {
    renderTable(true, { map: detail({ nodes: [], nodeCount: 0 }) })
    expect(screen.getByText('The map has no components.')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })
})
