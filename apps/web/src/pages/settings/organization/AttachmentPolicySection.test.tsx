/**
 * The attachment rules decide what every user of the tenant can upload. The
 * behaviours pinned here are the ones where a regression is invisible until a
 * user hits it:
 * - a failed save must show an error (before G-16 it was an unhandled
 *   rejection and the page looked saved);
 * - the size is validated against the PLATFORM cap before the save is offered;
 * - a failed load shows the error with a retry that really refetches;
 * - Save stays off until something actually changed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import { toast } from 'sonner'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { AttachmentPolicySection } from './AttachmentPolicySection'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  Toaster: () => null,
}))

const POLICY = { maxSizeMb: 10, extensions: ['pdf'], platformMaxSizeMb: 50, platformExtensions: ['pdf', 'png'], isDefault: false }

beforeEach(() => {
  apolloFinto.reset()
  vi.mocked(toast.success).mockClear()
  vi.mocked(toast.error).mockClear()
  apolloFinto.risposte['GetAttachmentPolicy'] = { attachmentPolicy: POLICY }
})

const sizeInput = () => screen.getByLabelText('Maximum size')
const saveButton = () => screen.getByRole('button', { name: 'Save' })

describe('AttachmentPolicySection', () => {
  it('Save is off until something changes; a new size is saved with the current types', async () => {
    const { user } = renderWithProviders(<AttachmentPolicySection />)
    expect(sizeInput()).toHaveValue(10)
    expect(saveButton()).toBeDisabled()
    await user.clear(sizeInput())
    await user.type(sizeInput(), '25')
    expect(saveButton()).toBeEnabled()
    await user.click(saveButton())
    expect(apolloFinto.chiamata('SetAttachmentPolicy')).toEqual({ input: { maxSizeMb: 25, extensions: ['pdf'] } })
    expect(toast.success).toHaveBeenCalledWith('Attachment rules saved')
  })

  it('a size above the platform cap (or not a whole number) blocks the save with a hint', async () => {
    const { user } = renderWithProviders(<AttachmentPolicySection />)
    await user.clear(sizeInput())
    await user.type(sizeInput(), '51')
    expect(screen.getByText('The size must be a whole number of MB between 1 and 50.')).toBeInTheDocument()
    expect(saveButton()).toBeDisabled()
    await user.clear(sizeInput())
    await user.type(sizeInput(), '2.5')
    expect(saveButton()).toBeDisabled()
  })

  it('a failed save is shown to the user, not swallowed', async () => {
    apolloFinto.esiti['SetAttachmentPolicy'] = { error: new Error('policy rejected') }
    const { user } = renderWithProviders(<AttachmentPolicySection />)
    await user.click(screen.getByRole('button', { name: '.png' }))
    await user.click(saveButton())
    expect(apolloFinto.chiamata('SetAttachmentPolicy')).toEqual({ input: { maxSizeMb: 10, extensions: ['pdf', 'png'] } })
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('policy rejected'))
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('a failed load shows the error and Retry refetches the policy', async () => {
    delete apolloFinto.risposte['GetAttachmentPolicy']
    apolloFinto.erroriQuery['GetAttachmentPolicy'] = new Error('store offline')
    const { user } = renderWithProviders(<AttachmentPolicySection />)
    expect(screen.getByText('store offline')).toBeInTheDocument()
    // Without data there is nothing to edit: no half-filled form.
    expect(screen.queryByLabelText('Maximum size')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /retry/i }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })
})
