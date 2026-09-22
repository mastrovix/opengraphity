/**
 * LE PROPOSTE DI MIGLIORAMENTO — i resolver (22 set 2026).
 *
 * ## Perché non c'erano
 * `resolvers/proposals.ts` stava al 2,4%: tre istruzioni su centoventicinque.
 * Le sue tre regole — l'attore è chi accetta, le prove si filtrano per
 * permesso di TIPO, un'esecuzione fallita non lascia la proposta «accettata» e
 * basta — sono scritte in testa al file e non erano verificate da niente.
 *
 * ## Quello che si verifica
 * Le tre regole, i permessi di ogni mutation, e i rifiuti che nascono da una
 * decisione di prodotto: la nota di rifiuto deve avere una lunghezza minima
 * («è quello che ha il prossimo lettore»), il rinvio deve puntare al futuro,
 * «preso atto» non si usa su una proposta che porta un'azione.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'

// ── le librerie che parlano col grafo ────────────────────────────────────────
const proposta = vi.fn()
const elencaProposte = vi.fn()
const conteggiProposte = vi.fn()
const segnaDecisa = vi.fn()
const scriviLapide = vi.fn().mockResolvedValue(undefined)
vi.mock('../../../lib/proposals.js', () => ({
  proposta: (...a: unknown[]) => proposta(...a),
  elencaProposte: (...a: unknown[]) => elencaProposte(...a),
  conteggiProposte: (...a: unknown[]) => conteggiProposte(...a),
  segnaDecisa: (...a: unknown[]) => segnaDecisa(...a),
  scriviLapide: (...a: unknown[]) => scriviLapide(...a),
}))

const eseguiAzione = vi.fn()
const disfaAzione = vi.fn().mockResolvedValue(undefined)
vi.mock('../../../lib/proposalActions.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  eseguiAzione: (...a: unknown[]) => eseguiAzione(...a),
  disfaAzione: (...a: unknown[]) => disfaAzione(...a),
}))

const audit = vi.fn().mockResolvedValue(undefined)
vi.mock('../../../lib/audit.js', () => ({ audit: (...a: unknown[]) => audit(...a) }))

const createProblem = vi.fn()
vi.mock('../../../services/problemService.js', () => ({ createProblem: (...a: unknown[]) => createProblem(...a) }))

const legaAllaProposta = vi.fn().mockResolvedValue(undefined)
const fascicoloDelProblem = vi.fn()
vi.mock('../../../lib/problemDossier.js', () => ({
  legaAllaProposta: (...a: unknown[]) => legaAllaProposta(...a),
  fascicoloDelProblem: (...a: unknown[]) => fascicoloDelProblem(...a),
}))

const avviaIndagine = vi.fn().mockResolvedValue({ fatto: true, passo: 'under_investigation', percorsi: ['new', 'under_investigation'], motivo: 'fatto' })
vi.mock('../../../lib/indagineAutomatica.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  avviaIndagine: (...a: unknown[]) => avviaIndagine(...a),
}))

const enqueuePortaIlFascicolo = vi.fn().mockResolvedValue(undefined)
vi.mock('../../../jobs/autoanalisiWorker.js', () => ({
  enqueuePortaIlFascicolo: (...a: unknown[]) => enqueuePortaIlFascicolo(...a),
}))

const analizzaCliente = vi.fn()
const conIlLucchetto = vi.fn()
vi.mock('../../../jobs/proposalScanner.js', () => ({
  analizzaCliente: (...a: unknown[]) => analizzaCliente(...a),
  conIlLucchetto: (...a: unknown[]) => conIlLucchetto(...a),
}))

const runQueryOne = vi.fn()
vi.mock('../ci-utils.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runQueryOne: (...a: unknown[]) => runQueryOne(...a),
}))
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({ close: vi.fn().mockResolvedValue(undefined) })),
  runQuery: vi.fn(async () => []),
  runQueryOne: vi.fn(async () => null),
  toNumber: (v: unknown) => (v == null ? 0 : Number(v)),
}))

/**
 * `config` si finge PER INTERO e non con `importOriginal`: leggerlo davvero
 * pretende le variabili d'ambiente del prodotto (Keycloak, i segreti), e un
 * test non deve averne bisogno per sapere se c'è una chiave Anthropic.
 */
const chiaveAI = vi.fn(() => 'sk-finta')
vi.mock('../../../lib/config.js', () => ({
  config: { get anthropicApiKey() { return chiaveAI() } },
}))
// Il logger nasce da `config.logLevel`: con la configurazione finta va finto anche lui.
vi.mock('../../../lib/logger.js', () => {
  const noop = vi.fn()
  const l = { info: noop, warn: noop, error: noop, debug: noop, child: () => l }
  return { logger: l }
})

const { proposalResolvers } = await import('../proposals.js')

// ── aiuti ─────────────────────────────────────────────────────────────────────
const TUTTO = ['proposal.read', 'proposal.accept', 'proposal.run', 'problem.write', 'incident.read', 'problem.read']
const ctx = (...permessi: string[]) => ({
  tenantId: 't1', userId: 'u1', userEmail: 'u@x', role: 'admin',
  permissions: new Set(permessi.length ? permessi : TUTTO),
}) as never

const riga = (over: Record<string, unknown> = {}) => ({
  id: 'p1', area: 'configuration', kind: 'sla_missing', params: { team: 'Rete' },
  fingerprint: 'fp1', evidence: { n: 3, windowDays: 30, refs: [], extra: {} },
  occurrences: 3, windowDays: 30, action: { type: 'create_sla_policy' },
  rationale: 'perché', rationaleLanguage: 'it', status: 'open',
  createdAt: 'ieri', decidedAt: null, decidedBy: null, rejectedKind: null, rejectedNote: null,
  notNowUntil: null, auditEntryId: null, executionError: null, undone: false, undoState: null,
  openedProblem: null, ...over,
})

async function esito(fn: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await fn(); return { code: 'NESSUN RIFIUTO', message: '' } } catch (e) {
    const g = e as GraphQLError
    return { code: String(g.extensions?.['code'] ?? 'THROWN'), message: g.message }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  chiaveAI.mockReturnValue('sk-finta')
  proposta.mockResolvedValue(riga())
  segnaDecisa.mockImplementation(async (_t: string, _id: string, patch: Record<string, unknown>) => riga(patch))
  elencaProposte.mockResolvedValue({ items: [], total: 0 })
  conteggiProposte.mockResolvedValue({ open: 1, accepted: 2, rejected: 3, not_now: 4, expired: 5, superseded: 6 })
  runQueryOne.mockResolvedValue(null)
  eseguiAzione.mockResolvedValue({ undoState: { prima: 1 }, details: { creati: 2 } })
  avviaIndagine.mockResolvedValue({ fatto: true, passo: 'under_investigation', percorsi: ['new', 'under_investigation'], motivo: 'fatto' })
  enqueuePortaIlFascicolo.mockResolvedValue(undefined)
  scriviLapide.mockResolvedValue(undefined)
})

// ══════════════════════════════════════════════════════════════════════════════
describe('i permessi: ogni porta ha il suo', () => {
  const M = proposalResolvers.Mutation as Record<string, (a: unknown, b: never, c: never) => Promise<unknown>>
  const Q = proposalResolvers.Query as Record<string, (a: unknown, b: never, c: never) => Promise<unknown>>

  it('leggere chiede `proposal.read`', async () => {
    expect((await esito(() => Q['proposals']!(null, {} as never, ctx('nessuno')))).code).toBe('FORBIDDEN')
    expect((await esito(() => Q['proposal']!(null, { id: 'p1' } as never, ctx('nessuno')))).code).toBe('FORBIDDEN')
  })

  it('decidere chiede `proposal.accept`: leggere non basta', async () => {
    for (const nome of ['acceptProposal', 'rejectProposal', 'postponeProposal', 'undoProposal', 'acknowledgeProposal']) {
      expect((await esito(() => M[nome]!(null, { id: 'p1', kind: 'wrong', note: 'x', until: 'x' } as never, ctx('proposal.read')))).code)
        .toBe('FORBIDDEN')
    }
  })

  it('aprire un Problem chiede ANCHE `problem.write`: decidere non basta', async () => {
    expect((await esito(() => M['openProblemFromProposal']!(
      null, { id: 'p1', impact: 'high', urgency: 'high' } as never, ctx('proposal.accept')))).code).toBe('FORBIDDEN')
  })

  it('lanciare l\'analisi chiede `proposal.run`', async () => {
    expect((await esito(() => M['runProposalAnalysis']!(null, null as never, ctx('proposal.accept')))).code).toBe('FORBIDDEN')
  })
})

describe('le prove si filtrano per permesso di TIPO', () => {
  it('quello che non si può mostrare si CONTA, non si tace', async () => {
    proposta.mockResolvedValue(riga({ evidence: { n: 3, windowDays: 30, extra: {}, refs: [
      { entityType: 'incident', id: 'i1', label: 'INC1' },
      { entityType: 'problem',  id: 'pr1', label: 'PRB1' },
      { entityType: 'team',     id: 't1', label: 'Rete' },
    ] } }))
    // Legge gli incident, non i problem. Una squadra non è un ticket: si mostra.
    const out = await proposalResolvers.Query.proposal!(null, { id: 'p1' } as never, ctx('proposal.read', 'incident.read')) as Record<string, unknown>
    const ev = out['evidence'] as { refs: Array<Record<string, unknown>>; hiddenRefs: number }
    expect(ev.hiddenRefs).toBe(1)
    expect(ev.refs.map((r) => [r['entityType'], r['visible'], r['id']])).toEqual([
      ['incident', true, 'i1'],
      ['problem', false, ''],
      ['team', true, 't1'],
    ])
    // Di quello nascosto non esce nemmeno l'etichetta.
    expect(ev.refs[1]!['label']).toBeNull()
  })
})

describe('acceptProposal', () => {
  it('una proposta già decisa non si accetta, e il messaggio dice in che stato è', async () => {
    proposta.mockResolvedValue(riga({ status: 'rejected' }))
    const r = await esito(() => proposalResolvers.Mutation.acceptProposal!(null, { id: 'p1' } as never, ctx()))
    expect(r.message).toContain('"rejected"')
    expect(eseguiAzione).not.toHaveBeenCalled()
  })

  it('una proposta che non porta un\'azione non si «esegue»', async () => {
    proposta.mockResolvedValue(riga({ action: null }))
    expect((await esito(() => proposalResolvers.Mutation.acceptProposal!(null, { id: 'p1' } as never, ctx()))).message)
      .toContain('nothing to execute')
  })

  it('eseguita: l\'audit viene PRIMA di segnare la proposta, e l\'attore è chi accetta', async () => {
    await proposalResolvers.Mutation.acceptProposal!(null, { id: 'p1' } as never, ctx())
    expect(audit).toHaveBeenCalledBefore(segnaDecisa as never)
    const [contesto, azione, , , dettagli] = audit.mock.calls[0] as [Record<string, unknown>, string, string, string, Record<string, unknown>]
    expect(azione).toBe('proposal.accepted')
    expect(contesto['userId']).toBe('u1')
    expect(dettagli).toMatchObject({ creati: 2 })
    expect(segnaDecisa.mock.calls[0]![2]).toMatchObject({ status: 'accepted', decidedBy: 'u1', undone: false })
  })

  it('se l\'azione FALLISCE la proposta resta aperta con l\'errore scritto, e il fallimento è nel registro', async () => {
    eseguiAzione.mockRejectedValue(new Error('la policy esiste già'))
    const r = await esito(() => proposalResolvers.Mutation.acceptProposal!(null, { id: 'p1' } as never, ctx()))
    expect(r.message).toBe('la policy esiste già')
    expect(audit.mock.calls.map((c) => c[1])).toContain('proposal.execution_failed')
    expect(segnaDecisa.mock.calls[0]![2]).toMatchObject({ status: 'open', executionError: 'la policy esiste già' })
  })
})

describe('rejectProposal', () => {
  const rifiuta = (over: Record<string, unknown>) =>
    proposalResolvers.Mutation.rejectProposal!(null, { id: 'p1', kind: 'valid_but_declined', note: 'una nota lunga abbastanza', ...over } as never, ctx())

  it('il tipo di rifiuto dev\'essere uno dei tipi', async () => {
    expect((await esito(() => rifiuta({ kind: 'perche-no' }))).message).toContain('is not a rejection kind')
  })

  it('la nota ha una lunghezza minima: è quello che ha il prossimo lettore', async () => {
    expect((await esito(() => rifiuta({ note: 'no' }))).message).toContain('at least')
    expect((await esito(() => rifiuta({ note: 'x'.repeat(5000) }))).message).toContain('longer than')
  })

  it('rifiutata: si pianta la LAPIDE, che è ciò che impedisce di riproporre', async () => {
    await rifiuta({})
    expect(scriviLapide).toHaveBeenCalledWith('t1', 'fp1', expect.objectContaining({ kind: 'valid_but_declined' }))
    expect(segnaDecisa.mock.calls[0]![2]).toMatchObject({ status: 'rejected', rejectedKind: 'valid_but_declined' })
  })

  it('la nota si salva ripulita degli spazi', async () => {
    await rifiuta({ note: '   una nota con spazi intorno   ' })
    expect(segnaDecisa.mock.calls[0]![2]).toMatchObject({ rejectedNote: 'una nota con spazi intorno' })
  })
})

describe('postponeProposal', () => {
  it('una data che non è una data, e una nel passato, si rifiutano', async () => {
    expect((await esito(() => proposalResolvers.Mutation.postponeProposal!(
      null, { id: 'p1', until: 'domani forse' } as never, ctx()))).message).toContain('is not a date')
    expect((await esito(() => proposalResolvers.Mutation.postponeProposal!(
      null, { id: 'p1', until: '2020-01-01T00:00:00Z' } as never, ctx()))).message).toContain('must be in the future')
  })

  it('rinviata: lo stato diventa «non ora» con la sveglia in ISO', async () => {
    const quando = new Date(Date.now() + 86_400_000).toISOString()
    await proposalResolvers.Mutation.postponeProposal!(null, { id: 'p1', until: quando } as never, ctx())
    expect(segnaDecisa.mock.calls[0]![2]).toMatchObject({ status: 'not_now', notNowUntil: quando })
  })

  it('si rinvia solo una proposta APERTA: una già rinviata no', async () => {
    proposta.mockResolvedValue(riga({ status: 'not_now' }))
    const quando = new Date(Date.now() + 86_400_000).toISOString()
    expect((await esito(() => proposalResolvers.Mutation.postponeProposal!(
      null, { id: 'p1', until: quando } as never, ctx()))).message).toContain('only open can be decided')
  })
})

describe('undoProposal', () => {
  it('non si disfa quello che non è stato fatto', async () => {
    for (const over of [{ status: 'open' }, { status: 'accepted', undone: true, undoState: { x: 1 } }, { status: 'accepted', undoState: null }]) {
      proposta.mockResolvedValue(riga(over))
      expect((await esito(() => proposalResolvers.Mutation.undoProposal!(null, { id: 'p1' } as never, ctx()))).message)
        .toContain('nothing to undo')
    }
    expect(disfaAzione).not.toHaveBeenCalled()
  })

  it('disfatta: resta «accettata» ma segnata come disfatta, e chi aveva deciso non cambia', async () => {
    proposta.mockResolvedValue(riga({ status: 'accepted', undoState: { prima: 1 }, decidedBy: 'u9' }))
    await proposalResolvers.Mutation.undoProposal!(null, { id: 'p1' } as never, ctx())
    expect(disfaAzione).toHaveBeenCalledWith('t1', 'create_sla_policy', { prima: 1 })
    expect(segnaDecisa.mock.calls[0]![2]).toMatchObject({ status: 'accepted', undone: true, decidedBy: 'u9' })
  })
})

describe('acknowledgeProposal — «preso atto»', () => {
  it('non si usa su una proposta che porta un\'azione: quella si accetta eseguendola', async () => {
    expect((await esito(() => proposalResolvers.Mutation.acknowledgeProposal!(null, { id: 'p1' } as never, ctx()))).message)
      .toContain('carries an action')
  })

  it('su una che non porta niente: diventa accettata, e non esegue nulla', async () => {
    proposta.mockResolvedValue(riga({ action: null }))
    await proposalResolvers.Mutation.acknowledgeProposal!(null, { id: 'p1' } as never, ctx())
    expect(eseguiAzione).not.toHaveBeenCalled()
    expect(segnaDecisa.mock.calls[0]![2]).toMatchObject({ status: 'accepted', decidedBy: 'u1' })
    expect(audit.mock.calls[0]![1]).toBe('proposal.acknowledged')
  })
})

describe('openProblemFromProposal', () => {
  beforeEach(() => {
    // Solo alcuni GENERI diventano un Problem: quelli che raccontano un guasto
    // della piattaforma. `sla_missing` no — e il test qui sotto lo verifica.
    proposta.mockResolvedValue(riga({ action: null, occurrences: 9, kind: 'proposal.platformRecurringError' }))
    createProblem.mockResolvedValue({ id: 'prb1', number: 'PRB00000001' })
  })

  it('impatto e urgenza vengono da chi apre: il prodotto non ne inventa', async () => {
    await proposalResolvers.Mutation.openProblemFromProposal!(
      null, { id: 'p1', impact: 'high', urgency: 'low' } as never, ctx())
    expect(createProblem.mock.calls[0]![0]).toMatchObject({ impact: 'high', urgency: 'low' })
    expect(createProblem.mock.calls[0]![1]).toMatchObject({ tenantId: 't1', userId: 'u1' })
  })

  it('il legame si scrive SUL PROBLEM, e l\'indagine parte da sola', async () => {
    await proposalResolvers.Mutation.openProblemFromProposal!(
      null, { id: 'p1', impact: 'high', urgency: 'low' } as never, ctx())
    expect(legaAllaProposta).toHaveBeenCalledWith('t1', 'prb1', 'p1')
    expect(avviaIndagine).toHaveBeenCalledWith('t1', 'prb1', 'PRB00000001', 'u1')
  })

  it('da una proposta che non racconta un guasto non nasce un Problem', async () => {
    proposta.mockResolvedValue(riga({ action: null, kind: 'sla_missing' }))
    expect((await esito(() => proposalResolvers.Mutation.openProblemFromProposal!(
      null, { id: 'p1', impact: 'high', urgency: 'low' } as never, ctx()))).message)
      .toContain('cannot be opened from this proposal')
    expect(createProblem).not.toHaveBeenCalled()
  })

  it('il fascicolo va in coda; se la coda è giù il Problem resta valido lo stesso', async () => {
    enqueuePortaIlFascicolo.mockRejectedValueOnce(new Error('redis giù'))
    const r = await esito(() => proposalResolvers.Mutation.openProblemFromProposal!(
      null, { id: 'p1', impact: 'high', urgency: 'low' } as never, ctx()))
    expect(r.code).toBe('NESSUN RIFIUTO')
  })
})

describe('proposals — la lista', () => {
  it('stati e aree che non esistono si buttano via invece di finire in query', async () => {
    await proposalResolvers.Query.proposals!(null, { status: ['open', 'inventato'], area: ['configuration', 'x'] } as never, ctx())
    expect(elencaProposte.mock.calls[0]![1]).toMatchObject({ status: ['open'], area: ['configuration'] })
  })

  it('il tetto della pagina lo decide il server', async () => {
    for (const [chiesto, atteso] of [[1000, 100], [0, 1], [undefined, 25]] as const) {
      elencaProposte.mockClear()
      await proposalResolvers.Query.proposals!(null, (chiesto === undefined ? {} : { limit: chiesto }) as never, ctx())
      expect(elencaProposte.mock.calls[0]![1]).toMatchObject({ limit: atteso })
    }
  })

  it('senza chiave Anthropic la pagina lo DICE, invece di far credere che non ci sia niente da proporre', async () => {
    chiaveAI.mockReturnValue('')
    const out = await proposalResolvers.Query.proposals!(null, {} as never, ctx()) as Record<string, unknown>
    expect(out['aiAvailable']).toBe(false)
    chiaveAI.mockReturnValue('sk-finta')
    expect(((await proposalResolvers.Query.proposals!(null, {} as never, ctx())) as Record<string, unknown>)['aiAvailable']).toBe(true)
  })

  it('«mai girata» e «girata il …» sono due casi distinti', async () => {
    expect(((await proposalResolvers.Query.proposals!(null, {} as never, ctx())) as Record<string, unknown>)['lastRunAt']).toBeNull()
    runQueryOne.mockResolvedValue({ at: '2026-09-21T03:00:00Z' })
    expect(((await proposalResolvers.Query.proposals!(null, {} as never, ctx())) as Record<string, unknown>)['lastRunAt'])
      .toBe('2026-09-21T03:00:00Z')
  })

  it('i conteggi escono coi nomi dello schema', async () => {
    const out = await proposalResolvers.Query.proposals!(null, {} as never, ctx()) as Record<string, unknown>
    expect(out['counts']).toEqual({ open: 1, accepted: 2, rejected: 3, notNow: 4, expired: 5, superseded: 6 })
  })
})

describe('runProposalAnalysis', () => {
  it('un\'analisi già in corso si dice, non si duplica', async () => {
    conIlLucchetto.mockResolvedValue(null)
    expect((await esito(() => proposalResolvers.Mutation.runProposalAnalysis!(null, null as never, ctx()))).message)
      .toContain('already running')
    expect(audit).not.toHaveBeenCalled()
  })

  it('girata: torna quante ne ha create e quante ne ha saltate, e lo scrive nel registro', async () => {
    conIlLucchetto.mockImplementation(async (_t: string, fn: () => Promise<unknown>) => fn())
    analizzaCliente.mockResolvedValue({ create: 2, saltate: { tetto_raggiunto: 3 } })
    const out = await proposalResolvers.Mutation.runProposalAnalysis!(null, null as never, ctx()) as Record<string, unknown>
    expect(out['created']).toBe(2)
    expect(out['skipped']).toEqual([{ name: 'tetto_raggiunto', value: '3' }])
    expect(audit.mock.calls[0]![1]).toBe('proposal.analysis_run')
    expect((audit.mock.calls[0]![4] as Record<string, unknown>)['source']).toBe('manual')
  })
})

describe('problemDossier', () => {
  it('quasi tutti i problem non ne hanno uno: `null` è la risposta normale', async () => {
    fascicoloDelProblem.mockResolvedValue(null)
    expect(await proposalResolvers.Query.problemDossier!(null, { problemId: 'prb1' } as never, ctx())).toBeNull()
  })
})
