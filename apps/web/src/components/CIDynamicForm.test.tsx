/**
 * CIDynamicForm — ondata 7 · A-13: un valore che il vocabolario del cliente
 * non ha più **si vede**.
 *
 * Prima la `<select>` generava solo le `<option>` degli `enumValues`: un CI con
 * `status = 'expired'` (dal vivo su c-one: 49, più 19 `revoked`) mostrava la
 * tendina **vuota**, e un salvataggio distratto azzerava il campo — silenzioso.
 * Adesso il valore c'è, come opzione disabilitata «non più nel vocabolario»:
 * si vede, si capisce, e lo si cambia di proposito.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { CIDynamicForm } from './CIDynamicForm'
import type { CITypeDef, CIFieldDef } from '@/contexts/MetamodelContext'
import { renderWithProviders } from '@/test/utils'
import { baseCITypeMock } from '@/test/mocks/gql'

const field = (over: Partial<CIFieldDef>): CIFieldDef => ({
  id: 'f1', name: 'lifecycle', label: 'Ciclo di vita', fieldType: 'enum', required: false,
  enumValues: ['active', 'dismesso'], order: 1, isSystem: false,
  validationScript: null, visibilityScript: null, defaultScript: null, ...over,
})

const ciType = (fields: CIFieldDef[]): CITypeDef => ({
  id: 'ct-1', name: 'server', label: 'Server', icon: '', color: '', active: true,
  scope: 'base', tenantId: 'system', validationScript: null, chainFamilies: [], serviceRole: null,
  fields, relations: [], systemRelations: [],
})

function render(initial: Record<string, unknown>) {
  return renderWithProviders(
    <CIDynamicForm
      ciType={ciType([field({})])}
      initialValues={initial}
      onSubmit={vi.fn().mockResolvedValue(undefined)}
      onCancel={vi.fn()}
    />,
    { mocks: [baseCITypeMock()] },
  )
}

describe('CIDynamicForm — campo enum', () => {
  it('valore del vocabolario → selezionato, e nessuna opzione in più', async () => {
    render({ lifecycle: 'dismesso' })
    const select = await screen.findByLabelText(/Ciclo di vita/)
    expect(select).toHaveValue('dismesso')
    expect(screen.queryByRole('option', { name: /non più nel vocabolario/ })).not.toBeInTheDocument()
  })

  it('valore FUORI dal vocabolario → opzione disabilitata «non più nel vocabolario», selezionata: il campo non appare vuoto', async () => {
    render({ lifecycle: 'expired' })
    const select = await screen.findByLabelText(/Ciclo di vita/)
    // Il punto: il valore è ancora quello del CI, non ''.
    expect(select).toHaveValue('expired')
    const orphan = screen.getByRole('option', { name: 'expired — no longer in the vocabulary' })
    expect(orphan).toBeDisabled()
    expect(orphan).toHaveValue('expired')
    // le opzioni del vocabolario ci sono comunque, per correggerlo
    const options = Array.from(select.querySelectorAll('option'))
    expect(options.map((o) => [o.value, o.disabled])).toEqual([
      ['', false], ['expired', true], ['active', false], ['dismesso', false],
    ])
  })

  it('valore assente → nessuna opzione fantasma', async () => {
    render({})
    const select = await screen.findByLabelText(/Ciclo di vita/)
    expect(select).toHaveValue('')
    expect(screen.queryByRole('option', { name: /no longer in the vocabulary/ })).not.toBeInTheDocument()
  })
})
