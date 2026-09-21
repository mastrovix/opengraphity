/**
 * Giro nel browser del 14 set 2026 (#55): creando un CI le tendine mostravano
 * i valori interni («active», «production») mentre la modifica mostra le
 * etichette del Dizionario, e i gruppi non si sceglievano benché `ownerGroup`
 * sia obbligatorio nel metamodello: il CI nasceva senza owner.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import { CIDynamicForm } from './CIDynamicForm'
import type { CITypeDef } from '@/contexts/MetamodelContext'
import { renderWithProviders } from '@/test/utils'
import { baseCITypeMock } from '@/test/mocks/gql'
import { GET_TEAMS } from '@/graphql/queries'

vi.mock('@/lib/ciValidator', () => ({
  validateCI: vi.fn(async () => ({ valid: true, errors: {} })),
  isFieldVisible: vi.fn(async () => true),
  getFieldDefault: vi.fn(async () => null),
}))
vi.mock('@/contexts/DomainVocabularyContext', () => ({
  useDomainVocabularies: () => ({
    labelOf: (vocabulary: string, value: string) => ({ ci_status: { active: 'In esercizio' }, environment: { production: 'Produzione' } } as Record<string, Record<string, string>>)[vocabulary]?.[value] ?? null,
  }),
}))

const baseField = (name: string, enumTypeName: string) => ({
  id: name, name, label: name, fieldType: 'enum', required: false, enumValues: [], enumTypeName, order: 0, isSystem: true,
  validationScript: null, visibilityScript: null, defaultScript: null,
})
const ciType: CITypeDef = {
  id: 'ct-1', name: 'server', label: 'Server', icon: '', color: '', active: true,
  scope: 'base', tenantId: 'system', validationScript: null, chainFamilies: [], serviceRole: null,
  fields: [baseField('status', 'ci_status'), baseField('environment', 'environment')] as CITypeDef['fields'],
  relations: [],
  systemRelations: [
    { id: 'sr1', name: 'ownerGroup',   label: 'Owner Group',   relationshipType: 'OWNED_BY',     targetEntity: 'Team', required: true,  order: 1 },
    { id: 'sr2', name: 'supportGroup', label: 'Support Group', relationshipType: 'SUPPORTED_BY', targetEntity: 'Team', required: false, order: 2 },
  ],
}
const teamsMock = {
  request: { query: GET_TEAMS },
  result: { data: { teams: [{ __typename: 'Team', id: 'team-1', name: 'Rete', description: null, type: null, sourcing: null, createdAt: 'x' }] } },
  maxUsageCount: Number.POSITIVE_INFINITY,
}

describe('CIDynamicForm — creazione', () => {
  it('stato e ambiente con le etichette del Dizionario', async () => {
    renderWithProviders(<CIDynamicForm ciType={ciType} onSubmit={vi.fn()} onCancel={vi.fn()} />, { mocks: [baseCITypeMock(), teamsMock] })
    const status = await screen.findByLabelText('Status')
    await vi.waitFor(() => expect(within(status).getByRole('option', { name: 'In esercizio' })).toHaveValue('active'))
    expect(within(screen.getByLabelText('Environment')).getByRole('option', { name: 'Produzione' })).toHaveValue('production')
  })

  it('il gruppo obbligatorio blocca il salvataggio; scelto, arriva come ownerGroupId', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const { user } = renderWithProviders(<CIDynamicForm ciType={ciType} onSubmit={onSubmit} onCancel={vi.fn()} />, { mocks: [baseCITypeMock(), teamsMock] })
    await user.type(await screen.findByLabelText(/Name/), 'srv-01')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Owner Group is required')).toBeTruthy()
    expect(screen.queryByText('Support Group is required')).toBeNull()
    expect(onSubmit).not.toHaveBeenCalled()

    const owner = screen.getByLabelText(/Owner Group/)
    await vi.waitFor(() => expect(within(owner).getByRole('option', { name: 'Rete' })).toBeTruthy())
    await user.selectOptions(owner, 'team-1')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ name: 'srv-01', ownerGroupId: 'team-1' })
  })
})
