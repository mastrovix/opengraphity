/**
 * Generatori di codici progressivi (helpers.ts):
 *   getNextTaskCodes → 'TASK' + 8 cifre zero-padded, batch sequenziale
 *   nextChangeCode   → 'CHG'  + 8 cifre zero-padded
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../ci-utils.js', () => ({
  getSession:  vi.fn(),
  runQuery:    vi.fn(),
  runQueryOne: vi.fn(),
  mapCI:       vi.fn(),
}))

vi.mock('../../../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../../../lib/workflowHelpers.js', () => ({
  getInitialStepName: vi.fn().mockResolvedValue('assessment'),
  getWorkflowSteps:   vi.fn().mockResolvedValue([]),
}))

// ── Import after mocks ────────────────────────────────────────────────────────

const { getNextTaskCodes, nextChangeCode } = await import('../helpers.js')
const { runQuery } = await import('../../ci-utils.js')

const mockSession = {} as never

describe('getNextTaskCodes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('nessun task esistente → primo code TASK00000001', async () => {
    vi.mocked(runQuery).mockResolvedValue([] as never)

    await expect(getNextTaskCodes(mockSession, 'tenant-1', 1)).resolves.toEqual(['TASK00000001'])
  })

  it('esistente TASK00000041 → il prossimo è TASK00000042', async () => {
    vi.mocked(runQuery).mockResolvedValue([{ code: 'TASK00000041' }] as never)

    await expect(getNextTaskCodes(mockSession, 'tenant-1', 1)).resolves.toEqual(['TASK00000042'])
  })

  it('batch: count 3 → sequenza consecutiva a partire dal successivo', async () => {
    vi.mocked(runQuery).mockResolvedValue([{ code: 'TASK00000041' }] as never)

    await expect(getNextTaskCodes(mockSession, 'tenant-1', 3)).resolves.toEqual([
      'TASK00000042', 'TASK00000043', 'TASK00000044',
    ])
  })

  it('tutti i code rispettano il formato TASK + 8 cifre', async () => {
    vi.mocked(runQuery).mockResolvedValue([{ code: 'TASK00000007' }] as never)

    const codes = await getNextTaskCodes(mockSession, 'tenant-1', 2)
    for (const code of codes) expect(code).toMatch(/^TASK\d{8}$/)
  })

  it('code esistente con suffisso non numerico → riparte da 1 (fallback difensivo)', async () => {
    vi.mocked(runQuery).mockResolvedValue([{ code: 'TASKlegacy' }] as never)

    await expect(getNextTaskCodes(mockSession, 'tenant-1', 1)).resolves.toEqual(['TASK00000001'])
  })
})

describe('nextChangeCode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('nessun change esistente (maxNum 0) → CHG00000001', async () => {
    vi.mocked(runQuery).mockResolvedValue([{ maxNum: 0 }] as never)

    await expect(nextChangeCode(mockSession, 'tenant-1')).resolves.toBe('CHG00000001')
  })

  it('max esistente 41 → CHG00000042', async () => {
    vi.mocked(runQuery).mockResolvedValue([{ maxNum: 41 }] as never)

    await expect(nextChangeCode(mockSession, 'tenant-1')).resolves.toBe('CHG00000042')
  })

  it('query senza righe → parte comunque da CHG00000001', async () => {
    vi.mocked(runQuery).mockResolvedValue([] as never)

    await expect(nextChangeCode(mockSession, 'tenant-1')).resolves.toBe('CHG00000001')
  })
})
