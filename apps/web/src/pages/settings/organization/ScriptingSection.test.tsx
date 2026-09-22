/**
 * The tenant's own scripts (field validations, "run script" actions, form
 * formulas) are switched on and off here by an administrator. If this
 * section regresses the switch shows the wrong state, sends the wrong value,
 * or a failed save looks like a success — and the admin believes formulas
 * run when every request using them is being refused.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { ScriptingSection } from './ScriptingSection'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
const toastSuccess = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: vi.fn() } }))
const showError = vi.hoisted(() => vi.fn())
vi.mock('@/lib/showError', () => ({ showError }))

beforeEach(() => {
  apolloFinto.reset()
  toastSuccess.mockClear()
  showError.mockClear()
})

const CHECKBOX = 'Let this organization run its own scripts'

describe('ScriptingSection', () => {
  it('shows the current state and switching it on sends enabled=true and confirms', async () => {
    apolloFinto.risposte['GetScriptingSettings'] = { scriptingSettings: { enabled: false, plan: 'starter' } }
    apolloFinto.esiti['SetScriptingEnabled'] = { data: { setScriptingEnabled: { enabled: true, plan: 'starter' } } }
    const { user } = renderWithProviders(<ScriptingSection />)
    const box = screen.getByRole('checkbox', { name: new RegExp(CHECKBOX) })
    expect(box).not.toBeChecked()
    await user.click(box)
    expect(apolloFinto.chiamata('SetScriptingEnabled')).toEqual({ enabled: true })
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Scripts setting saved'))
  })

  it('switching it off sends enabled=false', async () => {
    apolloFinto.risposte['GetScriptingSettings'] = { scriptingSettings: { enabled: true, plan: 'enterprise' } }
    const { user } = renderWithProviders(<ScriptingSection />)
    const box = screen.getByRole('checkbox', { name: new RegExp(CHECKBOX) })
    expect(box).toBeChecked()
    await user.click(box)
    expect(apolloFinto.chiamata('SetScriptingEnabled')).toEqual({ enabled: false })
  })

  it('a refused save is shown as an error, never as "saved"', async () => {
    apolloFinto.risposte['GetScriptingSettings'] = { scriptingSettings: { enabled: false, plan: 'starter' } }
    apolloFinto.esiti['SetScriptingEnabled'] = { error: new Error('forbidden') }
    const { user } = renderWithProviders(<ScriptingSection />)
    await user.click(screen.getByRole('checkbox', { name: new RegExp(CHECKBOX) }))
    await waitFor(() => expect(showError).toHaveBeenCalledWith(expect.objectContaining({ message: 'forbidden' })))
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('a failed load says so with a retry, and no switch is offered on unknown state', async () => {
    apolloFinto.erroriQuery['GetScriptingSettings'] = new Error('settings down')
    const { user } = renderWithProviders(<ScriptingSection />)
    expect(screen.getByText(/settings down/)).toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /retry/i }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })
})
