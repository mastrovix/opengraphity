/**
 * B-08 / F-13 — manual CI creation carries the :ConfigurationItem label like
 * discovery does, and the metamodel validation (required, field and type
 * validation scripts) runs server side through the scripting sandbox.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CITypeWithDefinitions } from '@opengraphity/schema-generator'

const runScript = vi.fn()
vi.mock('@opengraphity/scripting', () => ({ runScript: (...a: unknown[]) => runScript(...a) }))
vi.mock('../ci-utils.js', () => ({ withSession: vi.fn() }))
vi.mock('../../../lib/cache.js', () => ({ cache: { invalidate: vi.fn() } }))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../lib/chainCalculator.js', () => ({ calculateChain: vi.fn().mockResolvedValue(undefined) }))

const { buildCreateMutation, buildUpdateMutation, validateCIInput } = await import('../ciMutations.js')
const { withSession } = await import('../ci-utils.js')

const IP_SCRIPT = 'if (!/^\\d+\\.\\d+\\.\\d+\\.\\d+$/.test(value)) throw new Error("IP non valido")'

function ciType(over: Partial<CITypeWithDefinitions> = {}): CITypeWithDefinitions {
  return {
    id: 'ct-server', name: 'server', label: 'Server', neo4jLabel: 'Server', icon: '', color: '',
    validationScript: null,
    fields: [
      { id: 'f1', name: 'ipAddress', label: 'IP', type: 'string', required: true,  defaultValue: null, enumValues: [], validationScript: IP_SCRIPT, visibilityScript: null, defaultScript: null, isSystem: false },
      { id: 'f2', name: 'rack',      label: 'Rack', type: 'string', required: false, defaultValue: null, enumValues: [], validationScript: null,      visibilityScript: null, defaultScript: null, isSystem: false },
      { id: 'f3', name: 'createdAt', label: 'Creato', type: 'datetime', required: true, defaultValue: null, enumValues: [], validationScript: null,  visibilityScript: null, defaultScript: null, isSystem: true },
    ],
    relations: [],
    ...over,
  } as unknown as CITypeWithDefinitions
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
