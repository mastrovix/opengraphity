/**
 * LE QUERY DELLE CHANGE (22 set 2026).
 *
 * ## Perché non c'erano
 * `change/queries.ts` stava al 5,2% di copertura: undici istruzioni su
 * duecentoundici. È lo strato dove arrivano gli argomenti del client — il
 * campo su cui ordinare, l'intervallo del calendario, la profondità
 * dell'impatto — e dove si decide chi vede quale compito. Le mutation accanto
 * (`changeMutations`, `approvalGate`, `windowGate`) hanno vent'anni di test;
 * le query nessuno.
 *
 * ## Che cosa si verifica
 * Non la forma del Cypher — quella la guardano `check-cypher` (che manda
 * EXPLAIN a Neo4j vero) e `tenantScoping`. Qui si verificano le DECISIONI: il
 * campo d'ordinamento che non è nella lista bianca viene ignorato invece di
 * finire nella query, la profondità si stringe fra 1 e 5, un intervallo a
 * rovescio si rifiuta, e un compito generico non si mostra a chi non potrebbe
 * aprire quel tipo di ticket.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { perms } from '../../../../lib/__tests__/testPermissions.js'

const runQuery = vi.fn()
const runQueryOne = vi.fn()
// The customer's fields of a change (they sort the list since 26 Sep 2026): none here.
vi.mock('../../ticketCustomFields.js', () => ({ requestCustomFieldDefs: async () => [] }))
vi.mock('../../ci-utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../ci-utils.js')>()),
  withSession: (fn: (s: unknown) => unknown) => fn({ fakeSession: true }),
  runQuery: (...a: unknown[]) => runQuery(...a),
  runQueryOne: (...a: unknown[]) => runQueryOne(...a),
  getSession: vi.fn(),
}))
vi.mock('../../../../lib/ciMetamodelForTenant.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  serviceRelPatternForTenant: vi.fn(async () => 'DEPENDS_ON|RUNS_ON'),
}))
vi.mock('../../../../lib/ciTypeFromLabels.js', () => ({
  ciTypeFromLabels: vi.fn((_t: string, labels: string[]) => `dai-label:${labels.join('+')}`),
}))
const deployConflictsForChange = vi.fn(async () => [{ changeCode: 'CHG2' }])
vi.mock('../../../../lib/changeDeployConflicts.js', () => ({
  deployConflictsForChange: (...a: unknown[]) => deployConflictsForChange(...a),
}))

const q = await import('../queries.js')

const ctx = (role = 'admin') => ({
  tenantId: 't1', userId: 'u1', userEmail: 'u@x', role, permissions: perms(role),
}) as never

/** Un contesto con ESATTAMENTE questi permessi: i ruoli di fabbrica li hanno tutti o nessuno. */
const ctxCon = (...permessi: string[]) => ({
  tenantId: 't1', userId: 'u1', userEmail: 'u@x', role: 'custom', permissions: new Set(permessi),
}) as never

/** Il Cypher e i parametri dell'ultima `runQuery`. */
const ultima = () => {
  const c = runQuery.mock.calls.at(-1) as [unknown, string, Record<string, unknown>]
  return { cypher: c[1], params: c[2] }
}

beforeEach(() => {
  vi.clearAllMocks()
  runQuery.mockResolvedValue([])
  runQueryOne.mockResolvedValue(null)
})

// ══════════════════════════════════════════════════════════════════════════════
describe('changes — la lista', () => {
  it('ordina solo sui campi della lista bianca: uno inventato è rifiutato e NON finisce nella query (A-22, 26 Sep 2026)', async () => {
    await expect(q.changes(null, { sortField: 'c.title; DROP', sortDirection: 'ASC' }, ctx())).rejects.toMatchObject({ extensions: { i18n: { key: 'errors.sort.unknownField' } } })
    expect(runQuery).not.toHaveBeenCalled()
  })

  it('un campo della lista bianca passa, con la direzione normalizzata', async () => {
    await q.changes(null, { sortField: 'aggregateRiskScore', sortDirection: 'asc' }, ctx())
    expect(runQuery.mock.calls[0]![1]).toContain('ORDER BY c.aggregate_risk_score ASC')
    // Any direction but «desc» is ascending, as in every list (lib/sortField.ts).
    await q.changes(null, { sortField: 'code', sortDirection: 'qualunque cosa' }, ctx())
    expect(runQuery.mock.calls[2]![1]).toContain('ORDER BY c.code ASC')
    // The phase and the requester sort too (26 Sep 2026).
    await q.changes(null, { sortField: 'requester', sortDirection: 'desc' }, ctx())
    expect(runQuery.mock.calls[4]![1]).toContain('ORDER BY req.name DESC')
  })

  it('le change cancellate non si contano né si mostrano', async () => {
    await q.changes(null, {}, ctx())
    for (const [, cypher] of runQuery.mock.calls as Array<[unknown, string]>) {
      expect(cypher).toContain('coalesce(c.deleted, false) = false')
    }
  })

  it('il passo corrente entra come MATCH sul workflow, non come stringa nella WHERE', async () => {
    await q.changes(null, { currentStep: 'approval' }, ctx())
    const { cypher, params } = { cypher: runQuery.mock.calls[0]![1] as string, params: runQuery.mock.calls[0]![2] as Record<string, unknown> }
    expect(cypher).toContain('current_step: $currentStep')
    expect(params['currentStep']).toBe('approval')
  })

  it('le relazioni assenti diventano null, non un oggetto vuoto', async () => {
    runQuery.mockResolvedValueOnce([{ props: { id: 'c1', code: 'CHG1' }, reqUser: { id: 'u9' }, ownerUser: null, appUser: null }])
    runQuery.mockResolvedValueOnce([{ total: 1 }])
    const out = await q.changes(null, {}, ctx()) as { items: Array<Record<string, unknown>>; total: number }
    expect(out.total).toBe(1)
    expect(out.items[0]!['changeOwner']).toBeNull()
    expect(out.items[0]!['approvalBy']).toBeNull()
    expect(out.items[0]!['requester']).not.toBeNull()
  })

  it('il tetto della pagina non lo decide il client: un limite assurdo si RIFIUTA', async () => {
    const err = await q.changes(null, { limit: 100_000 }, ctx()).catch((e: Error) => e)
    expect((err as Error).message).toContain('must be an integer between 1 and')
    // Niente query: il rifiuto arriva prima di toccare il database.
    expect(runQuery).not.toHaveBeenCalled()
  })
})

describe('change — il dettaglio', () => {
  it('una change che non c\'è (o cancellata) è null, non un oggetto a metà', async () => {
    expect(await q.change(null, { id: 'c9' }, ctx())).toBeNull()
  })

  it('trovata: le tre relazioni si risolvono nella stessa query', async () => {
    runQueryOne.mockResolvedValue({ props: { id: 'c1', code: 'CHG1' }, reqUser: { id: 'u1' }, ownerUser: { id: 'u2' }, appUser: null })
    const out = await q.change(null, { id: 'c1' }, ctx()) as Record<string, unknown>
    expect(out['approvalBy']).toBeNull()
    expect((out['changeOwner'] as Record<string, unknown>)['id']).toBe('u2')
    expect(runQueryOne).toHaveBeenCalledTimes(1)
  })
})

// ══════════════════════════════════════════════════════════════════════════════
describe('myTasks — chi vede quale compito', () => {
  /**
   * Le query dei compiti di change tornano vuote; solo quella dei compiti
   * GENERICI porta righe. Si riconosce dal nodo — `:Task` — e non dal numero
   * d'ordine: aggiungere una query alle change non deve rompere questi test.
   */
  function soloCompitiGenerici(righe: Array<Record<string, unknown>>) {
    runQuery.mockImplementation(async (_s: unknown, cypher: string) =>
      (String(cypher).includes('(k:Task') ? righe : []))
  }

  const compito = (p: Partial<Record<string, unknown>> = {}) => ({
    id: 'k1', code: 'TSK1', role: '', action: 'Firma il modulo', status: 'open',
    entityType: 'incident', entityId: 'i1', entityNumber: 'INC1',
    ciId: null, ciName: null, phase: 'triage', createdAt: '2026-09-01T00:00:00Z', miei: true, ...p,
  })

  it('un compito su un tipo di ticket che non posso leggere non compare affatto', async () => {
    soloCompitiGenerici([compito({ entityType: 'incident' }), compito({ id: 'k2', entityType: 'kb_article' })])
    // Un ruolo su misura che legge gli incident ma non la base di conoscenza:
    // i ruoli di fabbrica hanno o tutte le letture o nessuna, quindi non
    // servono a provare questo filtro.
    const out = await q.myTasks(null, null, ctxCon('incident.read')) as { assignedToMe: Array<Record<string, unknown>> }
    expect(out.assignedToMe.map((r) => r['id'])).toEqual(['k1'])
  })

  it('un tipo di entità sconosciuto non passa per difetto: si salta', async () => {
    soloCompitiGenerici([compito({ entityType: 'qualcosa_di_nuovo' })])
    const out = await q.myTasks(null, null, ctx()) as { assignedToMe: unknown[]; unassigned: unknown[] }
    expect(out.assignedToMe).toEqual([])
    expect(out.unassigned).toEqual([])
  })

  it('`miei` decide la colonna, e non esce nel risultato', async () => {
    soloCompitiGenerici([compito({ miei: true }), compito({ id: 'k2', miei: false })])
    const out = await q.myTasks(null, null, ctx()) as { assignedToMe: Array<Record<string, unknown>>; unassigned: Array<Record<string, unknown>> }
    expect(out.assignedToMe.map((r) => r['id'])).toEqual(['k1'])
    expect(out.unassigned.map((r) => r['id'])).toEqual(['k2'])
    expect(out.assignedToMe[0]).not.toHaveProperty('miei')
    expect(out.assignedToMe[0]!['kind']).toBe('task')
  })

  it('il titolo del compito È l\'azione: l\'ha scritto chi ha disegnato il passo', async () => {
    soloCompitiGenerici([compito({ action: 'Porta il badge in portineria' })])
    const out = await q.myTasks(null, null, ctx()) as { assignedToMe: Array<Record<string, unknown>> }
    expect(out.assignedToMe[0]!['action']).toBe('Porta il badge in portineria')
  })

  it('i più recenti in cima, in tutte e due le colonne', async () => {
    soloCompitiGenerici([
      compito({ id: 'vecchio', createdAt: '2026-01-01T00:00:00Z' }),
      compito({ id: 'nuovo', createdAt: '2026-09-20T00:00:00Z' }),
    ])
    const out = await q.myTasks(null, null, ctx()) as { assignedToMe: Array<Record<string, unknown>> }
    expect(out.assignedToMe.map((r) => r['id'])).toEqual(['nuovo', 'vecchio'])
  })

  it('i compiti di change portano la frase del prodotto, perché non hanno un nome proprio', async () => {
    let n = 0
    runQuery.mockImplementation(async () => (++n === 1
      ? [{ id: 'a1', code: 'ASS1', role: 'owner', status: 'pending', entityType: 'change', entityId: 'c1', entityNumber: 'CHG1', ciId: 'ci1', ciName: 'VM', phase: 'assessment', createdAt: '2026-09-02T00:00:00Z' }]
      : []))
    const out = await q.myTasks(null, null, ctx()) as { assignedToMe: Array<Record<string, unknown>> }
    expect(out.assignedToMe[0]).toMatchObject({ kind: 'assessment', action: expect.stringContaining('assessment') })
  })
})

// ══════════════════════════════════════════════════════════════════════════════
describe('changeImpactedCIs', () => {
  it('la profondità la decide il server: fra 1 e 5, qualunque cosa chieda il client', async () => {
    for (const [chiesta, attesa] of [[0, 1], [-3, 1], [3, 3], [99, 5], [undefined, 1]] as const) {
      runQuery.mockClear()
      await q.changeImpactedCIs(null, { changeId: 'c1', ...(chiesta === undefined ? {} : { depth: chiesta }) }, ctx())
      expect(ultima().cypher).toContain(`*1..${attesa}`)
    }
  })
})

describe('taskById — cinque tipi, una risposta', () => {
  it('nessuno dei cinque lo conosce: null, e si sono provati tutti', async () => {
    expect(await q.taskById(null, { id: 'x' }, ctx())).toBeNull()
    expect(runQueryOne).toHaveBeenCalledTimes(5)
  })

  it('si ferma al primo che lo conosce, e dice di che tipo è', async () => {
    runQueryOne.mockImplementation(async (_s: unknown, cypher: string) =>
      (String(cypher).includes('ValidationTest')
        ? { taskCode: 'VAL1', changeId: 'c1', changeCode: 'CHG1', changeTitle: 'T', changePhase: 'deployment', changeDesc: null, ciId: 'ci1', ciName: 'VM', ciType: null, ciLabels: ['ConfigurationItem', 'VirtualMachine'], ciEnv: 'prod' }
        : null))
    const out = await q.taskById(null, { id: 'v1' }, ctx()) as Record<string, unknown>
    expect(out['kind']).toBe('validation')
    // Provati assessment e deploy-plan prima, poi basta.
    expect(runQueryOne).toHaveBeenCalledTimes(3)
    // Senza `ci.type` il tipo si ricava dalle etichette, non da `toLower(head(labels))`.
    expect(out['ciType']).toBe('dai-label:ConfigurationItem+VirtualMachine')
  })
})

describe('questionCITypeAssignments', () => {
  it('un peso mai scritto vale 1, non zero: zero renderebbe la domanda decorativa', async () => {
    runQuery.mockResolvedValue([
      { ciTypeId: 'a', ciTypeName: 'Server', weight: null, sortOrder: null },
      { ciTypeId: 'b', ciTypeName: 'Stampante', weight: 3, sortOrder: 2 },
    ])
    const out = await q.questionCITypeAssignments(null, { questionId: 'q1' }, ctx()) as Array<Record<string, unknown>>
    expect(out[0]).toMatchObject({ weight: 1, sortOrder: 0 })
    expect(out[1]).toMatchObject({ weight: 3, sortOrder: 2 })
  })
})

// ══════════════════════════════════════════════════════════════════════════════
describe('changeCalendar — l\'intervallo', () => {
  it('un intervallo vuoto o a rovescio si rifiuta, e il messaggio nomina le due date', async () => {
    for (const [from, to] of [
      ['2026-09-20T00:00:00Z', '2026-09-10T00:00:00Z'],
      ['2026-09-20T00:00:00Z', '2026-09-20T00:00:00Z'],
    ]) {
      const err = await q.changeCalendar(null, { from: from!, to: to! }, ctx()).catch((e: Error) => e)
      expect((err as Error).message).toContain('empty or reversed')
      expect((err as Error).message).toContain(from!)
    }
  })

  it('le date arrivano in Cypher come ISO `Z`: il confronto è fra stringhe', async () => {
    runQuery.mockResolvedValue([])
    runQueryOne.mockResolvedValue({ n: 0 })
    await q.changeCalendar(null, { from: '2026-09-01T00:00:00+02:00', to: '2026-09-30T00:00:00+02:00' }, ctx())
    const p = runQuery.mock.calls[0]![2] as Record<string, string>
    expect(p['from']).toMatch(/Z$/)
    expect(p['to']).toMatch(/Z$/)
    expect(p['from']).toBe('2026-08-31T22:00:00.000Z')
  })

  it('i piani senza inviluppo si CONTANO, non si nascondono', async () => {
    runQuery.mockResolvedValue([])
    runQueryOne.mockResolvedValue({ n: 4 })
    const out = await q.changeCalendar(null, { from: '2026-09-01T00:00:00Z', to: '2026-09-30T00:00:00Z' }, ctx()) as Record<string, unknown>
    expect(out['unreadablePlans']).toBe(4)
  })
})

describe('changeDeployConflicts', () => {
  it('è un resolver di campo: lo paga chi apre il dettaglio, e delega alla libreria', async () => {
    const out = await q.changeDeployConflicts({ id: 'c1' }, null, ctx())
    expect(out).toEqual([{ changeCode: 'CHG2' }])
    expect(deployConflictsForChange).toHaveBeenCalledWith({ fakeSession: true }, 't1', 'c1')
  })
})
