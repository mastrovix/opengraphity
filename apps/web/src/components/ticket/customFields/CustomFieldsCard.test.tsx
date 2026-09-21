/**
 * Verifica «Cosa resta cablato», ondata 4: i campi personalizzati nel dettaglio
 * di un ticket si leggono con le etichette del Dizionario e si modificano sul
 * posto; senza campi del cliente la scheda non c'è.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import type { TFunction } from 'i18next'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { DomainVocabularyContext } from '@/contexts/DomainVocabularyContext'
import { SET_TICKET_CUSTOM_FIELDS } from '@/graphql/mutations'
import { CustomFieldsCard } from './CustomFieldsCard'
import { customFieldDisplay, customFieldsInput, missingCustomFields, type CustomFieldValueView } from './customFields'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() }, Toaster: () => null }))

const LABELS: Record<string, string> = { 'change_outcome/successful': 'Riuscita', 'change_outcome/failed': 'Fallita' }
const labelOf = (vocabulary: string, value: string) => LABELS[`${vocabulary}/${value}`] ?? null
const withVocabulary = (ui: React.ReactElement) => (
  <DomainVocabularyContext.Provider value={{ valuesOf: () => null, labelOf, colorOf: () => null, entriesOf: () => null } as never}>{ui}</DomainVocabularyContext.Provider>
)

const field = (over: Partial<CustomFieldValueView>): CustomFieldValueView => ({
  name: 'x', label: 'X', fieldType: 'string', required: false, enumValues: [], enumTypeName: null, visibleToEndUser: false, value: null, ...over,
})
const FIELDS = [
  field({ name: 'outcome', label: 'Esito', fieldType: 'enum', enumValues: ['successful', 'failed'], enumTypeName: 'change_outcome', required: true, value: 'successful' }),
  field({ name: 'cost_center', label: 'Centro di costo', value: null }),
]

describe('i campi del cliente, le funzioni', () => {
  const t = ((k: string) => ({ 'common.yes': 'Yes', 'common.no': 'No' }[k] ?? k)) as unknown as TFunction
  it('valori letti come li legge una persona', () => {
    expect(customFieldDisplay(FIELDS[0]!, labelOf, t)).toBe('Riuscita')
    expect(customFieldDisplay(field({ fieldType: 'boolean', value: 'true' }), labelOf, t)).toBe('Yes')
    expect(customFieldDisplay(field({ value: null }), labelOf, t)).toBe('—')
  })
  it('obbligatori e forma per l\'API', () => {
    expect(missingCustomFields(FIELDS, { outcome: '' })).toEqual(['outcome'])
    expect(missingCustomFields(FIELDS, { outcome: 'failed' }, { cost_center: { visible: true, required: true } })).toEqual(['cost_center'])
    expect(missingCustomFields(FIELDS, { outcome: 'failed' }, { cost_center: { visible: false, required: true } })).toEqual([])
    expect(customFieldsInput(FIELDS, { outcome: 'failed', cost_center: '  ' })).toEqual([{ name: 'outcome', value: 'failed' }, { name: 'cost_center', value: null }])
  })
})

describe('CustomFieldsCard', () => {
  it('senza campi del cliente la scheda non c\'è', () => {
    renderWithProviders(withVocabulary(<CustomFieldsCard entityType="change" ticketId="chg-1" fields={[]} canEdit />))
    expect(screen.queryByText('Additional fields')).toBeNull()
  })

  it('si legge con le etichette, si modifica e salva con la mutation del dettaglio', async () => {
    const sent: unknown[] = []
    const onSaved = vi.fn()
    const mock: GqlMock = {
      request: { query: SET_TICKET_CUSTOM_FIELDS, variables: (v) => { sent.push(v); return true } },
      result: { data: { setTicketCustomFields: [] } },
    }
    const { user } = renderWithProviders(withVocabulary(<CustomFieldsCard entityType="change" ticketId="chg-1" fields={FIELDS} canEdit onSaved={onSaved} />), { mocks: [mock] })
    expect(screen.getByText('Riuscita')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await user.selectOptions(screen.getByLabelText(/^Esito/), 'Fallita')
    await user.type(screen.getByLabelText('Centro di costo'), 'IT-01')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(sent).toEqual([{ entityType: 'change', id: 'chg-1', values: [{ name: 'outcome', value: 'failed' }, { name: 'cost_center', value: 'IT-01' }] }])
  })

  it('un obbligatorio svuotato non parte: lo dice sul campo', async () => {
    const { user } = renderWithProviders(withVocabulary(<CustomFieldsCard entityType="change" ticketId="chg-1" fields={FIELDS} canEdit />))
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await user.selectOptions(screen.getByLabelText(/^Esito/), '')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Required field')
  })

  it('chi legge e basta non vede Modifica', () => {
    renderWithProviders(withVocabulary(<CustomFieldsCard entityType="change" ticketId="chg-1" fields={FIELDS} canEdit={false} />))
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
  })
})

/** Secondo giro UI del 15 set 2026: in quali fasi un campo si vede e si modifica. */
describe('i campi del cliente e le fasi del workflow', () => {
  it('nel dettaglio: un campo non visibile nella fase non c\'è; uno in sola lettura si legge ma non entra nel modulo', async () => {
    const fields = [
      field({ name: 'outcome', label: 'Esito', fieldType: 'enum', enumValues: ['successful', 'failed'], enumTypeName: 'change_outcome', value: 'failed', visible: true, editable: false }),
      field({ name: 'cost_center', label: 'Centro di costo', value: null, visible: true, editable: true }),
      field({ name: 'lessons', label: 'Lezioni apprese', value: null, visible: false, editable: false }),
    ]
    const { user } = renderWithProviders(withVocabulary(<CustomFieldsCard entityType="change" ticketId="chg-1" fields={fields} canEdit />))
    expect(screen.queryByText('Lezioni apprese')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByLabelText('Centro di costo')).toBeInTheDocument()
    expect(screen.queryByLabelText(/^Esito/)).toBeNull()
    expect(screen.getByText(/not editable in this step/)).toBeInTheDocument()
  })
})

describe('disegnatore: le fasi di tutti i workflow del tipo', () => {
  it('stepChoicesOf unisce le fasi per nome e dice quali stanno solo in alcuni workflow', async () => {
    const { stepChoicesOf } = await import('@/pages/settings/ITILTypeFields')
    const choices = stepChoicesOf([
      { workflow: 'Incident Management', steps: [{ name: 'new', label: 'New' }, { name: 'resolved', label: 'Resolved' }] },
      { workflow: 'Incident — Security', steps: [{ name: 'new', label: 'New' }, { name: 'security_review', label: 'Security review' }, { name: 'resolved', label: 'Resolved' }] },
    ])
    expect(choices).toEqual([
      { name: 'new', label: 'New', only: null },
      { name: 'resolved', label: 'Resolved', only: null },
      { name: 'security_review', label: 'Security review', only: ['Incident — Security'] },
    ])
  })
})
