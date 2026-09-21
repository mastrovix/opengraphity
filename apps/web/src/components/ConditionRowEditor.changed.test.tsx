/**
 * Secondo giro UI del 15 set 2026 · V-19: una regola «aggiornato» scattava a
 * ogni modifica finché la condizione era vera. «è cambiato» si offre solo dove
 * ha senso (regole e trigger sugli aggiornamenti), non negli step di workflow.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { itilTypesMock, teamsMock, usersMock } from '@/test/mocks/gql'
import { ConditionRowEditor } from './ConditionRowEditor'

const render = (allowChanged: boolean) => renderWithProviders(
  <ConditionRowEditor condition={{ field: 'severity', operator: 'equals', value: '' }} entityType="incident" onChange={vi.fn()} onRemove={vi.fn()} allowChanged={allowChanged} />,
  { mocks: [itilTypesMock(), teamsMock(), usersMock([])] },
)

describe('ConditionRowEditor · «è cambiato»', () => {
  it('offerto solo con allowChanged', async () => {
    render(true)
    const selects = await screen.findAllByRole('combobox')
    const operator = selects.find((s) => within(s).queryByRole('option', { name: '=' }))!
    expect(within(operator).getByRole('option', { name: 'is changed' })).toBeInTheDocument()
  })
  it('assente altrimenti (step di workflow)', async () => {
    render(false)
    const selects = await screen.findAllByRole('combobox')
    const operator = selects.find((s) => within(s).queryByRole('option', { name: '=' }))!
    expect(within(operator).queryByRole('option', { name: 'is changed' })).toBeNull()
  })
})
