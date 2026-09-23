/**
 * THE LAST SAFETY NET OF THE APP.
 *
 * `ErrorBoundary` wraps the whole application: when a component crashes while
 * rendering, the user must see a readable screen with the reason and a way to
 * try again — never a white page — and the crash must reach the server log,
 * because nobody reports a white page with a stack trace. These tests pin the
 * screen, the retry, the custom fallback and what is sent to the client
 * logger (with the stacks cut short, so one crash cannot flood the log).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const logger = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }))
vi.mock('@/lib/clientLogger', () => ({ clientLogger: logger }))

const { ErrorBoundary } = await import('./ErrorBoundary')

/** A component that crashes while `state.broken` is true. */
const state = { broken: true, thrown: new Error('The CI list could not be drawn') as unknown }
function Fragile() {
  if (state.broken) throw state.thrown
  return <p>CI list</p>
}

beforeEach(() => {
  state.broken = true
  state.thrown = new Error('The CI list could not be drawn')
  logger.error.mockReset()
  // React reports every caught render error on the console: expected here, and noise.
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('ErrorBoundary', () => {
  it('lets the content through when nothing crashes', () => {
    state.broken = false
    render(<ErrorBoundary><Fragile /></ErrorBoundary>)
    expect(screen.getByText('CI list')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('a crash shows an alert with the reason and a retry, instead of a blank page', () => {
    render(<ErrorBoundary><Fragile /></ErrorBoundary>)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Something went wrong')
    expect(alert).toHaveTextContent('The CI list could not be drawn')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(screen.queryByText('CI list')).not.toBeInTheDocument()
  })

  it('the crash is sent to the server log with its message and both stacks, cut at 500 characters', () => {
    const err = new Error('boom')
    err.stack = `Error: boom\n${'    at somewhere (file.tsx:1:1)\n'.repeat(60)}`
    state.thrown = err
    render(<ErrorBoundary><Fragile /></ErrorBoundary>)
    expect(logger.error).toHaveBeenCalledTimes(1)
    const [message, context] = logger.error.mock.calls[0]! as [string, { stack?: string; componentStack?: string }]
    expect(message).toBe('React error: boom')
    expect(context.stack).toBe(err.stack.slice(0, 500))
    expect(context.stack).toHaveLength(500)
    // The component stack names the component that crashed.
    expect(context.componentStack).toContain('Fragile')
    expect(context.componentStack!.length).toBeLessThanOrEqual(500)
  })

  it('an error without a stack is still logged, with an empty stack rather than a crash of the logger', () => {
    const err = new Error('no stack')
    err.stack = undefined
    state.thrown = err
    render(<ErrorBoundary><Fragile /></ErrorBoundary>)
    expect(logger.error).toHaveBeenCalledWith('React error: no stack', expect.objectContaining({ stack: undefined }))
    expect(screen.getByRole('alert')).toHaveTextContent('no stack')
  })

  it('Retry draws the content again: once the cause is gone the page comes back', async () => {
    const user = userEvent.setup()
    render(<ErrorBoundary><Fragile /></ErrorBoundary>)
    expect(screen.getByRole('alert')).toBeInTheDocument()
    state.broken = false
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(screen.getByText('CI list')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('Retry while the cause is still there shows the error screen again', async () => {
    const user = userEvent.setup()
    render(<ErrorBoundary><Fragile /></ErrorBoundary>)
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(screen.getByRole('alert')).toHaveTextContent('The CI list could not be drawn')
    expect(logger.error).toHaveBeenCalledTimes(2)
  })

  it('a fallback given by the caller replaces the default screen', () => {
    render(<ErrorBoundary fallback={<p>This panel is unavailable</p>}><Fragile /></ErrorBoundary>)
    expect(screen.getByText('This panel is unavailable')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    // The crash is logged all the same: the fallback is only what the user sees.
    expect(logger.error).toHaveBeenCalledWith('React error: The CI list could not be drawn', expect.anything())
  })

  /*
   * Found by this test (tour of 23 Sep 2026), fixed: a value that is not an
   * Error — a library that throws a string — lost its text on both sides: the
   * log said «React error: undefined» and the screen showed no reason, because
   * both read `.message`, which a string does not have.
   */
  it('a thrown string keeps its text in the log and on the screen', () => {
    state.thrown = 'quota exceeded'
    render(<ErrorBoundary><Fragile /></ErrorBoundary>)
    expect(logger.error).toHaveBeenCalledWith('React error: quota exceeded', expect.anything())
    expect(screen.getByRole('alert')).toHaveTextContent('quota exceeded')
  })
})
