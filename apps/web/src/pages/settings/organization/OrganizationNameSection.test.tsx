/**
 * «Organization name» on the Organization page (verifica «Cosa resta
 * cablato», ondata 6: before it, the name could be changed only from the
 * command line). What an administrator loses if this regresses:
 *  - the field must start from the SAVED name, and Save must stay disabled
 *    until there is a real change (otherwise a click re-saves the same value);
 *  - the name is sent trimmed, and an empty or blank name is refused with a
 *    visible reason instead of a disabled button with no explanation;
 *  - a failed save must be SAID (G-16: without `onError` the rejection was
 *    unhandled and the page looked saved), a successful one confirmed;
 *  - a failed load shows the error with a retry, and the empty field it
 *    leaves behind cannot be saved (it would overwrite the name with a blank).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { OrganizationNameSection } from './OrganizationNameSection'
import { GET_TENANT_NAME } from '@/graphql/queries'
import { SET_TENANT_NAME } from '@/graphql/mutations'
import { renderWithProviders, type GqlMock } from '@/test/utils'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }))
beforeEach(() => { vi.mocked(toast.success).mockClear(); vi.mocked(toast.error).mockClear() })

const nameMock = (tenantName: string): GqlMock => ({
  request: { query: GET_TENANT_NAME },
  result: { data: { tenantName } },
  maxUsageCount: Number.POSITIVE_INFINITY,
})

const saveButton = () => screen.getByRole('button', { name: 'Save' })

describe('OrganizationNameSection', () => {
  it('starts from the saved name with Save disabled: nothing changed, nothing to save', async () => {
    renderWithProviders(<OrganizationNameSection />, { mocks: [nameMock('Acme Corp')] })
    expect(await screen.findByDisplayValue('Acme Corp')).toBeInTheDocument()
    expect(saveButton()).toBeDisabled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('the same name with extra spaces is not a change', async () => {
    const { user } = renderWithProviders(<OrganizationNameSection />, { mocks: [nameMock('Acme Corp')] })
    const input = await screen.findByLabelText('Name')
    await user.type(input, '   ')
    expect(saveButton()).toBeDisabled()
  })

  it('a blank name is refused with the reason shown, and cannot be saved', async () => {
    const { user } = renderWithProviders(<OrganizationNameSection />, { mocks: [nameMock('Acme Corp')] })
    const input = await screen.findByLabelText('Name')
    await user.clear(input)
    await user.type(input, '   ')
    expect(screen.getByRole('alert')).toHaveTextContent('The name must have 1 to 120 characters.')
    expect(saveButton()).toBeDisabled()
  })

  it('saves the TRIMMED name and confirms it', async () => {
    const seen: unknown[] = []
    const save: GqlMock = {
      request: { query: SET_TENANT_NAME, variables: (v) => { seen.push(v); return true } },
      result: { data: { setTenantName: 'Acme Group' } },
    }
    const { user } = renderWithProviders(<OrganizationNameSection />, { mocks: [nameMock('Acme Corp'), save] })
    const input = await screen.findByLabelText('Name')
    await user.clear(input)
    await user.type(input, '  Acme Group  ')
    await user.click(saveButton())
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Organization name saved'))
    // The stored name must not carry the spaces typed around it.
    expect(seen).toEqual([{ name: 'Acme Group' }])
  })

  it('a failed save is shown to the user, not swallowed', async () => {
    const save: GqlMock = {
      request: { query: SET_TENANT_NAME, variables: { name: 'Acme Group' } },
      error: new Error('name rejected by the server'),
    }
    const { user } = renderWithProviders(<OrganizationNameSection />, { mocks: [nameMock('Acme Corp'), save] })
    const input = await screen.findByLabelText('Name')
    await user.clear(input)
    await user.type(input, 'Acme Group')
    await user.click(saveButton())
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('name rejected by the server'))
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('a failed load shows the error with a retry that reads the name again', async () => {
    const failing: GqlMock = { request: { query: GET_TENANT_NAME }, error: new Error('tenant service down') }
    const { user } = renderWithProviders(<OrganizationNameSection />, { mocks: [failing, nameMock('Acme Corp')] })
    expect(await screen.findByText('tenant service down')).toBeInTheDocument()
    // The field is empty but cannot be saved: a failed read must not become a blank name.
    expect(saveButton()).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByDisplayValue('Acme Corp')).toBeInTheDocument()
    expect(screen.queryByText('tenant service down')).not.toBeInTheDocument()
  })
})
