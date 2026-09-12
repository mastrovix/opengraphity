import { describe, it, expect, vi } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import { useState } from 'react'
import i18n from '@/i18n/i18n'
import { WorkflowStepPanel } from './WorkflowStepPanel'
import type { WFStep } from './workflow-types'
import { GET_WORKFLOW_DEFINITION_BY_ID } from '@/graphql/queries'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { teamsMock, usersMock, workflowListMock, itilTypesMock } from '@/test/mocks/gql'
import { NOTIFICATION_TARGETS, WORKFLOW_STEP_PURPOSES, WORKFLOW_STEP_CATEGORIES } from '@opengraphity/types'
import { TARGET_OPTIONS } from '@/pages/settings/NotificationRuleList'

const DEF_ID = 'wf-incident'

function definitionMock(entityType = 'incident'): GqlMock {
  return {
    request: { query: GET_WORKFLOW_DEFINITION_BY_ID, variables: { id: DEF_ID } },
    result: { data: { workflowDefinitionById: {
      __typename: 'WorkflowDefinition', id: DEF_ID, name: 'Incident', entityType, category: null, version: 1, active: true,
      steps: [], transitions: [],
    } } },
    maxUsageCount: Number.POSITIVE_INFINITY,
  }
}

function step(overrides: Partial<WFStep> = {}): WFStep {
  return { id: 's-1', name: 'new', label: 'New', type: 'start', enterActions: null, exitActions: null, isInitial: true, isTerminal: false, ...overrides }
}

const baseMocks = () => [definitionMock(), itilTypesMock(), teamsMock(), usersMock([]), workflowListMock()]

function renderPanel(s: WFStep, extra: { onSaved?: () => void; onSaveLocally?: () => void } = {}) {
  const onSaved = extra.onSaved ?? vi.fn()
  return renderWithProviders(
    <WorkflowStepPanel step={s} definitionId={DEF_ID} onClose={() => {}} onSaved={onSaved} onSaveLocally={extra.onSaveLocally} />,
    { mocks: baseMocks() },
  )
}

const saveButton = () => screen.getByRole('button', { name: 'Salva' })
const T = (key: string, opts?: Record<string, unknown>) => i18n.t(key, opts) as string
/** Opzione mostrata da ConditionRowEditor per un operatore persistito che l'editor non conosce. */
const unsupportedOption = (op: string) => `?${op} (${T('conditionEditor.unsupported')})`

describe('WorkflowStepPanel — proprietà', () => {
  it('mostra label, name e type dello step; Salva è disabilitato finché nulla cambia', () => {
    renderPanel(step())
    expect(screen.getByDisplayValue('New')).toBeInTheDocument()
    expect(screen.getByText('new')).toBeInTheDocument()
    expect(screen.getByText('start')).toBeInTheDocument()
    expect(saveButton()).toBeDisabled()
  })

  it('modificare la label abilita Salva e onSaved/onSaveLocally ricevono i nuovi valori', async () => {
    const onSaved = vi.fn(); const onSaveLocally = vi.fn()
    const { user } = renderPanel(step(), { onSaved, onSaveLocally })
    const label = screen.getByDisplayValue('New')
    await user.clear(label)
    await user.type(label, 'Nuovo')
    expect(saveButton()).toBeEnabled()
    await user.click(saveButton())
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ label: 'Nuovo', enterActions: null, exitActions: null, isInitial: true, isTerminal: false, isOpen: true, category: null }))
    expect(onSaveLocally).toHaveBeenCalledWith(expect.objectContaining({ stepName: 'new', label: 'Nuovo' }))
  })

  it('le azioni persistite sono elencate come badge', () => {
    renderPanel(step({ enterActions: JSON.stringify([{ type: 'sla_start', params: { sla_type: 'response' } }]), exitActions: JSON.stringify([{ type: 'sla_stop', params: { sla_type: 'resolve' } }]) }))
    expect(screen.getByTitle('sla_start')).toBeInTheDocument()
    expect(screen.getByTitle('sla_stop')).toBeInTheDocument()
  })
})

describe('WorkflowStepPanel — azioni corrotte (fail-loud)', () => {
  it('JSON non valido in enter_actions → banner di errore e Salva disabilitato anche cambiando la label', async () => {
    const { user } = renderPanel(step({ enterActions: '{not json' }))
    const alert = screen.getAllByRole('alert').find((a) => a.textContent?.includes('Azioni dello step corrotte'))!
    expect(alert).toBeDefined()
    expect(alert).toHaveTextContent(/enter_actions:/)
    expect(alert).toHaveTextContent('new')   // nome dello step da correggere
    expect(saveButton()).toBeDisabled()

    const label = screen.getByDisplayValue('New')
    await user.type(label, ' X')
    expect(saveButton()).toBeDisabled()
  })

  it('JSON valido ma non array → stesso banner con il tipo trovato', () => {
    renderPanel(step({ exitActions: '{"type":"sla_stop"}' }))
    const alert = screen.getAllByRole('alert').find((a) => a.textContent?.includes('Azioni dello step corrotte'))!
    expect(alert).toHaveTextContent('exit_actions: atteso un array JSON, trovato object')
    expect(saveButton()).toBeDisabled()
  })

  it('senza azioni corrotte nessun banner', () => {
    renderPanel(step({ enterActions: '[]' }))
    expect(screen.queryByText(/Azioni dello step corrotte/)).not.toBeInTheDocument()
  })
})

describe('WorkflowStepPanel — operatore persistito non supportato', () => {
  const withGte = () => step({
    enterActions: JSON.stringify([{
      type: 'update_field', params: { field: 'severity', value: 'high' },
      conditions: [{ field: 'reopen_count', operator: 'gte', value: '3' }], conditions_logic: 'AND',
    }]),
  })

  it('aprendo l\'azione: opzione "?gte (unsupported)" selezionata e rossa, Aggiorna disabilitato con messaggio', async () => {
    const { user } = renderPanel(withGte())
    await user.click(screen.getByTitle('update_field').closest('button')!)

    const operatorSelect = await screen.findByDisplayValue(unsupportedOption('gte'))
    // stile "rotto": bordo e testo rossi (shorthand border-color: confronto sull'attributo, jsdom non lo espande)
    expect(operatorSelect.getAttribute('style')).toContain('border-color: var(--color-danger)')
    expect(operatorSelect.style.color).toBe('var(--color-danger)')
    expect(operatorSelect).toHaveAttribute('title', T('conditionEditor.unknownOperator', { operator: 'gte' }))

    expect(screen.getByRole('button', { name: 'Aggiorna' })).toBeDisabled()
    expect(screen.getByText('[automationOperators] operatore UI non mappabile su workflow: "gte"')).toBeInTheDocument()
  })

  it('scegliendo un operatore supportato Aggiorna si riabilita e l\'azione viene riscritta con "gt"', async () => {
    const onSaved = vi.fn()
    const { user } = renderPanel(withGte(), { onSaved })
    await user.click(screen.getByTitle('update_field').closest('button')!)
    const operatorSelect = await screen.findByDisplayValue(unsupportedOption('gte'))
    await user.selectOptions(operatorSelect, 'greater_than')
    expect(screen.queryByText(/non mappabile/)).not.toBeInTheDocument()
    const update = screen.getByRole('button', { name: 'Aggiorna' })
    expect(update).toBeEnabled()
    await user.click(update)

    expect(saveButton()).toBeEnabled()
    await user.click(saveButton())
    const saved = onSaved.mock.calls[0]![0] as { enterActions: string }
    expect(JSON.parse(saved.enterActions)).toEqual([{
      type: 'update_field', params: { field: 'severity', value: 'high' },
      conditions: [{ field: 'reopen_count', operator: 'gt', value: '3' }], conditions_logic: 'AND',
    }])
  })

  it('nuova azione: Conferma è disabilitato finché una condizione ha operatore non mappabile', async () => {
    const { user } = renderPanel(step())
    const enterField = screen.getByText('Enter Actions').parentElement!
    await user.click(within(enterField).getByRole('button', { name: '+ Add action' }))
    await user.click(await screen.findByRole('button', { name: '+ Aggiungi condizione' }))
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeEnabled()   // riga vuota: scartata, non bloccante
    // attende il metamodello (campi) e imposta campo + operatore valido
    const fieldSelect = await screen.findByDisplayValue(T('conditionEditor.fieldPlaceholder'))
    await waitFor(() => expect(within(fieldSelect).getByText(/severity/)).toBeInTheDocument())
    await user.selectOptions(fieldSelect, 'severity')
    await user.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(screen.getByTitle('sla_start')).toBeInTheDocument()   // azione di default aggiunta
  })
})

/**
 * D-13/A0-2 — la notifica all'ingresso nel passo offriva una SECONDA lista di
 * destinatari scritta a mano, con `role:manager`: un ruolo che
 * l'autenticazione non conosce. Da quando il dispatcher risolve davvero il
 * bersaglio, quel valore non è più ignorato — fa fallire il job di notifica a
 * ogni ingresso nel passo. Qui i destinatari sono il vocabolario condiviso.
 */
describe('WorkflowStepPanel — destinatari della notifica all\'ingresso', () => {
  it('offre i destinatari del vocabolario condiviso, tradotti, e nessun role:manager', async () => {
    const { user } = renderPanel(step())
    await user.click(screen.getByRole('tab', { name: 'Notifiche' }))
    await user.click(screen.getByRole('switch', { name: 'Notifica all\'ingresso' }))

    // nella scheda Notifiche ci sono due tendine: Severità e Destinatari
    const select = screen.getAllByRole('combobox')[1]!
    const options = within(select).getAllByRole('option') as HTMLOptionElement[]
    expect(options.map((o) => o.value)).toEqual([...NOTIFICATION_TARGETS])
    expect(options.map((o) => o.value)).not.toContain('role:manager')
    expect(options.map((o) => o.textContent)).toEqual(TARGET_OPTIONS.map(({ labelKey }) => T(labelKey)))
  })
})

/**
 * Ondata 2 — B2-2 (B-1): «Elimina step» non si offre quando romperebbe dei
 * ticket. Prima il bottone c'era sempre (tranne sullo step iniziale) e il
 * server cancellava il passo insieme al `CURRENT_STEP` delle istanze sopra.
 */
describe('WorkflowStepPanel — eliminazione dello step', () => {
  const renderWithDelete = (s: WFStep, onDelete = vi.fn()) => ({
    onDelete,
    ...renderWithProviders(
      <WorkflowStepPanel step={s} definitionId={DEF_ID} onClose={() => {}} onSaved={() => {}} onDelete={onDelete} />,
      { mocks: baseMocks() },
    ),
  })
  const deleteButton = () => screen.queryByRole('button', { name: 'Elimina step' })

  it('step di fabbrica start/end → niente bottone (il server li protegge per `type`)', () => {
    renderWithDelete(step({ name: 'closed', type: 'end', isInitial: false, isTerminal: true, currentInstances: 0 }))
    expect(deleteButton()).not.toBeInTheDocument()
    expect(screen.getByRole('note')).toHaveTextContent(T('workflow.deleteBlockedFactory'))
  })

  it('nessuna istanza sul passo → il bottone c\'è', () => {
    renderWithDelete(step({ name: 'pending', type: 'standard', isInitial: false, currentInstances: 0 }))
    expect(deleteButton()).toBeInTheDocument()
  })

  it('istanze sul passo → niente bottone, ma il motivo con il numero', () => {
    renderWithDelete(step({ name: 'assigned', type: 'standard', isInitial: false, currentInstances: 148 }))
    expect(deleteButton()).not.toBeInTheDocument()
    const note = screen.getByRole('note')
    expect(note).toHaveTextContent(T('workflow.deleteBlockedInstances', { count: 148 }))
    expect(note).toHaveTextContent('148')
  })

  it('passo marcato iniziale (anche se `standard`) → niente bottone, e il motivo è quello giusto', () => {
    renderWithDelete(step({ name: 'assigned', type: 'standard', isInitial: true, currentInstances: 0 }))
    expect(deleteButton()).not.toBeInTheDocument()
    expect(screen.getByRole('note')).toHaveTextContent(T('workflow.deleteBlockedInitial'))
  })

  it('togliere la spunta «Step iniziale» senza salvare NON abilita l\'eliminazione', async () => {
    const { user } = renderWithDelete(step({ name: 'assigned', type: 'standard', isInitial: true, currentInstances: 0 }))
    await user.click(screen.getByRole('tab', { name: 'Metadati' }))
    await user.click(screen.getByRole('checkbox', { name: /Il processo parte da questo step/ }))
    expect(deleteButton()).not.toBeInTheDocument()
  })
})

/** Ondata 2 — B2-3 (B-8): iniziale e terminale non stanno insieme. */
describe('WorkflowStepPanel — step iniziale e terminale insieme', () => {
  it('spuntare «iniziale» su uno step terminale → avviso e Salva disabilitato', async () => {
    const { user } = renderPanel(step({ name: 'closed', type: 'standard', isInitial: false, isTerminal: true, isOpen: false }))
    await user.click(screen.getByRole('tab', { name: 'Metadati' }))
    await user.click(screen.getByRole('checkbox', { name: /Il processo parte da questo step/ }))
    const alert = screen.getAllByRole('alert').find((a) => a.textContent?.includes(T('workflow.initialOnTerminal')))
    expect(alert).toBeDefined()
    expect(saveButton()).toBeDisabled()
  })

  it('togliendo «terminale» l\'avviso sparisce e si può salvare', async () => {
    const { user } = renderPanel(step({ name: 'closed', type: 'standard', isInitial: false, isTerminal: true, isOpen: false }))
    await user.click(screen.getByRole('tab', { name: 'Metadati' }))
    await user.click(screen.getByRole('checkbox', { name: /Il processo parte da questo step/ }))
    await user.click(screen.getByRole('checkbox', { name: /Il processo è chiuso quando arriva qui/ }))
    expect(screen.queryByText(T('workflow.initialOnTerminal'))).not.toBeInTheDocument()
    expect(saveButton()).toBeEnabled()
  })
})

describe('WorkflowStepPanel — cambio step selezionato (F-01)', () => {
  const A = step({ id: 's-a', name: 'a', label: 'Step A' })
  const B = step({ id: 's-b', name: 'b', label: 'Step B', isInitial: false, type: 'standard' })

  function Designer({ keyed }: { keyed: boolean }) {
    const [selected, setSelected] = useState<WFStep>(A)
    return (
      <>
        <button type="button" onClick={() => setSelected(B)}>select B</button>
        <WorkflowStepPanel key={keyed ? selected.id : undefined} step={selected} definitionId={DEF_ID} onClose={() => {}} onSaved={() => {}} />
      </>
    )
  }

  it('con key={step.id} (come nel designer) il pannello mostra i dati del nuovo step', async () => {
    const { user } = renderWithProviders(<Designer keyed />, { mocks: baseMocks() })
    expect(screen.getByDisplayValue('Step A')).toBeInTheDocument()
    await user.click(screen.getByText('select B'))
    expect(screen.getByDisplayValue('Step B')).toBeInTheDocument()
    expect(screen.queryByDisplayValue('Step A')).not.toBeInTheDocument()
    expect(screen.getByText('b')).toBeInTheDocument()
  })

  it('senza key lo stato locale resterebbe quello del vecchio step (motivo del key nel designer)', async () => {
    const { user } = renderWithProviders(<Designer keyed={false} />, { mocks: baseMocks() })
    await user.click(screen.getByText('select B'))
    expect(screen.getByText('b')).toBeInTheDocument()            // le prop passano…
    expect(screen.getByDisplayValue('Step A')).toBeInTheDocument()  // …ma la label editabile è stantia
  })
})

/**
 * Ondata 4 — B4-3: lo SCOPO del passo si assegna dal pannello.
 *
 * Lo scopo è quello che le regole di dominio riconoscono (approvazioni,
 * finestra di rilascio, sincronizzazione con i problem, notifiche): è il
 * motivo per cui un passo rinominato continua a funzionare. Il vocabolario è
 * chiuso e arriva da @opengraphity/types — la stessa lista che il server
 * valida in scrittura — e «nessuno scopo» è una scelta legittima: il pannello
 * non ne inventa uno dal nome del passo.
 */
describe('WorkflowStepPanel — lo scopo del passo (B4-3)', () => {
  const openMetadata = async (s: WFStep) => {
    const r = renderPanel(s)
    await r.user.click(screen.getByRole('tab', { name: 'Metadati' }))
    return r
  }
  it('offre tutti e 11 gli scopi tradotti, più «nessuno», e una riga che spiega cosa cambia', async () => {
    await openMetadata(step({ name: 'deployment', type: 'standard', isInitial: false }))
    const select = screen.getByDisplayValue(T('workflow.purposeNone')) as HTMLSelectElement
    const values = [...select.options].map((o) => o.value)
    expect(values).toEqual(['', ...WORKFLOW_STEP_PURPOSES])
    // ogni opzione ha un'etichetta tradotta, non la chiave i18n
    for (const p of WORKFLOW_STEP_PURPOSES) {
      const label = T(`workflow.purposeOption.${p}`)
      expect(label).not.toContain('workflow.purposeOption')
      expect([...select.options].map((o) => o.textContent)).toContain(label)
    }
    expect(screen.getByText(T('workflow.purposeHint'))).toBeInTheDocument()
  })

  it('mostra lo scopo già salvato e salvarne uno nuovo lo manda al server', async () => {
    const onSaved = vi.fn(); const onSaveLocally = vi.fn()
    const s = step({ name: 'deployment', label: 'Rilascio', type: 'standard', isInitial: false, purpose: 'planning' })
    const r = renderWithProviders(
      <WorkflowStepPanel step={s} definitionId={DEF_ID} onClose={() => {}} onSaved={onSaved} onSaveLocally={onSaveLocally} />,
      { mocks: baseMocks() },
    )
    await r.user.click(screen.getByRole('tab', { name: 'Metadati' }))
    const select = screen.getByDisplayValue(T('workflow.purposeOption.planning')) as HTMLSelectElement
    expect(saveButton()).toBeDisabled()

    await r.user.selectOptions(select, 'implementation')
    expect(saveButton()).toBeEnabled()
    await r.user.click(saveButton())

    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'implementation' }))
    // al server la stringa: '' vorrebbe dire «togli», qui è uno scopo vero
    expect(onSaveLocally).toHaveBeenCalledWith(expect.objectContaining({ stepName: 'deployment', purpose: 'implementation' }))
  })

  it('«nessuno» è salvabile e viaggia come stringa vuota: togliere lo scopo è reversibile', async () => {
    const onSaved = vi.fn(); const onSaveLocally = vi.fn()
    const s = step({ name: 'deployment', type: 'standard', isInitial: false, purpose: 'implementation' })
    const r = renderWithProviders(
      <WorkflowStepPanel step={s} definitionId={DEF_ID} onClose={() => {}} onSaved={onSaved} onSaveLocally={onSaveLocally} />,
      { mocks: baseMocks() },
    )
    await r.user.click(screen.getByRole('tab', { name: 'Metadati' }))
    await r.user.selectOptions(screen.getByDisplayValue(T('workflow.purposeOption.implementation')), '')
    await r.user.click(saveButton())

    expect(onSaveLocally).toHaveBeenCalledWith(expect.objectContaining({ purpose: '' }))
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ purpose: null }))
  })

  it('un passo senza scopo resta senza scopo: nessuno viene indovinato dal nome', async () => {
    const onSaveLocally = vi.fn()
    // il nome è quello di fabbrica della finestra di rilascio: se il pannello
    // indovinasse dal nome, qui comparirebbe «implementation».
    const s = step({ name: 'deployment', label: 'Rilascio', type: 'standard', isInitial: false, purpose: null })
    const r = renderWithProviders(
      <WorkflowStepPanel step={s} definitionId={DEF_ID} onClose={() => {}} onSaved={() => {}} onSaveLocally={onSaveLocally} />,
      { mocks: baseMocks() },
    )
    await r.user.click(screen.getByRole('tab', { name: 'Metadati' }))
    expect((screen.getByDisplayValue(T('workflow.purposeNone')) as HTMLSelectElement).value).toBe('')
    expect(saveButton()).toBeDisabled()
  })
})

/**
 * Revisione delle otto ondate · B·N-3 — la **categoria** del passo.
 *
 * Era un `<Input list=…>` con una `datalist` di SUGGERIMENTI, mentre da questa
 * categoria dipendono «risolto» (che valorizza `resolved_at` e `root_cause`),
 * la chiusura automatica, l'escalation e le classi di stato delle liste. Un
 * campo di testo in un'interfaccia italiana che invita a scrivere una parola
 * inglese è la trappola perfetta: dal vivo `category = 'risolto'` veniva
 * accettata, la transizione riusciva e il ticket restava senza data di
 * risoluzione — risolto per l'utente, mai risolto per i dati.
 */
describe('WorkflowStepPanel — la categoria è un vocabolario chiuso (B·N-3)', () => {
  const openMetadata = async (s: WFStep) => {
    const r = renderPanel(s)
    await r.user.click(screen.getByRole('tab', { name: 'Metadati' }))
    return r
  }

  it('è una tendina con le otto categorie tradotte, non un campo di testo', async () => {
    await openMetadata(step({ name: 'resolved', type: 'standard', isInitial: false }))
    const select = screen.getByDisplayValue(T('workflow.categoryNone')) as HTMLSelectElement
    expect(select.tagName).toBe('SELECT')
    expect([...select.options].map((o) => o.value)).toEqual(['', ...WORKFLOW_STEP_CATEGORIES])
    for (const c of WORKFLOW_STEP_CATEGORIES) {
      const label = T(`workflow.categoryOption.${c}`)
      expect(label).not.toContain('workflow.categoryOption')
      expect([...select.options].map((o) => o.textContent)).toContain(label)
    }
    expect(screen.getByText(T('workflow.categoryHint'))).toBeInTheDocument()
  })

  it('la categoria salvata si vede, e cambiarla manda il valore del vocabolario', async () => {
    const onSaved = vi.fn(); const onSaveLocally = vi.fn()
    const s = step({ name: 'risolto', label: 'Risolto', type: 'standard', isInitial: false, category: 'active' })
    const r = renderWithProviders(
      <WorkflowStepPanel step={s} definitionId={DEF_ID} onClose={() => {}} onSaved={onSaved} onSaveLocally={onSaveLocally} />,
      { mocks: baseMocks() },
    )
    await r.user.click(screen.getByRole('tab', { name: 'Metadati' }))
    const select = screen.getByDisplayValue(T('workflow.categoryOption.active')) as HTMLSelectElement
    expect(saveButton()).toBeDisabled()

    await r.user.selectOptions(select, 'resolved')
    expect(saveButton()).toBeEnabled()
    await r.user.click(saveButton())

    expect(onSaveLocally).toHaveBeenCalledWith(expect.objectContaining({ stepName: 'risolto', category: 'resolved' }))
  })
})
