/**
 * Generatori di codici progressivi (helpers.ts) — revisione del 14 set 2026 · CH-2:
 *   nextChangeCode   → 'CHG'  + 8 cifre dal contatore atomico `change`
 *   getNextTaskCodes → 'TASK' + 8 cifre, un blocco contiguo dal contatore `task`
 * Prima erano `max()+1` letti e poi scritti (due creazioni insieme → stesso
 * codice) e i task scandivano tutti i nodi del database.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Ondata 6 di «Nulla cablato»: il formato dei numeri è del cliente; qui quello di fabbrica.
vi.mock('../../../lib/ticketNumbering.js', () => import('../../../lib/__tests__/ticketNumberingFake.js'))
vi.mock('../../../lib/db.js', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn(), mapCI: vi.fn() }))
vi.mock('../../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}))
vi.mock('../../../lib/workflowHelpers.js', () => ({ getInitialStepName: vi.fn().mockResolvedValue('assessment'), getWorkflowSteps: vi.fn().mockResolvedValue([]) }))
const nextSequenceValue = vi.fn(async () => 42)
const nextSequenceBlock = vi.fn(async (_s: unknown, _t: string, _k: string, count: number) => 40 + count)
vi.mock('../../../lib/sequence.js', () => ({ nextSequenceValue, nextSequenceBlock }))

const { getNextTaskCodes, nextChangeCode } = await import('../helpers.js')
const { runQuery } = await import('../../../lib/db.js')
const session = {} as never

beforeEach(() => vi.clearAllMocks())

describe('nextChangeCode', () => {
  it('dal contatore atomico del tenant, nessuna lettura del massimo', async () => {
    expect(await nextChangeCode(session, 't1')).toBe('CHG00000042')
    expect(nextSequenceValue).toHaveBeenCalledWith(session, 't1', 'change')
    expect(runQuery).not.toHaveBeenCalled()
  })
})

describe('getNextTaskCodes', () => {
  it('un blocco contiguo riservato in una sola operazione', async () => {
    expect(await getNextTaskCodes(session, 't1', 3)).toEqual(['TASK00000041', 'TASK00000042', 'TASK00000043'])
    expect(nextSequenceBlock).toHaveBeenCalledWith(session, 't1', 'task', 3)
    expect(runQuery).not.toHaveBeenCalled()
  })
  it('zero task → nessun codice e nessun contatore toccato', async () => {
    expect(await getNextTaskCodes(session, 't1', 0)).toEqual([])
    expect(nextSequenceBlock).not.toHaveBeenCalled()
  })
})
