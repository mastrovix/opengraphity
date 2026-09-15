/**
 * CH-13 (revisione del 14 set 2026): «Invia promemoria» scriveva un nodo
 * `:Notification` che nessuno leggeva. Ora verifica task e destinatario nel
 * tenant e pubblica l'evento che il dispatcher consegna.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { GraphQLContext } from '../../../../context.js'
import { perms } from '../../../../lib/__tests__/testPermissions.js'

let row: Record<string, unknown> | null = { changeId: 'chg-1', code: 'CHG9', title: 'Patch DB', userName: 'Anna' }
const writes: string[] = []
vi.mock('../../ci-utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../ci-utils.js')>()),
  withSession: vi.fn(async (fn: (s: unknown) => Promise<unknown>) => fn({})),
  runQueryOne: vi.fn(async (_s: unknown, c: string) => { writes.push(c); return row }),
}))
vi.mock('../../../../lib/publishEvent.js', () => ({ publishEvent: vi.fn() }))
vi.mock('../../../../lib/audit.js', () => ({ audit: vi.fn() }))

const { sendTaskReminder } = await import('../changeMutations.js')
const { publishEvent } = await import('../../../../lib/publishEvent.js')
const ctx: GraphQLContext = { tenantId: 't1', userId: 'u1', userEmail: 'a@x', role: 'operator', permissions: perms('operator') }

beforeEach(() => { vi.clearAllMocks(); writes.length = 0; row = { changeId: 'chg-1', code: 'CHG9', title: 'Patch DB', userName: 'Anna' } })

describe('sendTaskReminder', () => {
  it('pubblica change.task_reminder per il destinatario, senza scrivere nodi che nessuno legge', async () => {
    await expect(sendTaskReminder(undefined, { taskId: 'task-1', userId: 'u-7' }, ctx)).resolves.toBe(true)
    expect(publishEvent).toHaveBeenCalledWith('change.task_reminder', 't1', 'u1', expect.objectContaining({ recipient_user_id: 'u-7', entity_id: 'chg-1', task_id: 'task-1', code: 'CHG9' }))
    expect(writes.join('\n')).not.toContain('CREATE (n:Notification')
  })
  it('task o utente fuori dal tenant → NOT_FOUND, nessun evento', async () => {
    row = null
    await expect(sendTaskReminder(undefined, { taskId: 'x', userId: 'y' }, ctx)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
    expect(publishEvent).not.toHaveBeenCalled()
  })
})
