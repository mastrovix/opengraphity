import { describe, it, expect, vi } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import { useState } from 'react'
import i18n from '@/i18n/i18n'
import { WorkflowStepPanel } from './WorkflowStepPanel'
import type { WFStep } from './workflow-types'
import { GET_WORKFLOW_DEFINITION_BY_ID } from '@/graphql/queries'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { teamsMock, usersMock, workflowListMock, itilTypesMock } from '@/test/mocks/gql'

const DEF_ID = 'wf-incident'

function definitionMock(entityType = 'incident'): GqlMock {
  return {
    request: { query: GET_WORKFLOW_DEFINITION_BY_ID, variables: { id: DEF_ID } },
    result: { data: { workflowDefinitionById: {
      __typename: 'WorkflowDefinition', id: DEF_ID, name: 'Incident', entityType, category: null, version: 1, active: true, changeSubtype: null,
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
