/**
 * EDITING A CI WHOSE FIELDS ARE EMPTY.
 *
 * Many CIs arrive from an import with no status, environment, description or
 * type fields. Editing one must start from EMPTY boxes — not from the word
 * «null» — and saving without typing anything must send nothing: an empty
 * box is the same as «not set», and writing empty strings over missing
 * values would make every imported CI look edited, with no one having
 * changed it. Something typed into an empty field is sent as a change.
 *
 * `CIDetailPage.test.tsx` and `.more.test.tsx` cover the rest of the page; the
 * heavy children are stubs here as they are there.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { MetamodelContext, type CITypeDef, type CIFieldDef } from '@/contexts/MetamodelContext'
import { CIDetailPage } from './CIDetailPage'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }, Toaster: () => null }))
vi.mock('@/components/CIGraph', () => ({ CIGraph: () => null }))
vi.mock('@/components/CIIncidentsCard', () => ({ CIIncidentsCard: () => null }))
vi.mock('@/components/CIChangeList', () => ({ CIChangeList: () => null }))
vi.mock('@/components/AttachmentsSection', () => ({ AttachmentsSection: () => null }))
vi.mock('./CIHealthSection', () => ({ CIHealthSection: () => null }))
vi.mock('./CIServicesSection', () => ({ CIServicesSection: () => null }))
vi.mock('./GroupCriteriaBuilder', () => ({ GroupCriteriaBuilder: () => null }))

const field = (name: string, label: string, over: Partial<CIFieldDef> = {}): CIFieldDef => ({
  id: `f-${name}`, name, label, fieldType: 'string', required: false, enumValues: [], order: 1,
  isSystem: false, validationScript: null, visibilityScript: null, defaultScript: null, ...over,
})
const SERVER: CITypeDef = {
  id: 'ct-server', name: 'server', label: 'Server', icon: 'server', color: '#000', active: true, scope: 'base', tenantId: 'system',
  validationScript: null, chainFamilies: [], serviceRole: null, relations: [], systemRelations: [],
  fields: [
    field('status', 'Status', { fieldType: 'enum', enumValues: ['active', 'retired'], isSystem: true }),
    field('environment', 'Environment', { fieldType: 'enum', enumValues: ['production', 'staging'], isSystem: true }),
    field('ip_address', 'IP address', { order: 2 }),
    field('tier', 'Tier', { fieldType: 'enum', enumValues: ['gold', 'silver'], order: 3 }),
  ],
}

/** A CI as an import leaves it: a name, and nothing else. */
const IMPORTED = {
  id: 'srv-9', name: 'imported-01', type: 'server', status: null, environment: null, description: null, notes: null,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: null, ownerGroup: null, supportGroup: null,
  dependencies: [], dependents: [], ip_address: null, tier: undefined,
}

beforeEach(() => {
  apolloFinto.reset()
  apolloFinto.risposte['DynamicDetail_Server'] = { server: IMPORTED }
})

const show = () => renderWithProviders(
  <MetamodelContext.Provider value={{ ciTypes: [SERVER], loading: false, error: null, getCIType: (n: string) => (n === 'server' ? SERVER : undefined) }}>
    <CIDetailPage />
  </MetamodelContext.Provider>,
  { route: '/ci/server/srv-9', path: '/ci/:typeName/:id' },
)

describe('editing a CI with empty fields', () => {
  it('starts from empty boxes, not from «null»', async () => {
    const { user } = show()
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByLabelText('Name')).toHaveValue('imported-01')
    expect(screen.getByLabelText('Status')).toHaveValue('')
    expect(screen.getByLabelText('Environment')).toHaveValue('')
    expect(screen.getByLabelText('Description')).toHaveValue('')
    expect(screen.getByLabelText('Notes')).toHaveValue('')
    expect(screen.getByLabelText('IP address')).toHaveValue('')
    expect(screen.getByLabelText('Tier')).toHaveValue('')
  })

  it('saving without typing anything sends nothing and leaves the edit mode', async () => {
    const { user } = show()
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(apolloFinto.chiamata('UpdateCI')).toBeUndefined()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument())
  })

  it('what is typed into an empty field is sent as a change, and nothing else', async () => {
    const { user } = show()
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await user.type(screen.getByLabelText('IP address'), '10.0.0.9')
    await user.selectOptions(screen.getByLabelText('Environment'), 'staging')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(apolloFinto.chiamata('UpdateCI')).toEqual({
      id: 'srv-9', input: { environment: 'staging', customFields: JSON.stringify({ ip_address: '10.0.0.9' }) },
    })
  })
})
