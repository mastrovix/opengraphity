/**
 * DYNAMIC GROUP CRITERIA: what decides which CIs belong to a group.
 *
 * An administrator picks CI types, an environment, a status and a name
 * filter, sees how many CIs would match, and saves. If these regress, a group
 * silently collects the wrong members (or none): the preview lies about the
 * count, the save sends criteria the API ignores, or the Save button lets the
 * user "save" nothing. The criteria travel inside `customFields` because they
 * are not base fields of `UpdateCIFieldsInput` — sending them as top-level
 * keys made Apollo reject the whole request, so "Save criteria" never saved.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const { GroupCriteriaBuilder } = await import('./GroupCriteriaBuilder')

const BASE_TYPE = {
  baseCIType: {
    fields: [
      { name: 'status', fieldType: 'enum', enumValues: ['active', 'retired'] },
      { name: 'environment', fieldType: 'enum', enumValues: ['production', 'staging'] },
    ],
  },
}

const EMPTY = { ciTypes: '', environment: '', status: '', nameContains: '' }

// Restores the console spies some tests install.
afterEach(() => { vi.restoreAllMocks() })

beforeEach(() => {
  apolloFinto.reset()
  toast.success.mockReset()
  toast.error.mockReset()
  apolloFinto.risposte['GetBaseCIType'] = BASE_TYPE
  apolloFinto.risposte['GroupCriteriaPreview'] = { allCIs: { total: 7 } }
})

const mount = (criteria = EMPTY, onSaved = vi.fn()) => ({
  onSaved,
  ...renderWithProviders(<GroupCriteriaBuilder groupId="g1" criteria={criteria} onSaved={onSaved} />),
})

describe('GroupCriteriaBuilder', () => {
  it('offers every active CI type except groups, and with none picked says all types match', () => {
    mount()
    expect(screen.getByRole('button', { name: 'Server' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Application' })).toBeInTheDocument()
    // A group made of groups is not a membership the backend evaluates.
    expect(screen.queryByRole('button', { name: 'Dynamic CI Group' })).not.toBeInTheDocument()
    expect(screen.getByText('No type selected: all types match')).toBeInTheDocument()
    expect(screen.getByText('→ 7 matching CIs')).toBeInTheDocument()
    // No filter at all → the preview asks with nulls, not empty strings (which would match nothing).
    expect(apolloFinto.chiamata('GroupCriteriaPreview')).toEqual({ ciTypes: null, environment: null, status: null, search: null })
  })

  it('an untouched form cannot be saved', () => {
    mount({ ciTypes: 'server', environment: 'production', status: '', nameContains: 'db' })
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(screen.getByText(/^1 type/)).toBeInTheDocument()
  })

  it('the preview follows the filters, with types as lowercased graph labels', async () => {
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Database Instance' }))
    await user.selectOptions(screen.getByLabelText('Environment'), 'production')
    await user.selectOptions(screen.getByLabelText('Status'), 'active')
    await user.type(screen.getByLabelText('Name contains'), '  web ')
    // allCIs matches Neo4j labels (DatabaseInstance → databaseinstance), and the search is trimmed.
    expect(apolloFinto.chiamata('GroupCriteriaPreview')).toEqual({
      ciTypes: ['databaseinstance'], environment: 'production', status: 'active', search: 'web',
    })
  })

  it('toggling a chip twice returns to the saved state and disables Save again', async () => {
    const { user } = mount({ ...EMPTY, ciTypes: 'server' })
    const server = screen.getByRole('button', { name: 'Server' })
    await user.click(server)
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    await user.click(server)
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('saves the criteria inside customFields and tells the parent to refetch', async () => {
    const { user, onSaved } = mount({ ...EMPTY, ciTypes: 'server' })
    await user.click(screen.getByRole('button', { name: 'Application' }))
    await user.selectOptions(screen.getByLabelText('Environment'), 'staging')
    await user.type(screen.getByLabelText('Name contains'), ' api ')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    const sent = apolloFinto.chiamata('UpdateCI') as { id: string; input: Record<string, string> }
    expect(sent.id).toBe('g1')
    // Only customFields: any other top-level key is rejected by UpdateCIFieldsInput.
    expect(Object.keys(sent.input)).toEqual(['customFields'])
    expect(JSON.parse(sent.input.customFields!)).toEqual({
      criteriaCiTypes: 'server,application', criteriaEnvironment: 'staging', criteriaStatus: '', criteriaNameContains: 'api',
    })
    expect(toast.success).toHaveBeenCalledWith('Criteria saved')
  })

  it('a failed save shows the error, does not report success, and re-enables the button', async () => {
    apolloFinto.esiti['UpdateCI'] = { error: new Error('forbidden') }
    const { user, onSaved } = mount()
    await user.click(screen.getByRole('button', { name: 'Server' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('forbidden'))
    expect(onSaved).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
  })

  it('when the metamodel does not provide the enums, says so instead of offering empty lists silently', () => {
    apolloFinto.risposte['GetBaseCIType'] = { baseCIType: { fields: [] } }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mount()
    expect(screen.getByText(/Status\/environment values unavailable from the metamodel/)).toBeInTheDocument()
  })

  it('without a preview answer the count reads zero', () => {
    apolloFinto.risposte['GroupCriteriaPreview'] = undefined
    mount()
    expect(screen.getByText('→ 0 matching CIs')).toBeInTheDocument()
  })
})
