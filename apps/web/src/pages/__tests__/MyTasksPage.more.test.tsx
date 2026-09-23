/**
 * «MY TASKS»: what a row says when something is missing or unknown, and the
 * «Take it» button while a claim is on its way.
 *
 * A task without a creation date shows a dash, never a made-up date. A kind
 * of task this client does not know yet (a new workflow action) is shown by
 * its key and reported, so it is visible rather than dressed as another
 * kind. While a claim is being sent, «Take it» cannot be pressed again —
 * a second click would send a second claim for a task already taken.
 * `MyTasksPage.test.tsx` and `mieiCompiti.test.tsx` cover the rest.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { MyTasksPage } from '../MyTasksPage'

// A mutation named in `held` is on its way (loading).
const held = vi.hoisted(() => new Set<string>())
vi.mock('@apollo/client/react', async () => {
  const { nomeOperazione, moduloApollo } = await import('@/test/apolloFinto')
  const m = moduloApollo()
  type Doc = Parameters<typeof m.useMutation>[0]
  type Opts = Parameters<typeof m.useMutation>[1]
  return {
    ...m,
    useMutation: (doc: Doc, opts?: Opts) => {
      const [fn, r] = m.useMutation(doc, opts)
      return held.has(nomeOperazione(doc)) ? [fn, { ...r, loading: true }] as const : [fn, r] as const
    },
  }
})
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const task = (over: Record<string, unknown> = {}) => ({
  id: 't1', code: 'TASK00000001', kind: 'task', role: '', action: 'Prepare the machine', status: 'open',
  entityType: 'incident', entityId: 'inc-1', entityNumber: 'INC00000001',
  ciId: null, ciName: null, phase: 'in_progress', createdAt: '2026-09-20T10:00:00Z', ...over,
})

beforeEach(() => {
  apolloFinto.reset()
  held.clear()
  apolloFinto.risposte['GetMe'] = { me: {
    id: 'u-7', name: 'Ann', email: 'ann@acme.com', role: 'operator', roleName: null, permissions: ['incident.write'],
    slackId: null, emailNotifications: null, language: null, teams: [],
  } }
})

describe('MyTasksPage rows', () => {
  it('a task without a creation date shows a dash, not a made-up date', () => {
    apolloFinto.risposte['GetMyTasks'] = { myTasks: { assignedToMe: [task({ createdAt: null })], unassigned: [] } }
    renderWithProviders(<MyTasksPage />)
    expect(screen.getByText('Created on —')).toBeInTheDocument()
  })

  it('a kind of task the client does not know is shown by its key, with the action the server sent, and reported', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    apolloFinto.risposte['GetMyTasks'] = { myTasks: { assignedToMe: [task({ kind: 'audit', action: 'Check the evidence' })], unassigned: [] } }
    renderWithProviders(<MyTasksPage />)
    expect(screen.getByRole('link', { name: 'audit' })).toHaveAttribute('href', '/tasks/t1')
    expect(screen.getByText('Check the evidence')).toBeInTheDocument()
    expect(consoleError).toHaveBeenCalledWith('[KIND_COLOR] unknown value: "audit"')
  })

  it('while a task is being taken, «Take it» cannot be pressed again', () => {
    held.add('ClaimTicketTask')
    apolloFinto.risposte['GetMyTasks'] = { myTasks: { assignedToMe: [], unassigned: [task()] } }
    renderWithProviders(<MyTasksPage />)
    const take = screen.getByRole('button', { name: 'Take it' })
    expect(take).toBeDisabled()
    expect(take.style.cursor).toBe('not-allowed')
  })
})
