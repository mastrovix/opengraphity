/**
 * IL TIPO DI TEAM È UN VOCABOLARIO, E SI PUÒ SCRIVERE.
 *
 * Il difetto che questi test pinnano, trovato nel browser: la pagina «Team e
 * Utenti» mostrava la colonna «Type» e offriva un filtro con `owner` e
 * `support`, ma
 *
 *   - `CreateTeamInput` non aveva il campo `type`,
 *   - `createTeam` scriveva `type: null` — sempre, per ogni team,
 *   - non esisteva nessuna mutation per cambiarlo dopo,
 *   - `type` non era fra `TEAM_ALLOWED_FIELDS`, quindi il filtro non filtrava.
 *
 * Risultato: un team creato dall'interfaccia nasceva senza tipo e ci restava
 * per sempre, e i due valori vivevano scritti a mano nella pagina invece che
 * nel Dizionario del cliente.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const run = vi.fn()
const runQuery = vi.fn()
const runQueryOne = vi.fn()
const assertDomainValue = vi.fn()

vi.mock('@opengraphity/neo4j', () => ({
  runQuery, runQueryOne,
  withSession: (fn: (s: unknown) => unknown) => fn({ run, executeWrite: (f: (tx: unknown) => unknown) => f({ run }) }),
}))
vi.mock('../../../lib/domainMatrix.js', () => ({ assertDomainValue }))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn() }))
vi.mock('../../../lib/mappers.js', () => ({ mapTeam: (p: unknown) => p }))
vi.mock('../ci-utils.js', () => ({
  mapCI: (x: unknown) => x, ciTypeFromLabels: () => 'server',
  withSession: (fn: (s: unknown) => unknown) => fn({ run, executeWrite: (f: (tx: unknown) => unknown) => f({ run }) }),
}))
vi.mock('../../../lib/ciLabelsForTenant.js', () => ({ ciLabelPredicateForTenant: () => 'true' }))
vi.mock('../../../lib/filterBuilder.js', () => ({ buildAdvancedWhere: () => '' }))

const { teamResolvers } = await import('../team.js')
const ctx = { tenantId: 'c-test', userId: 'u1', role: 'admin' } as never

beforeEach(() => {
  vi.clearAllMocks()
  // Come quello vero: un valore mancante e un rifiuto, non un null accettato.
  assertDomainValue.mockImplementation((_t: string, vocab: string, value: unknown) =>
    typeof value === 'string' && value !== ''
      ? Promise.resolve(value)
      : Promise.reject(new Error(`${vocab}: value missing or not a string`)))
  runQuery.mockResolvedValue([{ props: { id: 't1' } }])
  runQueryOne.mockResolvedValue({ props: { id: 't1' } })
})

/** Un team valido dice sempre se e interno o esterno: i test del TIPO partono da li. */
const createTeam = (input: Record<string, unknown>) =>
  (teamResolvers.Mutation.createTeam as (a: unknown, b: unknown, c: unknown) => Promise<unknown>)(
    null, { input: { sourcing: 'internal', type: 'owner', ...input } }, ctx)
const updateTeam = (id: string, input: Record<string, unknown>) =>
  (teamResolvers.Mutation.updateTeam as (a: unknown, b: unknown, c: unknown) => Promise<unknown>)(null, { id, input }, ctx)

describe('createTeam — il tipo arriva dal vocabolario, non da null', () => {
  it('IL DIFETTO: un tipo passato viene SCRITTO (prima finiva sempre null)', async () => {
    await createTeam({ name: 'Rete', type: 'owner' })
    expect(runQuery.mock.calls[0]?.[2]).toMatchObject({ type: 'owner' })
  })

  it('e passa dal vocabolario del cliente: un valore fuori vocabolario e un rifiuto', async () => {
    assertDomainValue.mockRejectedValue(new Error('team_type: "ownr" is not in the dictionary of this tenant'))
    await expect(createTeam({ name: 'Rete', type: 'ownr' })).rejects.toThrow(/not in the dictionary/)
    expect(runQuery).not.toHaveBeenCalled()   // nessuna scrittura
  })

  it('il vocabolario interrogato e `team_type`, lo stesso nome che usa il web', async () => {
    await createTeam({ name: 'Rete', type: 'support' })
    expect(assertDomainValue).toHaveBeenCalledWith('c-test', 'team_type', 'support')
  })

  it.each([[undefined], [null], ['']])('il tipo e OBBLIGATORIO in creazione: senza (%s) e un rifiuto, e nessuna scrittura', async (type) => {
    await expect(createTeam({ name: 'Rete', type })).rejects.toThrow(/value missing/)
    expect(runQuery).not.toHaveBeenCalled()
  })
})

describe('updateTeam — cambiare il tipo di un team che esiste', () => {
  it('manda solo i campi presenti: dare un tipo non azzera nome e descrizione', async () => {
    await updateTeam('t1', { type: 'owner' })
    const cypher = String(runQueryOne.mock.calls[0]?.[1])
    expect(cypher).toContain('t.type = $type')
    expect(cypher).not.toContain('t.name = $name')
    expect(cypher).not.toContain('t.description = $description')
  })

  it.each([[null], ['']])('il tipo si cambia ma NON si toglie (%s): obbligatorio in creazione, non svuotabile dopo', async (type) => {
    await expect(updateTeam('t1', { type })).rejects.toThrow(/value missing/)
    expect(runQueryOne).not.toHaveBeenCalled()
  })

  it('un tipo fuori vocabolario e un rifiuto, e NESSUNA scrittura parte', async () => {
    assertDomainValue.mockRejectedValue(new Error('team_type: "zombie" is not in the dictionary of this tenant'))
    await expect(updateTeam('t1', { type: 'zombie' })).rejects.toThrow(/not in the dictionary/)
    expect(runQueryOne).not.toHaveBeenCalled()
  })

  it('un nome vuoto e un rifiuto: rinominare a «» non e una rinomina', async () => {
    await expect(updateTeam('t1', { name: '   ' })).rejects.toThrow(/cannot be empty/)
  })

  it('un team che non esiste e NOT_FOUND, non un successo muto', async () => {
    runQueryOne.mockResolvedValue(null)
    await expect(updateTeam('assente', { type: 'owner' })).rejects.toThrow(/assente/)
  })
})

describe('il filtro della pagina filtra davvero', () => {
  it('`type` e fra i campi filtrabili: il filtro che la pagina offre arriva al Cypher', async () => {
    // Era il quarto pezzo dello stesso difetto: la tendina c'era, il filtro
    // partiva, e `buildAdvancedWhere` scartava `type` perche' non era in lista.
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../team.ts', import.meta.url), 'utf8'))
    const lista = /TEAM_ALLOWED_FIELDS = new Set\(\[([^\]]*)\]\)/.exec(src)?.[1] ?? ''
    expect(lista).toContain("'type'")
  })
})

describe('interno o esterno — ogni team lo dice', () => {
  it.each([['internal'], ['external']])('createTeam scrive sourcing = %s', async (sourcing) => {
    await createTeam({ name: 'Rete', sourcing })
    expect(runQuery.mock.calls[0]?.[2]).toMatchObject({ sourcing })
  })

  it.each([[undefined], [null], [''], ['esterno'], ['EXTERNAL']])(
    'createTeam senza un valore ammesso (%s) e un rifiuto, e NESSUNA scrittura parte', async (sourcing) => {
      await expect(createTeam({ name: 'Rete', sourcing })).rejects.toThrow(/internal or external/)
      expect(runQuery).not.toHaveBeenCalled()
    })

  it('updateTeam lo cambia', async () => {
    await updateTeam('t1', { sourcing: 'external' })
    expect(String(runQueryOne.mock.calls[0]?.[1])).toContain('t.sourcing = $sourcing')
    expect(runQueryOne.mock.calls[0]?.[2]).toMatchObject({ sourcing: 'external' })
  })

  it.each([[null], ['']])('updateTeam NON lo toglie (%s): cambiare si, lasciarlo vuoto no', async (sourcing) => {
    await expect(updateTeam('t1', { sourcing })).rejects.toThrow(/internal or external/)
    expect(runQueryOne).not.toHaveBeenCalled()
  })

  it('updateTeam senza sourcing non lo tocca: dare un tipo non chiede di ridire la provenienza', async () => {
    await updateTeam('t1', { type: 'owner' })
    expect(String(runQueryOne.mock.calls[0]?.[1])).not.toContain('t.sourcing')
  })

  it('sourcing e fra i campi filtrabili', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../team.ts', import.meta.url), 'utf8'))
    expect(/TEAM_ALLOWED_FIELDS = new Set\(\[([^\]]*)\]\)/.exec(src)?.[1] ?? '').toContain("'sourcing'")
  })
})
