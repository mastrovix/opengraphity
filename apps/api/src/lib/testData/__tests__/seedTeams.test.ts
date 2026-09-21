/**
 * DATI DI TEST — i team.
 *
 * Due famiglie di asserzioni, e la seconda è quella che serve davvero:
 *
 *  1. il nodo scritto è IDENTICO a quello della mutation `createTeam` — un
 *     campo mancante rende il dato di test un finto difetto (i 70 team di
 *     `c-one` non hanno `sourcing`, e in lista compaiono senza provenienza);
 *  2. i NOMI sono verosimili. `TEA-001`…`TEA-070` non mettono sotto sforzo
 *     nessuna colonna, nessun ordinamento e nessun filtro: una demo con quei
 *     nomi mostra un prodotto che non è quello che il cliente userà.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const scritture: Array<Record<string, unknown>> = []
let nascono = true

vi.mock('@opengraphity/neo4j', () => ({
  runQuery: vi.fn(async (_s: unknown, cypher: string, params: Record<string, unknown>) => {
    if (cypher.includes('MERGE (t:Team')) {
      scritture.push(params)
      return [{ nato: nascono }]
    }
    if (cypher.includes('count(t) AS totale')) return [{ totale: scritture.length }]
    return []
  }),
}))
const assertDomainValue = vi.fn(async (_t: string, _v: string, value: unknown) => value as string)
vi.mock('../../domainMatrix.js', () => ({ assertDomainValue: (t: string, v: string, value: unknown) => assertDomainValue(t, v, value) }))

const { seedTestTeams } = await import('../seedTeams.js')
const { TEST_TEAM_NAMES, TEST_TEAM_PREFIX } = await import('../teamNames.js')

const sessione = {} as never
beforeEach(() => {
  scritture.length = 0
  nascono = true
  assertDomainValue.mockClear()
  assertDomainValue.mockImplementation(async (_t, _v, value) => value as string)
})

describe('i nomi dei team di esercizio', () => {
  it('sono 150, tutti distinti', () => {
    expect(TEST_TEAM_NAMES).toHaveLength(150)
    expect(new Set(TEST_TEAM_NAMES).size).toBe(150)
  })

  it('NESSUNO è un codice progressivo: è il difetto da cui nasce questo seme', () => {
    // `TEA-001` e parenti: un nome che non somiglia a niente di vero.
    for (const nome of TEST_TEAM_NAMES) {
      expect(nome, nome).not.toMatch(/^[A-Z]{2,4}[-_ ]?\d+$/)
      expect(nome, nome).not.toMatch(/\b(team|gruppo)\s*\d+\b/i)
    }
  })

  it('sono nomi leggibili: parole, non sigle vuote', () => {
    for (const nome of TEST_TEAM_NAMES) {
      expect(nome.length, nome).toBeGreaterThan(3)
      expect(nome, nome).toMatch(/[A-Za-z]{3,}/)
    }
  })
})

describe('seedTestTeams', () => {
  it('scrive 150 team, tutti col prefisso scelto dal proprietario', async () => {
    const esito = await seedTestTeams(sessione, 'demo')
    expect(scritture).toHaveLength(150)
    for (const s of scritture) expect(String(s['name'])).toMatch(new RegExp(`^${TEST_TEAM_PREFIX}`))
    expect(esito.creati).toBe(150)
  })

  it('tutti `owner` e tutti `internal`', async () => {
    await seedTestTeams(sessione, 'demo', { quanti: 3 })
    expect(assertDomainValue).toHaveBeenCalledWith('demo', 'team_type', 'owner')
    for (const s of scritture) expect(s['tipo']).toBe('owner')
  })

  it('il nodo ha gli stessi campi della mutation: niente `sourcing` mancante', async () => {
    await seedTestTeams(sessione, 'demo', { quanti: 1 })
    const runQuery = vi.mocked((await import('@opengraphity/neo4j')).runQuery)
    const cypher = String(runQuery.mock.calls[0]![1])
    for (const campo of ['t.id', 't.description', 't.type', "t.sourcing    = 'internal'", 't.created_at', 't.updated_at']) {
      expect(cypher, campo).toContain(campo)
    }
  })

  it('la chiave del MERGE è tenant + nome: premerlo due volte non raddoppia', async () => {
    nascono = false   // esistono già
    const esito = await seedTestTeams(sessione, 'demo', { quanti: 10 })
    const runQuery = vi.mocked((await import('@opengraphity/neo4j')).runQuery)
    expect(String(runQuery.mock.calls[0]![1])).toContain('MERGE (t:Team {tenant_id: $tenantId, name: $name})')
    expect(esito.creati).toBe(0)
  })

  it('`quanti` prende i PRIMI, così un tenant piccolo resta verosimile', async () => {
    // L'elenco è ordinato per area: prendere i primi N dà infrastruttura,
    // rete, database… Prenderli a caso darebbe «tutte reti e niente altro».
    await seedTestTeams(sessione, 'demo', { quanti: 5 })
    expect(scritture.map((s) => s['name'])).toEqual(
      TEST_TEAM_NAMES.slice(0, 5).map((n) => `${TEST_TEAM_PREFIX}${n}`),
    )
  })

  it('`quanti` più grande dell\'elenco non si lamenta: scrive quelli che ci sono', async () => {
    await seedTestTeams(sessione, 'demo', { quanti: 5000 })
    expect(scritture).toHaveLength(150)
  })

  it('`quanti` a zero si rifiuta invece di non fare niente in silenzio', async () => {
    await expect(seedTestTeams(sessione, 'demo', { quanti: 0 })).rejects.toThrow(/at least 1/)
  })

  it('se il cliente ha RINOMINATO «owner» il seme si ferma', async () => {
    // Scrivere `type: "owner"` a dispetto del vocabolario darebbe 150 team con
    // un tipo che nessuna pastiglia e nessun filtro riconoscono.
    assertDomainValue.mockRejectedValueOnce(new Error('team_type: "owner" is not in the dictionary of this tenant') as never)
    await expect(seedTestTeams(sessione, 'demo')).rejects.toThrow(/not in the dictionary/)
    expect(scritture).toHaveLength(0)
  })

  it('ogni team dice di essere un dato di test nella descrizione', async () => {
    await seedTestTeams(sessione, 'demo', { quanti: 2 })
    for (const s of scritture) expect(s['description']).toBe('Test data')
  })
})
