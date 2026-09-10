import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Migration } from '../migrations.js'

// ── Fake driver/session (no Neo4j) ───────────────────────────────────────────
// The session script is hoisted so the vi.mock factories can reach it.

const fake = vi.hoisted(() => {
  interface Call { mode: string; cypher: string }
  interface Row { keys: string[]; get: (k: string) => unknown }
  const state = {
    calls: [] as Call[],
    opened: 0,
    closed: 0,
    /** precheck label fragment (from its Cypher) → duplicate rows to return */
    duplicates: new Map<string, Array<Record<string, unknown>>>(),
    /** cypher fragment whose statement rejects */
    failOn: null as string | null,
    reset() {
      this.calls = []; this.opened = 0; this.closed = 0
      this.duplicates.clear(); this.failOn = null
    },
  }
  function row(obj: Record<string, unknown>): Row {
    return { keys: Object.keys(obj), get: (k: string) => obj[k] }
  }
  function session(opts: { defaultAccessMode: string }) {
    state.opened++
    return {
      run: async (cypher: string) => {
        state.calls.push({ mode: opts.defaultAccessMode, cypher })
        if (state.failOn && cypher.includes(state.failOn)) throw new Error('boom: constraint conflicts with existing index')
        for (const [fragment, rows] of state.duplicates) {
          if (cypher.includes(fragment)) return { records: rows.map(row) }
        }
        return { records: [] }
      },
      close: async () => { state.closed++ },
    }
  }
  return { state, session }
})

vi.mock('../driver.js', () => ({
  getDriver: () => ({ session: fake.session }),
  closeDriver: vi.fn(async () => {}),
}))
vi.mock('../migrations.js', () => ({
  runMigrations: vi.fn(async () => ({ applied: [], skipped: [] })),
}))

const { initSchema } = await import('../init.js')
const { closeDriver } = await import('../driver.js')
const { runMigrations } = await import('../migrations.js')
const runMigrationsMock = vi.mocked(runMigrations)

const calls = () => fake.state.calls
const cyphers = (mode?: string) => calls().filter(c => !mode || c.mode === mode).map(c => c.cypher)
const isPrecheck = (c: string) => /WHERE size\((ids|nodes|keys)\) > 1/.test(c)

beforeEach(() => {
  fake.state.reset()
  runMigrationsMock.mockClear()
  runMigrationsMock.mockResolvedValue({ applied: [], skipped: [] } as unknown as Awaited<ReturnType<typeof runMigrations>>)
  vi.mocked(closeDriver).mockClear()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('initSchema — clean database', () => {
  it('runs the duplicate prechecks (READ) first, then constraints, indexes and counter seeds (WRITE)', async () => {
    const log: string[] = []
    await expect(initSchema({ log: m => log.push(m) })).resolves.toBeUndefined()

    const prechecks = calls().filter(c => isPrecheck(c.cypher))
    expect(prechecks).toHaveLength(6)
    expect(prechecks.every(c => c.mode === 'READ')).toBe(true)
    // every precheck precedes the first schema statement
    const firstCreate = calls().findIndex(c => c.cypher.startsWith('CREATE '))
    const lastPrecheck = calls().map(c => isPrecheck(c.cypher)).lastIndexOf(true)
    expect(lastPrecheck).toBeLessThan(firstCreate)

    const writes = cyphers('WRITE')
    for (const expected of [
      'CREATE CONSTRAINT tenant_id_unique IF NOT EXISTS FOR (n:Tenant) REQUIRE n.id IS UNIQUE',
      'CREATE CONSTRAINT user_id_unique IF NOT EXISTS FOR (n:User) REQUIRE n.id IS UNIQUE',
      'CREATE CONSTRAINT user_tenant_email_unique IF NOT EXISTS FOR (n:User) REQUIRE (n.tenant_id, n.email) IS UNIQUE',
      'CREATE CONSTRAINT ci_id_unique IF NOT EXISTS FOR (n:ConfigurationItem) REQUIRE n.id IS UNIQUE',
      'CREATE CONSTRAINT ci_discovery_key_unique IF NOT EXISTS FOR (n:ConfigurationItem) REQUIRE (n.tenant_id, n.discovery_source_id, n.discovery_external_id) IS UNIQUE',
      'CREATE CONSTRAINT incident_id_unique IF NOT EXISTS FOR (n:Incident) REQUIRE n.id IS UNIQUE',
      'CREATE CONSTRAINT change_id_unique IF NOT EXISTS FOR (n:Change) REQUIRE n.id IS UNIQUE',
      'CREATE CONSTRAINT problem_id_unique IF NOT EXISTS FOR (n:Problem) REQUIRE n.id IS UNIQUE',
      'CREATE CONSTRAINT service_request_id_unique IF NOT EXISTS FOR (n:ServiceRequest) REQUIRE n.id IS UNIQUE',
      'CREATE CONSTRAINT workflow_instance_id_unique IF NOT EXISTS FOR (n:WorkflowInstance) REQUIRE n.id IS UNIQUE',
      'CREATE CONSTRAINT incident_number_unique IF NOT EXISTS FOR (n:Incident) REQUIRE (n.tenant_id, n.number) IS UNIQUE',
      'CREATE CONSTRAINT change_code_unique IF NOT EXISTS FOR (n:Change) REQUIRE (n.tenant_id, n.code) IS UNIQUE',
      'CREATE CONSTRAINT counter_key_unique IF NOT EXISTS FOR (n:Counter) REQUIRE (n.tenant_id, n.kind) IS UNIQUE',
      'CREATE CONSTRAINT api_key_hash_unique IF NOT EXISTS FOR (n:ApiKey) REQUIRE n.key_hash IS UNIQUE',
      'CREATE CONSTRAINT kb_article_id_unique IF NOT EXISTS FOR (n:KBArticle) REQUIRE n.id IS UNIQUE',
      'CREATE CONSTRAINT team_id_unique IF NOT EXISTS FOR (n:Team) REQUIRE n.id IS UNIQUE',
      'CREATE CONSTRAINT workflow_definition_id_unique IF NOT EXISTS FOR (n:WorkflowDefinition) REQUIRE n.id IS UNIQUE',
      'CREATE CONSTRAINT migration_id_unique IF NOT EXISTS FOR (n:Migration) REQUIRE n.id IS UNIQUE',
      'CREATE CONSTRAINT migration_lock_id_unique IF NOT EXISTS FOR (n:MigrationLock) REQUIRE n.id IS UNIQUE',
      'CREATE CONSTRAINT event_id_unique IF NOT EXISTS FOR (n:Event) REQUIRE n.id IS UNIQUE',
      'CREATE CONSTRAINT event_tenant_fingerprint_unique IF NOT EXISTS FOR (n:Event) REQUIRE (n.tenant_id, n.fingerprint) IS UNIQUE',
      'CREATE CONSTRAINT ci_alias_id_unique IF NOT EXISTS FOR (n:CIAlias) REQUIRE n.id IS UNIQUE',
      'CREATE CONSTRAINT ci_alias_tenant_kind_value_unique IF NOT EXISTS FOR (n:CIAlias) REQUIRE (n.tenant_id, n.kind, n.value) IS UNIQUE',
      // Cronologia dell'allarme (services/events/history.ts): unicità della voce e lettura per evento ordinata per istante
      'CREATE CONSTRAINT event_history_entry_id_unique IF NOT EXISTS FOR (n:EventHistoryEntry) REQUIRE n.id IS UNIQUE',
      'CREATE INDEX event_history_tenant_event IF NOT EXISTS FOR (n:EventHistoryEntry) ON (n.tenant_id, n.event_id, n.at)',
      // Servizi monitorati (apps/api/src/services/serviceImpact/): mappa unica per id, cronologia unica per id, lookup per servizio/stato, cronologia per mappa ordinata per istante
      'CREATE CONSTRAINT service_map_id_unique IF NOT EXISTS FOR (n:ServiceMap) REQUIRE n.id IS UNIQUE',
      'CREATE CONSTRAINT service_health_entry_id_unique IF NOT EXISTS FOR (n:ServiceHealthEntry) REQUIRE n.id IS UNIQUE',
      'CREATE INDEX service_map_tenant_service IF NOT EXISTS FOR (n:ServiceMap) ON (n.tenant_id, n.service_id)',
      'CREATE INDEX service_map_tenant_status IF NOT EXISTS FOR (n:ServiceMap) ON (n.tenant_id, n.status)',
      'CREATE INDEX service_health_tenant_map IF NOT EXISTS FOR (n:ServiceHealthEntry) ON (n.tenant_id, n.map_id, n.at)',
      'CREATE INDEX incident_tenant_id IF NOT EXISTS FOR (n:Incident) ON (n.tenant_id)',
      'CREATE INDEX event_tenant_status_last_seen IF NOT EXISTS FOR (n:Event) ON (n.tenant_id, n.status, n.last_seen_at)',
      // Event Management (revisione, ondata 1): tempeste per sorgente, rivalutazioni per correlazione, CI per nome
      'CREATE INDEX event_tenant_source IF NOT EXISTS FOR (n:Event) ON (n.tenant_id, n.source_id)',
      'CREATE INDEX event_tenant_correlation IF NOT EXISTS FOR (n:Event) ON (n.tenant_id, n.correlation)',
      'CREATE INDEX ci_tenant_name_key IF NOT EXISTS FOR (n:ConfigurationItem) ON (n.tenant_id, n.name_key)',
      // Event Management (revisione, ondata 3 — prestazioni): vista "tutti gli stati", conservazione/resolved24h, ricerca full-text della console
      'CREATE INDEX event_tenant_last_seen IF NOT EXISTS FOR (n:Event) ON (n.tenant_id, n.last_seen_at)',
      'CREATE INDEX event_tenant_resolved IF NOT EXISTS FOR (n:Event) ON (n.tenant_id, n.resolved_at)',
      'CREATE FULLTEXT INDEX event_search IF NOT EXISTS FOR (n:Event) ON EACH [n.title, n.resource]',
      'CREATE INDEX notification_rule_tenant_event IF NOT EXISTS FOR (n:NotificationRule) ON (n.tenant_id, n.event_type)',
    ]) {
      expect(writes).toContain(expected)
    }
    expect(writes.some(c => c.startsWith('CREATE FULLTEXT INDEX global_search IF NOT EXISTS'))).toBe(true)
    // ogni indice è dichiarato una volta sola (init.ts è la sorgente unica: niente doppioni fra ondate)
    const names = writes.filter(c => c.startsWith('CREATE INDEX') || c.startsWith('CREATE FULLTEXT INDEX')).map(c => c.split(' IF NOT EXISTS')[0])
    expect(new Set(names).size).toBe(names.length)
    // every schema statement is idempotent
    expect(writes.filter(c => c.startsWith('CREATE ')).every(c => c.includes('IF NOT EXISTS'))).toBe(true)
    expect(writes.filter(c => c.startsWith('DROP INDEX')).every(c => c.includes('IF EXISTS'))).toBe(true)

    // the superseded range indexes are dropped BEFORE the constraint that replaces them
    expect(writes.indexOf('DROP INDEX user_tenant_email IF EXISTS'))
      .toBeLessThan(writes.findIndex(c => c.includes('user_tenant_email_unique')))
    expect(writes.indexOf('DROP INDEX ci_discovery_key IF EXISTS'))
      .toBeLessThan(writes.findIndex(c => c.includes('ci_discovery_key_unique')))

    // order: all constraints → all indexes → counter seeds
    const firstIndex   = writes.findIndex(c => c.startsWith('CREATE INDEX') || c.startsWith('CREATE FULLTEXT'))
    const lastConstraint = writes.map(c => c.startsWith('CREATE CONSTRAINT')).lastIndexOf(true)
    const firstSeed    = writes.findIndex(c => c.includes('MERGE (c:Counter'))
    const lastIndex    = writes.map(c => c.startsWith('CREATE INDEX') || c.startsWith('CREATE FULLTEXT')).lastIndexOf(true)
    expect(lastConstraint).toBeLessThan(firstIndex)
    expect(lastIndex).toBeLessThan(firstSeed)
    expect(writes.filter(c => c.includes('MERGE (c:Counter'))).toHaveLength(5)
    for (const kind of ['incident', 'problem', 'service_request', 'change', 'task']) {
      expect(writes.some(c => c.includes(`kind: '${kind}'`))).toBe(true)
    }

    // sessions: 1 READ (prechecks) + 3 WRITE (constraints/indexes/seeds), all closed
    expect(fake.state.opened).toBe(4)
    expect(fake.state.closed).toBe(4)
    expect(log[0]).toContain('Starting schema initialisation')
    expect(log.some(m => m.includes('Schema initialisation complete'))).toBe(true)
    expect(log.some(m => m.includes('No migrations passed'))).toBe(true)
    expect(runMigrationsMock).not.toHaveBeenCalled()
    // initSchema does not own the driver
    expect(closeDriver).not.toHaveBeenCalled()
  })

  it('defaults to console.log when no log option is given', async () => {
    await initSchema()
    const logged = vi.mocked(console.log).mock.calls.map(c => String(c[0]))
    expect(logged.some(m => m.includes('Precheck ok: no duplicates for User(tenant_id, email)'))).toBe(true)
    expect(logged.some(m => m.includes('Constraint applied: Tenant.id'))).toBe(true)
  })
})

describe('initSchema — duplicate precheck', () => {
  it('User(tenant_id, email) duplicates → fails listing every duplicate group, the inspection Cypher and the hint; no constraint is created', async () => {
    fake.state.duplicates.set('MATCH (u:User)', [
      { tenant_id: 't1', email: 'a@x.example', ids: ['u1', 'u2'] },
      { tenant_id: 't2', email: 'b@x.example', ids: ['u3', 'u4', 'u5'] },
    ])
    const err = await initSchema({ log: () => {} }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    const msg = (err as Error).message
    expect(msg).toContain('Uniqueness constraint on User(tenant_id, email) cannot be created: 2 duplicate group(s) found')
    expect(msg).toContain('{"tenant_id":"t1","email":"a@x.example","ids":["u1","u2"]}')
    expect(msg).toContain('{"tenant_id":"t2","email":"b@x.example","ids":["u3","u4","u5"]}')
    expect(msg).toContain('Inspect with:')
    expect(msg).toContain('MATCH (u:User) WHERE u.tenant_id IS NOT NULL AND u.email IS NOT NULL')
    expect(msg).toContain('Merge or delete the duplicate User nodes')

    expect(cyphers().some(c => c.startsWith('CREATE ') || c.startsWith('DROP '))).toBe(false)
    expect(cyphers('WRITE')).toHaveLength(0)
    // the first precheck failed: the later ones did not run
    expect(calls().filter(c => isPrecheck(c.cypher))).toHaveLength(1)
    expect(fake.state.opened).toBe(1)
    expect(fake.state.closed).toBe(1)
  })

  it('duplicates in a later precheck (ApiKey.key_hash) → the earlier prechecks passed, the message names that check', async () => {
    fake.state.duplicates.set('MATCH (k:ApiKey)', [
      { key_hash: 'abc', keys: [{ id: 'k1', tenant_id: 't1', name: 'ci' }, { id: 'k2', tenant_id: 't1', name: 'ci-copy' }] },
    ])
    await expect(initSchema({ log: () => {} })).rejects.toThrow(/Uniqueness constraint on ApiKey\(key_hash\) cannot be created: 1 duplicate group\(s\)/)
    const err = await initSchema({ log: () => {} }).then(() => { throw new Error('expected initSchema to reject') }, (e: unknown) => e as Error)
    expect(err.message).toContain('"key_hash":"abc"')
    expect(err.message).toContain('"name":"ci-copy"')
    expect(err.message).toContain('Two API keys share the same hash')
    expect(cyphers('WRITE')).toHaveLength(0)
  })

  it('all six prechecks target the constrained labels', async () => {
    await initSchema({ log: () => {} })
    const pre = cyphers('READ')
    expect(pre.some(c => c.includes('MATCH (u:User)'))).toBe(true)
    expect(pre.some(c => c.includes('MATCH (ci:ConfigurationItem)') && c.includes('discovery_external_id'))).toBe(true)
    expect(pre.some(c => c.includes('MATCH (k:ApiKey)'))).toBe(true)
    expect(pre.some(c => c.includes('MATCH (a:KBArticle)'))).toBe(true)
    expect(pre.some(c => c.includes('MATCH (t:Team)'))).toBe(true)
    expect(pre.some(c => c.includes('MATCH (w:WorkflowDefinition)'))).toBe(true)
  })
})

describe('initSchema — statement failure propagates', () => {
  it('a failing constraint → "Constraint failed: <label>" with the Cypher and the driver reason; later statements do not run', async () => {
    fake.state.failOn = 'incident_id_unique'
    const err = await initSchema({ log: () => {} }).then(() => { throw new Error('expected initSchema to reject') }, (e: unknown) => e as Error)
    expect(err.message).toMatch(/^Constraint failed: Incident\.id\n/)
    expect(err.message).toContain('CREATE CONSTRAINT incident_id_unique IF NOT EXISTS FOR (n:Incident) REQUIRE n.id IS UNIQUE')
    expect(err.message).toContain('→ boom: constraint conflicts with existing index')

    const writes = cyphers('WRITE')
    expect(writes[writes.length - 1]).toContain('incident_id_unique')
    expect(writes.some(c => c.includes('change_id_unique'))).toBe(false)
    expect(writes.some(c => c.startsWith('CREATE INDEX'))).toBe(false)
    // READ + the one WRITE session, both closed
    expect(fake.state.opened).toBe(2)
    expect(fake.state.closed).toBe(2)
  })

  it('a failing index → "Index failed: …"; a failing counter seed → "CounterSeed failed: …"', async () => {
    fake.state.failOn = 'CREATE INDEX change_tenant_status'
    await expect(initSchema({ log: () => {} })).rejects.toThrow(/^Index failed: Change\(tenant_id, status\)/)
    expect(cyphers().some(c => c.includes('MERGE (c:Counter'))).toBe(false)

    fake.state.reset()
    fake.state.failOn = "kind: 'change'"
    await expect(initSchema({ log: () => {} })).rejects.toThrow(/^CounterSeed failed: seed change counter/)
    expect(cyphers().some(c => c.includes("kind: 'task'"))).toBe(false)
  })

})

describe('initSchema — migrations', () => {
  const migrations: Migration[] = [
    { id: '20260901_1000_seed', description: 'seed', up: async () => {} },
  ]

  it('runs the given migrations AFTER the schema on a WRITE session, and closes it', async () => {
    runMigrationsMock.mockResolvedValueOnce({ applied: ['20260901_1000_seed'], skipped: [] } as unknown as Awaited<ReturnType<typeof runMigrations>>)
    const log: string[] = []
    await initSchema({ migrations, log: m => log.push(m) })

    expect(runMigrationsMock).toHaveBeenCalledTimes(1)
    const [passed, opts] = runMigrationsMock.mock.calls[0]!
    expect(passed).toBe(migrations)
    expect(typeof (opts as { session: { run: unknown } }).session.run).toBe('function')
    expect((opts as { log: unknown }).log).toBeTypeOf('function')
    // schema finished before the migrations started
    expect(log.indexOf('[neo4j:init] Schema initialisation complete.')).toBeLessThan(log.findIndex(m => m.includes('Migrations: 1 applied')))
    expect(log.some(m => m.includes('No migrations passed'))).toBe(false)
    // READ + 3 WRITE + 1 migration session, all closed
    expect(fake.state.opened).toBe(5)
    expect(fake.state.closed).toBe(5)
  })

  it('a migration failure propagates and the migration session is still closed', async () => {
    runMigrationsMock.mockRejectedValueOnce(new Error('migration 20260901_1000_seed failed'))
    await expect(initSchema({ migrations, log: () => {} })).rejects.toThrow('migration 20260901_1000_seed failed')
    expect(fake.state.opened).toBe(5)
    expect(fake.state.closed).toBe(5)
  })

  it('migrations are not run when a precheck fails', async () => {
    fake.state.duplicates.set('MATCH (t:Team)', [{ id: 'team-1', nodes: [{ tenant_id: 't1', name: 'A' }, { tenant_id: 't1', name: 'B' }] }])
    await expect(initSchema({ migrations, log: () => {} })).rejects.toThrow(/Team\(id\)/)
    expect(runMigrationsMock).not.toHaveBeenCalled()
  })
})
