/**
 * Personalizzazioni, ondata 8 — A8-3 (B-22): «concluso» è una CLASSE di stato
 * del workflow del cliente, non una lista di nomi.
 *
 * I servizi scrivevano `NOT status IN ['closed','resolved']` (incident) e
 * `NOT status IN ['completed','closed','cancelled','failed']` (change): metà di
 * quei valori non è prodotta da nessun workflow, e i passi veri del cliente non
 * c'erano — un passo terminale aggiunto dal disegnatore contava come aperto.
 * La derivazione dai metadata è quella di `stepStatusClasses` (ondata 2): qui
 * si prova solo che l'unione è giusta e che il caso vuoto è rumoroso.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const rows = vi.fn<() => Array<Record<string, unknown>>>(() => [])
const session = {
  close: vi.fn().mockResolvedValue(undefined),
  executeRead: vi.fn(async (work: (tx: { run: () => Promise<unknown> }) => Promise<unknown>) => work({
    run: async () => ({ records: rows().map((r) => ({ get: (k: string) => (k in r ? r[k] : null) })) }),
  })),
}
vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(() => session) }))
vi.mock('../logger.js', () => {
  const l = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { logger: { ...l, child: () => l } }
})

const { statusNamesForClasses, concludedStatusNames } = await import('../statusStepNames.js')
const { invalidateWorkflowCache } = await import('../workflowHelpers.js')

const step = (name: string, over: Record<string, unknown> = {}) => ({
  name, isInitial: false, isTerminal: false, isOpen: true, category: 'active', purpose: null, stepOrder: null, ...over,
})

beforeEach(() => { vi.clearAllMocks(); invalidateWorkflowCache() })

describe('concludedStatusNames', () => {
  it('unisce i passi risolti (categoria) e chiusi (terminali non risolti), con i nomi del cliente', async () => {
    rows.mockReturnValue([
      step('nuovo', { isInitial: true }),
      step('in_lavorazione'),
      step('sistemato',  { isOpen: false, category: 'resolved' }),
      step('archiviato', { isOpen: false, isTerminal: true, category: 'closed' }),
      step('annullato',  { isOpen: false, isTerminal: true, category: null }),
    ])
    await expect(concludedStatusNames('c-two', 'incident')).resolves.toEqual(['sistemato', 'archiviato', 'annullato'])
    expect(session.close).toHaveBeenCalledTimes(1)
  })

  it('la classe «chiuso» da sola non comprende il passo risolto (un incident risolto è ancora riapribile)', async () => {
    rows.mockReturnValue([
      step('sistemato',  { isOpen: false, category: 'resolved' }),
      step('archiviato', { isOpen: false, isTerminal: true, category: 'closed' }),
    ])
    await expect(statusNamesForClasses('c-two', 'incident', ['closed'])).resolves.toEqual(['archiviato'])
  })

  it('nessun passo conclusivo → elenco vuoto e un warn (ogni ticket risulterebbe aperto, e va detto)', async () => {
    rows.mockReturnValue([step('nuovo', { isInitial: true }), step('in_lavorazione')])
    const { logger } = await import('../logger.js')
    await expect(concludedStatusNames('c-two', 'change')).resolves.toEqual([])
    expect(logger.child({}).warn).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'c-two', entityType: 'change' }),
      expect.stringContaining('Nessun passo conclusivo'),
    )
  })
})
