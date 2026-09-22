/**
 * LE FUNZIONI CHE SEMINANO UN WORKFLOW PER UN CLIENTE (22 set 2026).
 *
 * ## Perché
 * `seed.ts`, `seed-problem.ts` e `seed-kb.ts` stavano a ZERO. Non sono file
 * complicati — chiamano `seedWorkflowDefinition`, che ha i suoi test — ma
 * fanno due cose che nessuno verificava e che si vedrebbero solo su un tenant
 * appena nato:
 *
 *  1. **l'incident semina DUE definizioni**, quella base e quella di sicurezza,
 *     e restituisce l'id della PRIMA. Se un giorno la seconda sparisse, un
 *     tenant nascerebbe senza il percorso di sicurezza e l'onboarding direbbe
 *     comunque «workflow creato»;
 *  2. **le opzioni arrivano a tutte**: `overwrite` su una e non sull'altra
 *     lascerebbe un cliente con metà dei suoi iter riallineati.
 *
 * E le definizioni stesse: che siano coerenti — un passo iniziale, uno
 * terminale, e ogni transizione fra passi che esistono davvero — è la cosa che
 * `seedWorkflowDefinition` dà per scontata.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const seedWorkflowDefinition = vi.fn()
vi.mock('../seed-common.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../seed-common.js')>()),
  seedWorkflowDefinition: (...a: unknown[]) => seedWorkflowDefinition(...a),
}))

const { seedWorkflowForTenant, INCIDENT_WORKFLOW_BASE, INCIDENT_SECURITY_WORKFLOW } = await import('../seed.js')
const { seedProblemWorkflowForTenant, PROBLEM_WORKFLOW } = await import('../seed-problem.js')
const { seedKBWorkflowForTenant, KB_ARTICLE_WORKFLOW_BASE } = await import('../seed-kb.js')

type Def = typeof INCIDENT_WORKFLOW_BASE

beforeEach(() => {
  vi.clearAllMocks()
  seedWorkflowDefinition.mockImplementation(async (_t: string, def: Def) => ({ definitionId: `id-${def.name}` }))
})

// ══════════════════════════════════════════════════════════════════════════════
describe('seedWorkflowForTenant — l\'incident ne semina DUE', () => {
  it('base e sicurezza, e torna l\'id della base', async () => {
    const id = await seedWorkflowForTenant('t1')
    expect(id).toBe(`id-${INCIDENT_WORKFLOW_BASE.name}`)
    expect(seedWorkflowDefinition).toHaveBeenCalledTimes(2)
    expect(seedWorkflowDefinition.mock.calls.map((c) => (c[1] as Def).name))
      .toEqual([INCIDENT_WORKFLOW_BASE.name, INCIDENT_SECURITY_WORKFLOW.name])
  })

  it('le opzioni arrivano a TUTTE e due: metà riallineate sarebbe peggio di zero', async () => {
    await seedWorkflowForTenant('t1', { overwrite: true, overwriteCustomized: true })
    for (const c of seedWorkflowDefinition.mock.calls) {
      expect(c[0]).toBe('t1')
      expect(c[2]).toMatchObject({ overwrite: true, overwriteCustomized: true })
    }
  })

  it('senza opzioni non si inventa un `overwrite`: una personalizzazione del cliente sopravvive', async () => {
    await seedWorkflowForTenant('t1')
    expect(seedWorkflowDefinition.mock.calls[0]![2]).toEqual({})
  })
})

describe('problem e KB ne seminano UNA ciascuno', () => {
  it.each([
    ['problem', () => seedProblemWorkflowForTenant('t1'), PROBLEM_WORKFLOW],
    ['kb', () => seedKBWorkflowForTenant('t1'), KB_ARTICLE_WORKFLOW_BASE],
  ] as const)('%s', async (_n, chiama, def) => {
    expect(await chiama()).toBe(`id-${def.name}`)
    expect(seedWorkflowDefinition).toHaveBeenCalledTimes(1)
    expect((seedWorkflowDefinition.mock.calls[0]![1] as Def).name).toBe(def.name)
  })

  it('e passano le opzioni che ricevono', async () => {
    await seedProblemWorkflowForTenant('t1', { overwrite: true })
    expect(seedWorkflowDefinition.mock.calls[0]![2]).toMatchObject({ overwrite: true })
  })
})

// ══════════════════════════════════════════════════════════════════════════════
describe('le definizioni spedite stanno in piedi', () => {
  const TUTTE: Array<[string, Def]> = [
    ['incident', INCIDENT_WORKFLOW_BASE],
    ['incident — sicurezza', INCIDENT_SECURITY_WORKFLOW],
    ['problem', PROBLEM_WORKFLOW],
    ['kb', KB_ARTICLE_WORKFLOW_BASE],
  ]

  it.each(TUTTE)('%s: un passo iniziale solo, e almeno uno terminale', (_n, def) => {
    const iniziali = def.steps.filter((s) => s.metadata?.is_initial === true)
    expect(iniziali).toHaveLength(1)
    expect(def.steps.some((s) => s.metadata?.is_terminal === true)).toBe(true)
  })

  it.each(TUTTE)('%s: ogni transizione collega passi che ESISTONO', (_n, def) => {
    const nomi = new Set(def.steps.map((s) => s.name))
    for (const t of def.transitions) {
      expect(nomi.has(t.fromStepName), `${t.id}: da "${t.fromStepName}"`).toBe(true)
      expect(nomi.has(t.toStepName), `${t.id}: a "${t.toStepName}"`).toBe(true)
    }
  })

  it.each(TUTTE)('%s: nessun passo e nessuna transizione col nome doppio', (_n, def) => {
    const nomi = def.steps.map((s) => s.name)
    expect(new Set(nomi).size).toBe(nomi.length)
    const ids = def.transitions.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it.each(TUTTE)('%s: da ogni passo non terminale si può andare da qualche parte', (_n, def) => {
    const conUscita = new Set(def.transitions.map((t) => t.fromStepName))
    for (const s of def.steps) {
      if (s.metadata?.is_terminal === true) continue
      expect(conUscita.has(s.name), `il passo "${s.name}" non porta da nessuna parte`).toBe(true)
    }
  })

  it.each(TUTTE)('%s: ogni passo, tranne l\'iniziale, si raggiunge', (_n, def) => {
    const iniziale = def.steps.find((s) => s.metadata?.is_initial === true)!.name
    const raggiunti = new Set(def.transitions.map((t) => t.toStepName))
    for (const s of def.steps) {
      if (s.name === iniziale) continue
      expect(raggiunti.has(s.name), `al passo "${s.name}" non arriva nessuno`).toBe(true)
    }
  })

  it('la variante di sicurezza dichiara la sua CATEGORIA: è così che si distingue dalla generica', () => {
    expect(INCIDENT_SECURITY_WORKFLOW.category).toBeTruthy()
    expect((INCIDENT_WORKFLOW_BASE as { category?: string }).category).toBeUndefined()
  })

  it('tutte e quattro dichiarano il tipo di entità e nascono attive', () => {
    for (const [nome, def] of TUTTE) {
      expect(def.entityType, nome).toBeTruthy()
      expect(def.active, nome).toBe(true)
      expect(def.version, nome).toBeGreaterThanOrEqual(1)
    }
  })
})
