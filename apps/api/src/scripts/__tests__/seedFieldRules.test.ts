/**
 * D-11 — `seed:field-rules` non scrive più regole che non possono funzionare.
 *
 * Il difetto: il seed creava le regole con `CREATE` senza verificare né che il
 * campo esistesse nel metamodello del cliente né che il passo del workflow si
 * chiamasse davvero così. Dal vivo nessun tipo ITIL ha `device_model`,
 * `resolution_notes` o `risk_assessment` come `CIFieldDefinition`, e
 * `docs/OPERATIONS.md` consigliava questo seed all'onboarding: il risultato era
 * una regola nel pannello, apparentemente attiva, che non si applicava a niente.
 *
 * Due precisazioni che vengono dalla verifica del punto e che il test pinna:
 *  - i campi INIETTATI (`assigned_to`, `resolution_notes`) non stanno nel
 *    metamodello e le regole funzionano comunque, perché `workflowMutations`
 *    riempie quei valori prima di `validateRequiredFields`: sono dichiarati nel
 *    seed con la loro provenienza, non sono un'eccezione muta;
 *  - un campo che non è nel metamodello E che nessuno inietta ferma lo script.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const metamodelFields = new Map<string, string[]>()
const workflowSteps   = new Map<string, string[]>()

vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({
    executeRead: vi.fn(async (fn: (tx: { run: (c: string, p: Record<string, unknown>) => Promise<unknown> }) => unknown) =>
      fn({
        run: async (_c: string, p: Record<string, unknown>) => ({
          records: [{ get: () => metamodelFields.get(String(p['entityType'])) ?? [] }],
        }),
      })),
    close: vi.fn(async () => {}),
  })),
}))
vi.mock('../../lib/workflowHelpers.js', () => ({
  getWorkflowSteps: vi.fn(async (_s: unknown, _t: string, entityType: string) =>
    (workflowSteps.get(entityType) ?? []).map((name) => ({ name }))),
}))
vi.mock('../lib/scriptArgs.js', () => ({ resolveTenantArg: vi.fn(() => 'c-one'), ScriptArgError: class extends Error {} }))
vi.mock('../lib/runScript.js', () => ({ runScript: vi.fn() }))

const { assertRulesApplicable, VISIBILITY_RULES, REQUIREMENT_RULES } = await import('../seed-field-rules.js')

const INCIDENT_FIELDS = ['title', 'description', 'status', 'severity', 'category', 'root_cause', 'resolved_at', 'created_at', 'updated_at']
const INCIDENT_STEPS  = ['new', 'assigned', 'in_progress', 'pending', 'escalated', 'resolved', 'closed']

beforeEach(() => {
  metamodelFields.clear(); workflowSteps.clear()
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
})

describe('il seme stesso', () => {
  // La regola «categoria hardware → mostra device_model» era inerte dal primo
  // giorno: `device_model` non esiste in nessun tipo ITIL spedito.
  it('non spedisce regole di visibilità', () => {
    expect(VISIBILITY_RULES).toEqual([])
  })

  it('due regole di obbligatorietà, entrambe su campi iniettati e dichiarati tali', () => {
    expect(REQUIREMENT_RULES).toHaveLength(2)
    expect(REQUIREMENT_RULES.map((r) => [r.entityType, r.fieldName, r.workflowStep])).toEqual([
      ['incident', 'assigned_to', 'in_progress'],
      ['incident', 'resolution_notes', 'resolved'],
    ])
    for (const r of REQUIREMENT_RULES) expect(r.injectedBy).toMatch(/workflowMutations/)
  })

  // La regola per le change (`risk_assessment`@`assessment`) è stata tolta:
  // non è un campo del metamodello (la change ha `risk`), nessuno lo inietta e
  // `executeChangeTransition` non chiama nemmeno il validatore.
  it('nessuna regola sulle change', () => {
    expect(REQUIREMENT_RULES.some((r) => r.entityType === 'change')).toBe(false)
  })
})

describe('assertRulesApplicable — verifica TUTTO prima di scrivere', () => {
  it('metamodello e workflow di fabbrica → passa (i due campi sono iniettati)', async () => {
    metamodelFields.set('incident', INCIDENT_FIELDS)
    workflowSteps.set('incident', INCIDENT_STEPS)
    await expect(assertRulesApplicable('c-one')).resolves.toBeUndefined()
  })

  it('passo rinominato dal disegnatore → si ferma elencando i passi veri', async () => {
    metamodelFields.set('incident', INCIDENT_FIELDS)
    workflowSteps.set('incident', ['nuovo', 'preso_in_carico', 'risolto', 'chiuso'])
    await expect(assertRulesApplicable('c-one')).rejects.toThrow(/non ha un passo chiamato "in_progress"[\s\S]*nuovo, preso_in_carico, risolto, chiuso/)
  })

  it('nessun workflow per quel tipo → si ferma dicendo che non ci sono passi', async () => {
    metamodelFields.set('incident', INCIDENT_FIELDS)
    workflowSteps.set('incident', [])
    await expect(assertRulesApplicable('c-two')).rejects.toThrow(/Disponibili per questo cliente: \(nessuno\)/)
  })

  it('un campo che non è nel metamodello e che nessuno inietta ferma lo script', async () => {
    metamodelFields.set('incident', INCIDENT_FIELDS)
    metamodelFields.set('change', ['title', 'description', 'risk', 'priority'])
    workflowSteps.set('incident', INCIDENT_STEPS)
    workflowSteps.set('change', ['draft', 'assessment'])
    REQUIREMENT_RULES.push({ entityType: 'change', fieldName: 'risk_assessment', required: true, workflowStep: 'assessment' })
    try {
      await expect(assertRulesApplicable('c-one')).rejects.toThrow(/il campo "risk_assessment" non esiste nel metamodello di "change" e nessuno lo inietta[\s\S]*risk/)
    } finally {
      REQUIREMENT_RULES.pop()
    }
  })
})
