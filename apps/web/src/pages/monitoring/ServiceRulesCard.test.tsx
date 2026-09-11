/**
 * Riquadro delle regole d'impatto (ondata 2): sola lettura senza permessi;
 * per l'admin modifiche non salvate, Ripristina, validazione in pagina
 * (soglia degradato ≤ soglia giù), salvataggio con `expectedVersion`,
 * conflitto di versione con invito a ricaricare, anteprima dal vivo e valore
 * fuori vocabolario che resta scelto.
 */
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { ServiceRulesCard, validateRulesForm } from './ServiceRulesCard'
import { GET_SERVICE_IMPACT_PREVIEW } from '@/graphql/queries'
import { UPDATE_SERVICE_IMPACT_RULES } from '@/graphql/mutations'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { mapDetail, preview, RULES } from '@/test/mocks/services'
import type { ServiceMapDetail } from '@/types/services'

const detail = (over: Record<string, unknown> = {}) => mapDetail(over) as unknown as ServiceMapDetail

const previewMock: GqlMock = {
  request: { query: GET_SERVICE_IMPACT_PREVIEW, variables: () => true },
  result: { data: { serviceImpactPreview: preview() } },
  maxUsageCount: Number.POSITIVE_INFINITY,
}

/** Il riquadro è chiuso di default nella pagina: qui si apre subito, è il soggetto del test. */
function openRules() {
  fireEvent.click(screen.getByRole('button', { name: 'How it is computed' }))
}

function renderCard(canEdit: boolean, opts: { map?: ServiceMapDetail; extra?: GqlMock[]; onReload?: () => void } = {}) {
  const r = renderWithProviders(
    <ServiceRulesCard map={opts.map ?? detail()} canEdit={canEdit} onReload={opts.onReload ?? (() => {})} />,
    { mocks: [previewMock, ...(opts.extra ?? [])] },
  )
  openRules()
  return r
}

const status = () => screen.getByTestId('rules-dirty')

describe('validateRulesForm', () => {
  const base = { downSharePct: 50, degradedSharePct: 20, minNodes: 1, unknownNodes: 'ignore', openIncidentFrom: 'down', duringStorm: 'hold' }

  it('accetta i valori validi e rifiuta interi mancanti, scala e incoerenza fra le soglie', () => {
    expect(validateRulesForm(base)).toEqual({})
    expect(validateRulesForm({ ...base, downSharePct: Number.NaN }).downSharePct?.key).toBe('integer')
    expect(validateRulesForm({ ...base, downSharePct: 140 }).downSharePct?.key).toBe('range')
    expect(validateRulesForm({ ...base, minNodes: 0 }).minNodes?.key).toBe('range')
    expect(validateRulesForm({ ...base, degradedSharePct: 80 }).degradedSharePct?.key).toBe('degradedOverDown')
    // l'incoerenza non copre un errore di scala già trovato sullo stesso campo
    expect(validateRulesForm({ ...base, degradedSharePct: 200 }).degradedSharePct?.key).toBe('range')
  })

  it('rifiuta un minimo di componenti sopra i componenti della mappa (lo stesso limite dell\'API)', () => {
    expect(validateRulesForm({ ...base, minNodes: 4 }, 4)).toEqual({})
    expect(validateRulesForm({ ...base, minNodes: 5 }, 4).minNodes).toEqual({ key: 'aboveComponents', min: 1, max: 4 })
  })
})

describe('ServiceRulesCard', () => {
  it('senza permessi: le regole in parole, nessun controllo', async () => {
    renderCard(false)
    expect(await screen.findByText('Rules version 1')).toBeInTheDocument()
    expect(screen.queryByTestId('service-rules-form')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
    expect(screen.getByText('Components without health: ignored')).toBeInTheDocument()
    expect(screen.getByText('Service incident from: down')).toBeInTheDocument()
  })

  it('admin: campi con aiuto, «Niente da salvare» finché non si tocca nulla', async () => {
    renderCard(true)
    expect(await screen.findByTestId('service-rules-form')).toBeInTheDocument()
    expect(screen.getByLabelText('Down threshold (%)')).toHaveValue(50)
    expect(screen.getByLabelText('Degraded threshold (%)')).toHaveValue(1)
    expect(screen.getByLabelText('Minimum components')).toHaveValue(1)
    expect(screen.getByLabelText('Components without health')).toHaveValue('ignore')
    expect(screen.getByLabelText('Open a service incident from')).toHaveValue('down')
    expect(screen.getByText('From which health a service incident is opened.')).toBeInTheDocument()
    expect(status()).toHaveTextContent('Nothing to save')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Reset' })).toBeDisabled()
  })

  it('admin: modifica → «Modifiche non salvate», Ripristina riporta al valore letto', async () => {
    const { user } = renderCard(true)
    const down = await screen.findByLabelText('Down threshold (%)')
    await user.clear(down)
    await user.type(down, '70')
    expect(status()).toHaveTextContent('Unsaved changes')
    await user.click(screen.getByRole('button', { name: 'Reset' }))
    expect(down).toHaveValue(50)
    expect(status()).toHaveTextContent('Nothing to save')
  })

  it('admin: salva con expectedVersion = la versione letta e manda le regole intere', async () => {
    const seen: unknown[] = []
    const save: GqlMock = {
      request: { query: UPDATE_SERVICE_IMPACT_RULES, variables: (v) => { seen.push(v); return true } },
      result: { data: { updateServiceImpactRules: mapDetail({ version: 4, rules: { ...RULES, version: 2, downSharePct: 70 } }) } },
    }
    const { user } = renderCard(true, { extra: [save] })
    const down = await screen.findByLabelText('Down threshold (%)')
    await user.clear(down)
    await user.type(down, '70')
    await user.selectOptions(screen.getByLabelText('Components without health'), 'operational')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(seen).toEqual([{
      id: 'map-1', expectedVersion: 3,
      rules: { downSharePct: 70, degradedSharePct: 1, minNodes: 1, unknownNodes: 'operational', openIncidentFrom: 'down', duringStorm: 'hold' },
    }]))
  })

  it('admin: soglia degradato sopra la soglia giù → messaggio e salvataggio bloccato', async () => {
    const { user } = renderCard(true)
    const degraded = await screen.findByLabelText('Degraded threshold (%)')
    await user.clear(degraded)
    await user.type(degraded, '80')
    expect(await screen.findByText('The degraded threshold cannot be above the down threshold: degraded would never be reached.')).toBeInTheDocument()
    expect(degraded).toHaveAttribute('aria-invalid', 'true')
    expect(status()).toHaveTextContent('Fields to fix')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    // con le regole non valide l'anteprima non parte: non si chiede al server un calcolo impossibile
    expect(screen.queryByTestId('rules-preview')).not.toBeInTheDocument()
  })

  it('admin: conflitto di versione → riga d\'errore con il messaggio del server e «Ricarica»', async () => {
    const onReload = vi.fn()
    const failing: GqlMock = {
      request: { query: UPDATE_SERVICE_IMPACT_RULES, variables: () => true },
      error: new Error('the map has been changed by someone else (version 5)'),
    }
    const { user } = renderCard(true, { extra: [failing], onReload })
    const down = await screen.findByLabelText('Down threshold (%)')
    await user.clear(down)
    await user.type(down, '70')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Rules not saved: the map has been changed by someone else (version 5). If another admin — or the automatic sync — changed the map, reload and try again.')
    await user.click(within(alert).getByRole('button', { name: 'Reload' }))
    expect(onReload).toHaveBeenCalledTimes(1)
  })

  it('C-8: l\'anteprima parte solo con qualcosa di modificato; l\'errore è una riga visibile', async () => {
    const { user } = renderCard(true)
    const down = await screen.findByLabelText('Down threshold (%)')
    // senza modifiche nessuna anteprima: non si chiede un calcolo al server a ogni apertura della pagina
    expect(screen.queryByTestId('rules-preview')).not.toBeInTheDocument()

    await user.clear(down)
    await user.type(down, '70')
    const line = await screen.findByTestId('rules-preview')
    expect(line).toHaveTextContent('With these settings right now:')
    expect(line).toHaveTextContent('Degraded')
    expect(line).toHaveTextContent('score 41')
    expect(line).toHaveTextContent('3 of 4 components weigh')
  })

  it('anteprima: query fallita → riga visibile, mai un\'anteprima vecchia spacciata per nuova', async () => {
    const failing: GqlMock = { request: { query: GET_SERVICE_IMPACT_PREVIEW, variables: () => true }, error: new Error('engine busy') }
    const { user } = renderWithProviders(<ServiceRulesCard map={detail()} canEdit onReload={() => {}} />, { mocks: [failing] })
    openRules()
    const down = await screen.findByLabelText('Down threshold (%)')
    await user.clear(down)
    await user.type(down, '70')
    expect(await screen.findByText('Preview unavailable: engine busy')).toBeInTheDocument()
  })

  it('C-6: una regola salvata diventata inapplicabile non è «un campo da correggere»: riga ambra e pulsante che la sistema', async () => {
    // mappa scesa a 3 componenti con `minNodes = 5` salvato: nessuno ha toccato niente
    const map = detail({ nodeCount: 3, rules: { ...RULES, minNodes: 5 } })
    const { user } = renderCard(true, { map })
    const row = await screen.findByTestId('rules-saved-stale')
    expect(row).toHaveTextContent('The saved minimum of components (5) is above the 3 components of the map: the service cannot be degraded until you lower it.')
    // non è colpa di chi guarda: lo stato non dice «Campi da correggere»
    expect(status()).toHaveTextContent('Nothing to save')
    expect(screen.getByLabelText('Minimum components')).toHaveAccessibleDescription(/saved minimum of components/)
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()

    await user.click(within(row).getByRole('button', { name: 'Set the minimum to 3' }))
    expect(screen.getByLabelText('Minimum components')).toHaveValue(3)
    expect(screen.queryByTestId('rules-saved-stale')).not.toBeInTheDocument()
    expect(status()).toHaveTextContent('Unsaved changes')
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
  })

  it('admin: minimo di componenti oltre i componenti della mappa → detto in pagina, salvataggio bloccato', async () => {
    const { user } = renderCard(true)
    const minNodes = await screen.findByLabelText('Minimum components')
    expect(minNodes).toHaveAttribute('max', '4')   // la mappa ha 4 componenti
    await user.clear(minNodes)
    await user.type(minNodes, '9')
    expect(await screen.findByText('At most 4: the map has that many components, and a higher minimum would keep the service from ever being degraded.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('D6.4: selettore «Durante una tempesta della sorgente» — sospendi di default, l\'aiuto spiega perché, il valore scelto si salva', async () => {
    const seen: unknown[] = []
    const save: GqlMock = {
      request: { query: UPDATE_SERVICE_IMPACT_RULES, variables: (v) => { seen.push(v); return true } },
      result: { data: { updateServiceImpactRules: mapDetail({ version: 4, rules: { ...RULES, version: 2, duringStorm: 'evaluate' } }) } },
    }
    const { user } = renderCard(true, { extra: [save] })
    const select = await screen.findByLabelText('During a source storm')
    expect(select).toHaveValue('hold')
    expect(within(select).getByRole('option', { name: 'Hold the evaluation' })).toBeInTheDocument()
    expect(within(select).getByRole('option', { name: 'Evaluate anyway' })).toBeInTheDocument()
    expect(select).toHaveAccessibleDescription(/almost always a monitoring or collection failure.*that is why the default is to hold/)

    await user.selectOptions(select, 'evaluate')
    expect(status()).toHaveTextContent('Unsaved changes')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(seen).toEqual([{
      id: 'map-1', expectedVersion: 3,
      rules: { downSharePct: 50, degradedSharePct: 1, minNodes: 1, unknownNodes: 'ignore', openIncidentFrom: 'down', duringStorm: 'evaluate' },
    }]))
  })

  it('D6.4: senza permessi la regola della tempesta è nella lista in parole, e un valore fuori vocabolario è detto in chiaro', async () => {
    const { unmount } = renderCard(false)
    expect(await screen.findByText('During a source storm: evaluation held')).toBeInTheDocument()
    unmount()

    renderCard(false, { map: detail({ rules: { ...RULES, duringStorm: 'panic' } }) })
    expect(await screen.findByText('During a source storm: Unknown (panic)')).toBeInTheDocument()
  })

  it('un valore salvato fuori vocabolario resta scelto e detto in chiaro, non corretto di nascosto', async () => {
    renderCard(true, { map: detail({ rules: { ...RULES, unknownNodes: 'weird' } }) })
    const select = await screen.findByLabelText('Components without health')
    expect(select).toHaveValue('weird')
    expect(within(select).getByRole('option', { name: 'Unknown (weird)' })).toBeInTheDocument()
  })
})
