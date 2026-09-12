/**
 * Personalizzazioni, ondata 2 — B2-4 (B-24): la cache dei metadata dei passi.
 *
 * `invalidateWorkflowCache` esisteva e non aveva NESSUN chiamante: dopo un
 * salvataggio dal disegnatore il processo continuava fino a 30 s con i flag
 * vecchi. Qui si pinna il comportamento della cache e della sua invalidazione,
 * compreso il caso «invalidare un tenant» che prima buttava via anche la cache
 * degli altri tenant.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getWorkflowSteps, invalidateWorkflowCache, stepStatusClasses } from '../workflowHelpers.js'

function fakeSession(rows: Array<Record<string, unknown>>) {
  const run = vi.fn(async () => ({
    records: rows.map((r) => ({ get: (k: string) => (k in r ? r[k] : null) })),
  }))
  return {
    run,
    executeRead: vi.fn(async (work: (tx: { run: typeof run }) => Promise<unknown>) => work({ run })),
  }
}

const step = (name: string, over: Record<string, unknown> = {}) => ({
  name, isInitial: false, isTerminal: false, isOpen: true, category: 'active', step_order: 1, stepOrder: 1, ...over,
})

beforeEach(() => { invalidateWorkflowCache() })

describe('cache dei metadata dei passi (B2-4 / B-24)', () => {
  it('la seconda lettura non tocca il database', async () => {
    const s = fakeSession([step('new', { isInitial: true })])
    await getWorkflowSteps(s as never, 'c-one', 'incident')
    await getWorkflowSteps(s as never, 'c-one', 'incident')
    expect(s.run).toHaveBeenCalledOnce()
  })

  it('dopo invalidateWorkflowCache(tenant, entity) rilegge', async () => {
    const s = fakeSession([step('new')])
    await getWorkflowSteps(s as never, 'c-one', 'incident')
    invalidateWorkflowCache('c-one', 'incident')
    await getWorkflowSteps(s as never, 'c-one', 'incident')
    expect(s.run).toHaveBeenCalledTimes(2)
  })

  it('invalidare un tenant non butta via la cache degli altri tenant', async () => {
    const one = fakeSession([step('new')])
    const two = fakeSession([step('new')])
    await getWorkflowSteps(one as never, 'c-one', 'incident')
    await getWorkflowSteps(one as never, 'c-one', 'problem')
    await getWorkflowSteps(two as never, 'c-two', 'incident')

    invalidateWorkflowCache('c-one')

    await getWorkflowSteps(one as never, 'c-one', 'incident')   // rilegge
    await getWorkflowSteps(one as never, 'c-one', 'problem')    // rilegge
    await getWorkflowSteps(two as never, 'c-two', 'incident')   // ancora in cache
    expect(one.run).toHaveBeenCalledTimes(4)
    expect(two.run).toHaveBeenCalledOnce()
  })

  it('senza argomenti svuota tutto', async () => {
    const s = fakeSession([step('new')])
    await getWorkflowSteps(s as never, 'c-one', 'incident')
    invalidateWorkflowCache()
    await getWorkflowSteps(s as never, 'c-one', 'incident')
    expect(s.run).toHaveBeenCalledTimes(2)
  })
})

describe('stepStatusClasses: nessun nome di passo, solo metadata', () => {
  it('un passo con categoria resolved è «risolto», non «aperto»', () => {
    expect(stepStatusClasses({ name: 'risolto_mio', isInitial: false, isTerminal: true, isOpen: false, category: 'resolved', stepOrder: 7 }))
      .toEqual(['resolved'])
  })
  it('il passo iniziale è aperto ma non «in lavorazione»', () => {
    expect(stepStatusClasses({ name: 'nuovo', isInitial: true, isTerminal: false, isOpen: true, category: 'active', stepOrder: 1 }))
      .toEqual(['open'])
  })
})
