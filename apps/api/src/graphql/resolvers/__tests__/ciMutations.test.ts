/**
 * B-08 / F-13 — manual CI creation carries the :ConfigurationItem label like
 * discovery does, and the metamodel validation (required, field and type
 * validation scripts) runs server side through the scripting sandbox.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CITypeWithDefinitions } from '@opengraphity/schema-generator'
import { ValidationError } from '../../../lib/errors.js'

const runScript = vi.fn()
vi.mock('@opengraphity/scripting', () => ({ runScript: (...a: unknown[]) => runScript(...a) }))
// D-12: il limite di piano sugli script. `isTenantOwnedDefinition` resta quella
// vera (è la regola che decide CHI passa dal limite); solo la lettura del
// tenant è simulata.
const assertScriptingEnabled = vi.fn<(tenantId: string, what: string) => Promise<void>>(async () => {})
vi.mock('../../../lib/scriptingPlan.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../lib/scriptingPlan.js')>()
  return { ...orig, assertScriptingEnabled: (t: string, w: string) => assertScriptingEnabled(t, w) }
})
vi.mock('../ci-utils.js', () => ({ withSession: vi.fn() }))
vi.mock('../../../lib/cache.js', () => ({ cache: { invalidate: vi.fn() } }))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../lib/chainCalculator.js', () => ({ calculateChain: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../services/serviceImpact/sync.js', () => ({
  notifyCIGraphChanged: vi.fn().mockResolvedValue(0),
  notifyCIMaintenanceChanged: vi.fn().mockResolvedValue(0),
}))
// Revisione 2 · B2-14: uscire dalla manutenzione ricalcola la salute del CI (la
// manutenzione la congela); D4.3: i commenti prima della cancellazione.
vi.mock('../../../services/events/ciHealth.js', () => ({ recomputeCIHealth: vi.fn().mockResolvedValue('operational') }))
// Ondata 7 · C-4: «in manutenzione» è la semantica DEL CLIENTE, letta dalla
// policy del tenant, non il letterale `maintenance`. Qui la policy del cliente
// di prova ha i valori iniziali (gli stessi che il codice aveva come costanti):
// il gancio verso i Servizi monitorati deve continuare a scattare esattamente
// come prima.
vi.mock('../../../services/events/policy.js', () => ({
  getEventPolicy: vi.fn().mockResolvedValue({
    retired_statuses: ['inactive', 'decommissioned'],
    maintenance_statuses: ['maintenance'],
    ignore_lifecycle_statuses: ['decommissioned'],
  }),
}))
vi.mock('../../../services/events/cascade.js', () => ({ noteIncidentsBeforeCIDeletion: vi.fn().mockResolvedValue(undefined) }))

const { buildCreateMutation, buildUpdateMutation, buildDeleteMutation, validateCIInput } = await import('../ciMutations.js')
const { withSession } = await import('../ci-utils.js')
const { notifyCIGraphChanged, notifyCIMaintenanceChanged } = await import('../../../services/serviceImpact/sync.js')
const { recomputeCIHealth } = await import('../../../services/events/ciHealth.js')
const { noteIncidentsBeforeCIDeletion } = await import('../../../services/events/cascade.js')

const IP_SCRIPT = 'if (!/^\\d+\\.\\d+\\.\\d+\\.\\d+$/.test(value)) throw new Error("IP non valido")'

/**
 * Il tipo `server` come arriva dal metamodello CONDIVISO: `scope: 'base'`,
 * `tenantId: 'system'` — come dal vivo per i campi che hanno uno script di
 * validazione (`url`, `ipAddress`, `expiresAt`) e per il tipo `certificate`.
 * Sono script del prodotto, non del cliente: non passano dal limite di piano
 * (altrimenti nessun tenant starter potrebbe creare un CI).
 */
function ciType(over: Partial<CITypeWithDefinitions> = {}): CITypeWithDefinitions {
  return {
    id: 'ct-server', name: 'server', label: 'Server', neo4jLabel: 'Server', icon: '', color: '',
    scope: 'base', tenantId: 'system',
    validationScript: null,
    fields: [
      { id: 'f1', name: 'ipAddress', label: 'IP', type: 'string', required: true,  defaultValue: null, enumValues: [], validationScript: IP_SCRIPT, visibilityScript: null, defaultScript: null, isSystem: false, scope: 'base', tenantId: 'system' },
      { id: 'f2', name: 'rack',      label: 'Rack', type: 'string', required: false, defaultValue: null, enumValues: [], validationScript: null,      visibilityScript: null, defaultScript: null, isSystem: false, scope: 'base', tenantId: 'system' },
      { id: 'f3', name: 'createdAt', label: 'Creato', type: 'datetime', required: true, defaultValue: null, enumValues: [], validationScript: null,  visibilityScript: null, defaultScript: null, isSystem: true, scope: 'base', tenantId: 'system' },
    ],
    relations: [],
    ...over,
  } as unknown as CITypeWithDefinitions
}

/** Lo stesso tipo con un campo aggiunto DAL CLIENTE (`scope: 'tenant'`) che ha uno script. */
function ciTypeWithTenantScript(): CITypeWithDefinitions {
  return ciType({
    fields: [
      ...ciType().fields,
      { id: 'f4', name: 'costCenter', label: 'Centro di costo', required: false, defaultValue: null, enumValues: [], validationScript: 'if (!value) throw "obbligatorio"', visibilityScript: null, defaultScript: null, isSystem: false, scope: 'tenant', tenantId: 't1' } as unknown as CITypeWithDefinitions['fields'][number],
    ],
  })
}

function fakeSession(props: Record<string, unknown> | null = null) {
  const run = vi.fn().mockImplementation(async (cypher: string) => ({
    records: cypher.includes('RETURN properties(n) AS p')
      ? (props ? [{ get: () => props }] : [])
      : [],
  }))
  return {
    run,
    executeWrite: vi.fn().mockImplementation((fn: (tx: unknown) => unknown) => fn({ run })),
    executeRead:  vi.fn().mockImplementation((fn: (tx: unknown) => unknown) => fn({ run })),
  }
}

const ctx = { tenantId: 't1', userId: 'u1', userEmail: 'u@x', role: 'operator' as const }
const mapCI = (p: Record<string, unknown>) => p

beforeEach(() => {
  vi.clearAllMocks()
  runScript.mockResolvedValue({ success: true, logs: [], duration_ms: 1 })
})

describe('validateCIInput (F-13)', () => {
  it('required field missing → ValidationError, no script executed', async () => {
    await expect(validateCIInput(ciType(), { name: 'srv', ipAddress: '' }, 't1'))
      .rejects.toMatchObject({ message: expect.stringContaining('IP è obbligatorio'), extensions: { code: 'BAD_USER_INPUT' } })
    expect(runScript).not.toHaveBeenCalled()
  })

  it('system fields are not subject to `required` (API-managed)', async () => {
    await expect(validateCIInput(ciType(), { name: 'srv', ipAddress: '10.0.0.1' }, 't1')).resolves.toBeUndefined()
  })

  it('field validation script runs in the sandbox with value + input and its error is surfaced', async () => {
    runScript.mockResolvedValueOnce({ success: false, error: 'IP non valido', logs: [], duration_ms: 1 })
    await expect(validateCIInput(ciType(), { name: 'srv', ipAddress: 'nope' }, 't1'))
      .rejects.toThrow(/IP: IP non valido/)

    const [def, scriptCtx] = runScript.mock.calls[0]!
    expect(def).toMatchObject({ tenant_id: 't1', enabled: true })
    expect(def.code).toContain('const value = ctx.value')
    expect(def.code).toContain(IP_SCRIPT)
    expect(scriptCtx).toMatchObject({ value: 'nope', input: { name: 'srv', ipAddress: 'nope' }, tenantId: 't1' })
  })

  it('type-level validation script runs only when fields pass, with the whole input', async () => {
    const t = ciType({ validationScript: 'if (input.rack === "R0") throw new Error("Rack riservato")' })
    runScript.mockResolvedValueOnce({ success: true, logs: [], duration_ms: 1 })            // field script
    runScript.mockResolvedValueOnce({ success: false, error: 'Rack riservato', logs: [], duration_ms: 1 })  // type script
    await expect(validateCIInput(t, { name: 'srv', ipAddress: '10.0.0.1', rack: 'R0' }, 't1'))
      .rejects.toThrow(/Rack riservato/)
    expect(runScript).toHaveBeenCalledTimes(2)
    expect(runScript.mock.calls[1]![0].code).toContain('Rack riservato')
  })

  it('a script rejected by the sandbox static validation is a loud config error', async () => {
    runScript.mockResolvedValueOnce({ success: false, error: 'Script validation failed: Access to "process" is not allowed', logs: [], duration_ms: 0 })
    await expect(validateCIInput(ciType(), { name: 'srv', ipAddress: '10.0.0.1' }, 't1'))
      .rejects.toThrow(/Script validation failed/)
  })
})

/**
 * Ondata 7 · B7-2 / A-13 — l'appartenenza al vocabolario è imposta dall'API.
 *
 * Lo SDL generato descrive un campo `enum` come `String`
 * (`schema-generator/src/generator.ts`), quindi GraphQL non impone niente: un
 * client con API key poteva scrivere `status: 'expired'` con `expired` fuori
 * dal vocabolario, e nessuno lo diceva (dal vivo su c-one: 68 CI). I valori
 * ammessi sono `field.enumValues`, cioè il vocabolario DI QUESTO CLIENTE —
 * `ciTypeMetamodel.ts` lo risolve già con la precedenza dell'ondata 1.
 */
describe('validateCIInput — vocabolario dei campi enum (B7-2 / A-13)', () => {
  /** Il tipo con un campo `enum` e il vocabolario del cliente (che ha rinominato «dismesso»). */
  const withEnum = () => {
    const t = ciType()
    t.fields = [
      { id: 'f1', name: 'ipAddress', label: 'IP', fieldType: 'string', required: false, defaultValue: null, enumValues: [], validationScript: null, visibilityScript: null, defaultScript: null, isSystem: false, scope: 'base', tenantId: 'system', order: 0 },
      { id: 'f2', name: 'status', label: 'Stato', fieldType: 'enum', required: false, defaultValue: null, enumValues: ['active', 'dismesso'], validationScript: null, visibilityScript: null, defaultScript: null, isSystem: false, scope: 'base', tenantId: 'system', order: 1 },
      { id: 'f3', name: 'libero', label: 'Libero', fieldType: 'enum', required: false, defaultValue: null, enumValues: [], validationScript: null, visibilityScript: null, defaultScript: null, isSystem: false, scope: 'tenant', tenantId: 't1', order: 2 },
    ] as never
    return t
  }

  it('valore del vocabolario del cliente → passa; valore fuori vocabolario → rifiutato, con i valori ammessi nel messaggio', async () => {
    await expect(validateCIInput(withEnum(), { name: 'srv', status: 'dismesso' }, 't1')).resolves.toBeUndefined()
    await expect(validateCIInput(withEnum(), { name: 'srv', status: 'expired' }, 't1'))
      .rejects.toMatchObject({
        message: expect.stringContaining('Stato: "expired" non è nel vocabolario di questo cliente. Ammessi: active, dismesso'),
        extensions: { code: 'BAD_USER_INPUT' },
      })
  })

  it('valore assente o vuoto su un campo non obbligatorio → nessun controllo di appartenenza', async () => {
    for (const status of [null, undefined, '']) {
      await expect(validateCIInput(withEnum(), { name: 'srv', status }, 't1')).resolves.toBeUndefined()
    }
  })

  it('campo enum senza valori nel metamodello → non si rifiuta nulla (il vocabolario mancante è un problema del metamodello, non della scrittura)', async () => {
    await expect(validateCIInput(withEnum(), { name: 'srv', libero: 'qualunque' }, 't1')).resolves.toBeUndefined()
  })

  /**
   * In MODIFICA il controllo riguarda solo i campi che la richiesta scrive: un
   * valore già sul CI e non più nel vocabolario è un dato storico, e rifiutare
   * il salvataggio di un altro campo renderebbe il record immodificabile
   * proprio quando lo si vuole sistemare. Il form lo mostra come «non più nel
   * vocabolario» (B7-3), così a correggerlo si va di proposito.
   */
  it('in modifica: un valore storico fuori vocabolario non blocca la scrittura di un ALTRO campo, ma lo blocca se lo si riscrive', async () => {
    const merged = { name: 'srv-nuovo', status: 'expired' }
    await expect(validateCIInput(withEnum(), merged, 't1', new Set(['name']))).resolves.toBeUndefined()
    await expect(validateCIInput(withEnum(), merged, 't1', new Set(['name', 'status'])))
      .rejects.toThrow(/"expired" non è nel vocabolario/)
  })

  it('il valore fuori vocabolario è un rifiuto PRIMA dello script del campo (nessuno script su un valore che non esiste)', async () => {
    const t = withEnum()
    ;(t.fields[1] as { validationScript: string | null }).validationScript = 'throw new Error("mai")'
    await expect(validateCIInput(t, { name: 'srv', status: 'expired' }, 't1')).rejects.toThrow(/non è nel vocabolario/)
    expect(runScript).not.toHaveBeenCalled()
  })
})

describe('limite di piano sugli script del metamodello (D-12)', () => {
  it('uno script del metamodello CONDIVISO (scope base) gira senza passare dal limite di piano', async () => {
    await validateCIInput(ciType(), { name: 'srv', ipAddress: '10.0.0.1' }, 't1')
    expect(runScript).toHaveBeenCalledTimes(1)
    expect(assertScriptingEnabled).not.toHaveBeenCalled()
  })

  it('uno script scritto dal CLIENTE (scope tenant) passa dal limite, nominando il campo', async () => {
    await validateCIInput(ciTypeWithTenantScript(), { name: 'srv', ipAddress: '10.0.0.1', costCenter: 'CC1' }, 't1')
    expect(assertScriptingEnabled).toHaveBeenCalledTimes(1)
    expect(assertScriptingEnabled).toHaveBeenCalledWith('t1', 'server.costCenter.validation_script')
  })

  it('piano senza script → lo script NON gira e l\'errore lo dice', async () => {
    assertScriptingEnabled.mockRejectedValueOnce(new ValidationError('server.costCenter.validation_script: il piano "starter" del tenant t1 non include gli script (scripting_enabled = false). Rimuovi lo script dalla configurazione oppure passa a un piano che li include.'))
    await expect(validateCIInput(ciTypeWithTenantScript(), { name: 'srv', ipAddress: '10.0.0.1', costCenter: 'CC1' }, 't1'))
      .rejects.toThrow(/non include gli script/)
    // lo script condiviso di ipAddress è già girato, quello del cliente no
    expect(runScript).toHaveBeenCalledTimes(1)
    expect(runScript.mock.calls[0]![0].code).toContain(IP_SCRIPT)
  })

  it('uno script di TIPO scritto dal cliente (scope tenant) passa dal limite', async () => {
    const t = ciType({ scope: 'tenant', tenantId: 't1', validationScript: 'if (input.rack === "R0") throw "riservato"' } as Partial<CITypeWithDefinitions>)
    await validateCIInput(t, { name: 'srv', ipAddress: '10.0.0.1' }, 't1')
    expect(assertScriptingEnabled).toHaveBeenCalledWith('t1', 'server.validation_script')
  })
})

describe('buildCreateMutation', () => {
  it('validates before opening a session and creates (:ConfigurationItem:<Label>) (B-08)', async () => {
    const session = fakeSession({ id: 'ci-1', name: 'srv', ip_address: '10.0.0.1' })
    vi.mocked(withSession).mockImplementation((fn) => fn(session as never))
    const create = buildCreateMutation(ciType(), 'Server', mapCI)

    await expect(create(undefined, { input: { name: 'srv' } }, ctx))
      .rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } })
    expect(withSession).not.toHaveBeenCalled()

    const out = await create(undefined, { input: { name: 'srv', ipAddress: '10.0.0.1', ownerGroupId: 'team-1' } }, ctx)
    expect(out).toMatchObject({ id: 'ci-1' })
    const [createCypher, createParams] = session.run.mock.calls[0]!
    expect(createCypher).toContain('CREATE (n:ConfigurationItem:Server $props)')
    expect(createParams.props).toMatchObject({ tenant_id: 't1', name: 'srv', ip_address: '10.0.0.1', status: 'active' })
    const [teamCypher, teamParams] = session.run.mock.calls[1]!
    expect(teamCypher).toContain('MATCH (n:Server {id: $id, tenant_id: $tenantId})')
    expect(teamParams).toMatchObject({ teamId: 'team-1', tenantId: 't1' })
  })

  it('rejects an unsafe label at build time', () => {
    expect(() => buildCreateMutation(ciType(), 'Server) DETACH DELETE n //', mapCI)).toThrow(/Invalid CI type label/)
  })
})

describe('buildUpdateMutation', () => {
  it('validates the merged CI (existing values + patch) and writes SET n += $updates', async () => {
    const session = fakeSession({ id: 'ci-1', name: 'srv', ip_address: '10.0.0.1', rack: 'R1' })
    vi.mocked(withSession).mockImplementation((fn) => fn(session as never))
    const update = buildUpdateMutation(ciType(), 'Server', mapCI)

    await update(undefined, { id: 'ci-1', input: { rack: 'R2' } }, ctx)

    // the field script saw the existing IP, the whole merged input has the patched rack
    const [, scriptCtx] = runScript.mock.calls[0]!
    expect(scriptCtx).toMatchObject({ value: '10.0.0.1', input: { name: 'srv', ipAddress: '10.0.0.1', rack: 'R2' } })
    const writeCall = session.run.mock.calls.find(([c]) => String(c).includes('SET n += $updates'))!
    expect(writeCall[0]).toContain('MATCH (n:Server {id: $id, tenant_id: $tenantId})')
    expect(writeCall[1].updates).toMatchObject({ rack: 'R2' })
    expect(writeCall[1].updates).not.toHaveProperty('ip_address')
  })

  // ── Revisione 2 · D6.1: `status` da/verso maintenance avvisa i Servizi ────
  it.each([
    ['active', 'maintenance', 'ci.status:entered_maintenance'],
    ['maintenance', 'active',  'ci.status:left_maintenance'],
  ])('status %s → %s: ricalcola la salute del CI e POI accoda la rivalutazione delle mappe che includono il CI (%s)', async (from, to, reason) => {
    const session = fakeSession({ id: 'ci-1', name: 'srv', status: from, ip_address: '10.0.0.1' })
    vi.mocked(withSession).mockImplementation((fn) => fn(session as never))
    const update = buildUpdateMutation(ciType(), 'Server', mapCI)

    await update(undefined, { id: 'ci-1', input: { status: to } }, ctx)

    // B2-14: in manutenzione il monitoraggio non scrive `ci.health`; all'uscita
    // la salute resterebbe quella di prima della finestra fino al payload
    // successivo dello strumento. Prima il ricalcolo, poi il segnale ai servizi
    // (che deve leggere la salute già aggiornata).
    expect(recomputeCIHealth).toHaveBeenCalledWith('t1', 'ci-1', 'u1')
    expect(notifyCIMaintenanceChanged).toHaveBeenCalledWith('t1', ['ci-1'], reason)
    expect(vi.mocked(recomputeCIHealth).mock.invocationCallOrder[0]!)
      .toBeLessThan(vi.mocked(notifyCIMaintenanceChanged).mock.invocationCallOrder[0]!)
    // dopo la scrittura (la CMDB è già cambiata), come notifyCIGraphChanged
    expect(vi.mocked(recomputeCIHealth).mock.invocationCallOrder[0]!)
      .toBeGreaterThan(session.executeWrite.mock.invocationCallOrder.at(-1)!)
  })

  it('status invariato (o patch che non lo tocca) → nessun segnale ai Servizi; una coda giù non fa fallire l\'aggiornamento', async () => {
    const session = fakeSession({ id: 'ci-1', name: 'srv', status: 'active', ip_address: '10.0.0.1' })
    vi.mocked(withSession).mockImplementation((fn) => fn(session as never))
    const update = buildUpdateMutation(ciType(), 'Server', mapCI)

    await update(undefined, { id: 'ci-1', input: { rack: 'R2' } }, ctx)
    await update(undefined, { id: 'ci-1', input: { status: 'active' } }, ctx)
    await update(undefined, { id: 'ci-1', input: { status: 'decommissioned' } }, ctx)
    expect(notifyCIMaintenanceChanged).not.toHaveBeenCalled()
    expect(recomputeCIHealth).not.toHaveBeenCalled()

    vi.mocked(notifyCIMaintenanceChanged).mockResolvedValueOnce(0)
    const toMaintenance = await update(undefined, { id: 'ci-1', input: { status: 'maintenance' } }, ctx)
    expect(toMaintenance).toBeTruthy()
  })

  it('a patch clearing a required field is rejected before the write', async () => {
    const session = fakeSession({ id: 'ci-1', name: 'srv', ip_address: '10.0.0.1' })
    vi.mocked(withSession).mockImplementation((fn) => fn(session as never))
    const update = buildUpdateMutation(ciType(), 'Server', mapCI)

    await expect(update(undefined, { id: 'ci-1', input: { ipAddress: '' } }, ctx)).rejects.toThrow(/IP è obbligatorio/)
    expect(session.run.mock.calls.some(([c]) => String(c).includes('SET n +='))).toBe(false)
  })

  it('unknown CI → NOT_FOUND before validation', async () => {
    const session = fakeSession(null)
    vi.mocked(withSession).mockImplementation((fn) => fn(session as never))
    const update = buildUpdateMutation(ciType(), 'Server', mapCI)
    await expect(update(undefined, { id: 'nope', input: { rack: 'R2' } }, ctx)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
    expect(runScript).not.toHaveBeenCalled()
  })
})

describe('buildDeleteMutation (B7 — Event Management)', () => {
  it('cancellazione fisica scoped per tenant: gli alias ALIAS_OF del CI vanno via nella stessa scrittura, gli Event RAISED_ON restano orfani (solo la relazione cade)', async () => {
    const session = fakeSession()
    vi.mocked(withSession).mockImplementation((fn) => fn(session as never))
    const del = buildDeleteMutation('Server')

    await expect(del(undefined, { id: 'ci-1' }, ctx)).resolves.toBe(true)
    expect(session.executeWrite).toHaveBeenCalledTimes(1)
    const [cypher, params] = session.run.mock.calls[0]!
    expect(cypher).toContain('MATCH (n:Server {id: $id, tenant_id: $tenantId})')
    expect(cypher).toContain('OPTIONAL MATCH (a:CIAlias {tenant_id: $tenantId})-[:ALIAS_OF]->(n)')
    expect(cypher).toMatch(/DETACH DELETE a, h, m, n/)
    // nessuna cancellazione degli Event: perdono la relazione, non il nodo
    expect(cypher).not.toMatch(/DELETE\s+e\b/)
    expect(params).toEqual({ id: 'ci-1', tenantId: 't1' })
  })

  // ── Revisione 2 · D4.3: i commenti PRIMA della cancellazione ─────────────
  it('D4.3 — prima del DETACH DELETE annota gli incident che perdono il loro unico CI (e, per una BusinessApplication, quelli del servizio); la nota non può far fallire la cancellazione', async () => {
    const session = fakeSession()
    vi.mocked(withSession).mockImplementation((fn) => fn(session as never))
    await expect(buildDeleteMutation('Server')(undefined, { id: 'ci-1' }, ctx)).resolves.toBe(true)
    expect(noteIncidentsBeforeCIDeletion).toHaveBeenCalledWith('t1', 'ci-1', session)
    // prima della scrittura: dopo non ci sarebbe più niente da leggere
    expect(vi.mocked(noteIncidentsBeforeCIDeletion).mock.invocationCallOrder[0]!)
      .toBeLessThan(session.executeWrite.mock.invocationCallOrder[0]!)
  })

  it('rifiuta un label non sicuro al build time', () => {
    expect(() => buildDeleteMutation('Server) DETACH DELETE (x')).toThrow()
  })

  // ── Servizi monitorati, ondata 4 §4 ───────────────────────────────────────
  it('cancellando una BusinessApplication vanno via anche la sua ServiceMap e la cronologia; l\'incident del servizio NO (è storia del ticket)', async () => {
    const session = fakeSession()
    vi.mocked(withSession).mockImplementation((fn) => fn(session as never))
    const del = buildDeleteMutation('BusinessApplication')

    await expect(del(undefined, { id: 'ba-1' }, ctx)).resolves.toBe(true)
    // una sola scrittura: alias, mappa, cronologia e CI nello stesso statement
    expect(session.executeWrite).toHaveBeenCalledTimes(1)
    const [cypher, params] = session.run.mock.calls[0]!
    expect(cypher).toContain('OPTIONAL MATCH (n)-[:HAS_SERVICE_MAP]->(m:ServiceMap {tenant_id: $tenantId})')
    expect(cypher).toContain('OPTIONAL MATCH (m)-[:HAS_HEALTH_HISTORY]->(h:ServiceHealthEntry {tenant_id: $tenantId})')
    expect(cypher).toMatch(/DETACH DELETE a, h, m, n/)
    // le INCLUDES/EXCLUDES/IMPACTS_SERVICE cadono con il DETACH DELETE della mappa:
    // nessun DELETE esplicito sull'Incident collegato
    expect(cypher).not.toMatch(/DELETE[^\n]*\bi\b/)
    expect(cypher).not.toContain('Incident')
    expect(params).toEqual({ id: 'ba-1', tenantId: 't1' })
  })

  it('cancellando un CI qualunque la clausola della mappa non trova nulla: la mappa che lo includeva resta (diventerà stale)', async () => {
    const session = fakeSession()
    vi.mocked(withSession).mockImplementation((fn) => fn(session as never))
    await buildDeleteMutation('Server')(undefined, { id: 'ci-1' }, ctx)
    const [cypher] = session.run.mock.calls[0]!
    // nessun MATCH sulle INCLUDES: la mappa non viene toccata, perde solo la relazione
    expect(cypher).not.toContain('INCLUDES')
    expect(cypher).toContain('OPTIONAL MATCH (n)-[:HAS_SERVICE_MAP]->(m:ServiceMap {tenant_id: $tenantId})')
  })

  // ── Servizi monitorati, ondata 5 (mappa viva) ─────────────────────────────
  it('avvisa il motore dei servizi DOPO la cancellazione (le mappe vive si risincronizzano subito); un errore di coda non fa fallire la cancellazione', async () => {
    const session = fakeSession()
    vi.mocked(withSession).mockImplementation((fn) => fn(session as never))
    await buildDeleteMutation('Server')(undefined, { id: 'ci-1' }, ctx)
    expect(notifyCIGraphChanged).toHaveBeenCalledWith('t1', ['ci-1'], 'ci.deleted')
    // dopo la scrittura, mai prima
    expect(session.executeWrite).toHaveBeenCalledTimes(1)
    expect(vi.mocked(notifyCIGraphChanged).mock.invocationCallOrder[0]!).toBeGreaterThan(session.executeWrite.mock.invocationCallOrder[0]!)

    // la notifica non lancia mai (lo garantisce sync.ts): anche così la cancellazione resta riuscita
    vi.mocked(notifyCIGraphChanged).mockResolvedValueOnce(0)
    await expect(buildDeleteMutation('Server')(undefined, { id: 'ci-2' }, ctx)).resolves.toBe(true)
  })
})
