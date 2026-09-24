/**
 * I COMPITI DI UN TICKET — i resolver (22 set 2026).
 *
 * ## Perché questo file è quello che mancava di più
 * `resolvers/ticketTasks.ts` stava al 2,6%: due istruzioni su settantaquattro.
 * È il file che decide CHI può leggere e chiudere i compiti di un ticket, e la
 * sua intestazione spiega perché la regola è delicata:
 *
 *   «Un compito non ha un permesso suo: chi può leggere un incident può
 *    leggere i suoi compiti. Dichiararne uno nuovo vorrebbe dire che un giorno
 *    qualcuno lo darebbe a chi non può aprire il ticket, e leggerebbe dai
 *    titoli dei compiti quello che il ticket non gli mostra.»
 *
 * Quella frase era prosa. Qui diventa una prova: il permesso si prende dal
 * TIPO del ticket a cui il compito è appeso, un tipo non dichiarato si RIFIUTA
 * invece di passare, e una lista vuota non dice niente su un ticket che chi
 * chiede non potrebbe vedere.
 *
 * ## E le conseguenze dall'altro lato
 * Chiudere un compito apre chi aspettava — e ANCHE annullarlo, che è la metà
 * che si dimentica. Le due mutation richiamano il camminatore delle
 * transizioni automatiche, ma solo per le change, perché per gli altri ticket
 * non esiste.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'

const runQuery = vi.fn()
const runQueryOne = vi.fn()
const txRun = vi.fn()
const close = vi.fn().mockResolvedValue(undefined)
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({
    executeWrite: (fn: (tx: unknown) => unknown) => fn({ run: txRun }),
    close,
  })),
}))
vi.mock('../ci-utils.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runQuery: (...a: unknown[]) => runQuery(...a),
  runQueryOne: (...a: unknown[]) => runQueryOne(...a),
}))

const compitiDelTicket = vi.fn()
const compito = vi.fn()
const apriDipendenti = vi.fn().mockResolvedValue(undefined)
vi.mock('../../../lib/ticketTasks.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/ticketTasks.js')>()),
  compitiDelTicket: (...a: unknown[]) => compitiDelTicket(...a),
  compito: (...a: unknown[]) => compito(...a),
  apriDipendenti: (...a: unknown[]) => apriDipendenti(...a),
}))

const audit = vi.fn().mockResolvedValue(undefined)
vi.mock('../../../lib/audit.js', () => ({ audit: (...a: unknown[]) => audit(...a) }))

const evaluateAutoTransitions = vi.fn().mockResolvedValue(undefined)
vi.mock('../../../services/change/autoTransitions.js', () => ({
  evaluateAutoTransitions: (...a: unknown[]) => evaluateAutoTransitions(...a),
}))

const {
  ticketTasks, claimTicketTask, completeTicketTask, cancelTicketTask,
  formReferenceFields, PERMESSO_LETTURA,
} = await import('../ticketTasks.js')

const { TASK_STATE } = await import('../../../lib/ticketTasks.js')

// ── aiuti ─────────────────────────────────────────────────────────────────────
const ctx = (...permessi: string[]) => ({
  tenantId: 't1', userId: 'u1', userEmail: 'u@x', role: 'x', permissions: new Set(permessi),
}) as never

const task = (over: Record<string, unknown> = {}) => ({
  id: 'k1', code: 'TSK1', title: 'Firma il modulo', state: TASK_STATE.OPEN,
  entityType: 'incident', entityId: 'i1', ...over,
})

async function esito(fn: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await fn(); return { code: 'NESSUN RIFIUTO', message: '' } } catch (e) {
    const g = e as GraphQLError
    return { code: String(g.extensions?.['code'] ?? 'THROWN'), message: g.message }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  close.mockResolvedValue(undefined)
  txRun.mockResolvedValue({ records: [] })
  apriDipendenti.mockResolvedValue(undefined)
  compitiDelTicket.mockResolvedValue([task()])
  compito.mockResolvedValue(task())
  runQueryOne.mockResolvedValue({ entityType: 'incident' })
  runQuery.mockResolvedValue([])
})

// ══════════════════════════════════════════════════════════════════════════════
describe('ticketTasks — il permesso segue il TICKET, non il compito', () => {
  it('per leggere i compiti di un incident serve `incident.read`', async () => {
    expect((await esito(() => ticketTasks(null, { entityId: 'i1' }, ctx('problem.read')))).code).toBe('FORBIDDEN')
    expect(await ticketTasks(null, { entityId: 'i1' }, ctx('incident.read'))).toHaveLength(1)
  })

  it('il tipo si legge DAL COMPITO, non si crede a quello che dice il client', async () => {
    runQueryOne.mockResolvedValue({ entityType: 'kb_article' })
    // Chi legge gli incident ma non la base di conoscenza non passa, anche se
    // l'id che ha in mano sembra quello di un incident.
    expect((await esito(() => ticketTasks(null, { entityId: 'i1' }, ctx('incident.read')))).code).toBe('FORBIDDEN')
    expect(await ticketTasks(null, { entityId: 'i1' }, ctx('kb.read'))).toHaveLength(1)
  })

  it('senza compiti la lista è vuota SENZA controllare il permesso: non dice niente sul ticket', async () => {
    runQueryOne.mockResolvedValue({ entityType: null })
    expect(await ticketTasks(null, { entityId: 'i1' }, ctx())).toEqual([])
    expect(compitiDelTicket).not.toHaveBeenCalled()
  })

  it('un tipo di ticket non dichiarato si RIFIUTA, non si lascia passare', async () => {
    runQueryOne.mockResolvedValue({ entityType: 'qualcosa_di_nuovo' })
    const r = await esito(() => ticketTasks(null, { entityId: 'x1' }, ctx('incident.read', 'kb.read', 'change.read')))
    expect(r.message).toContain('no read permission is declared for entity type "qualcosa_di_nuovo"')
  })

  it('la tabella dei permessi copre i cinque tipi di ticket del prodotto', () => {
    expect(Object.keys(PERMESSO_LETTURA).sort())
      .toEqual(['change', 'incident', 'kb_article', 'problem', 'service_request'])
  })
})

describe('le mutation: per toccarli serve poter SCRIVERE il ticket', () => {
  const mutazioni = [
    ['claimTicketTask', () => claimTicketTask(null, { taskId: 'k1' }, ctx('incident.read'))],
    ['completeTicketTask', () => completeTicketTask(null, { taskId: 'k1' }, ctx('incident.read'))],
    ['cancelTicketTask', () => cancelTicketTask(null, { taskId: 'k1', reason: 'non serve' }, ctx('incident.read'))],
  ] as const

  it.each(mutazioni)('%s: leggere non basta', async (_nome, chiama) => {
    expect((await esito(chiama)).code).toBe('FORBIDDEN')
    expect(txRun).not.toHaveBeenCalled()
  })

  it('un compito che non esiste è NOT_FOUND', async () => {
    compito.mockResolvedValue(null)
    expect((await esito(() => claimTicketTask(null, { taskId: 'k9' }, ctx('incident.write')))).code).toBe('NOT_FOUND')
  })
})

describe('claimTicketTask — «lo prendo io»', () => {
  it('non serve essere della squadra, serve che il compito sia APERTO', async () => {
    compito.mockResolvedValue(task({ state: TASK_STATE.WAITING }))
    const r = await esito(() => claimTicketTask(null, { taskId: 'k1' }, ctx('incident.write')))
    expect(r.message).toContain('is not open any more (waiting)')
    expect(txRun).not.toHaveBeenCalled()
  })

  it('preso: il nome vecchio si toglie prima di mettere il nuovo', async () => {
    await claimTicketTask(null, { taskId: 'k1' }, ctx('incident.write'))
    const cypher = String(txRun.mock.calls[0]![0])
    expect(cypher).toContain('DELETE vecchio')
    expect(cypher).toContain('MERGE (k)-[:ASSIGNED_TO]->(u)')
    expect(audit.mock.calls[0]![1]).toBe('task.claimed')
  })
})

describe('completeTicketTask — chiudere apre chi aspettava', () => {
  it('un compito IN ATTESA non si chiude: il suo turno non è arrivato', async () => {
    compito.mockResolvedValue(task({ state: TASK_STATE.WAITING }))
    expect((await esito(() => completeTicketTask(null, { taskId: 'k1' }, ctx('incident.write')))).message)
      .toContain('is not open any more')
  })

  it('chiuso: si segna chi e quando, e si aprono i dipendenti', async () => {
    await completeTicketTask(null, { taskId: 'k1', note: '  fatto  ' }, ctx('incident.write'))
    const p = txRun.mock.calls[0]![1] as Record<string, unknown>
    expect(p).toMatchObject({ completed: TASK_STATE.COMPLETED, userId: 'u1', note: 'fatto' })
    expect(apriDipendenti).toHaveBeenCalledTimes(1)
    expect(audit.mock.calls[0]![1]).toBe('task.completed')
  })

  it('una nota di soli spazi diventa null, non una stringa vuota', async () => {
    await completeTicketTask(null, { taskId: 'k1', note: '   ' }, ctx('incident.write'))
    expect((txRun.mock.calls[0]![1] as Record<string, unknown>)['note']).toBeNull()
  })

  it('SOLO per le change si riprova la transizione automatica', async () => {
    await completeTicketTask(null, { taskId: 'k1' }, ctx('incident.write'))
    expect(evaluateAutoTransitions).not.toHaveBeenCalled()

    compito.mockResolvedValue(task({ entityType: 'change', entityId: 'c1' }))
    await completeTicketTask(null, { taskId: 'k1' }, ctx('change.write'))
    expect(evaluateAutoTransitions).toHaveBeenCalledTimes(1)
  })

  it('se il camminatore fallisce, la chiusura resta: è già scritta ed è giusta', async () => {
    compito.mockResolvedValue(task({ entityType: 'change', entityId: 'c1' }))
    evaluateAutoTransitions.mockRejectedValueOnce(new Error('workflow rotto'))
    expect((await esito(() => completeTicketTask(null, { taskId: 'k1' }, ctx('change.write')))).code)
      .toBe('NESSUN RIFIUTO')
    expect(audit.mock.calls[0]![1]).toBe('task.completed')
  })
})

describe('cancelTicketTask — anche annullare apre chi aspettava', () => {
  it('il motivo è obbligatorio: chi aspettava deve sapere perché il compito è sparito', async () => {
    const r = await esito(() => cancelTicketTask(null, { taskId: 'k1', reason: '   ' }, ctx('incident.write')))
    expect(r.message).toContain('needs a reason')
    expect(txRun).not.toHaveBeenCalled()
  })

  it('si annulla ANCHE un compito in attesa: «non serve più» si sa spesso prima', async () => {
    compito.mockResolvedValue(task({ state: TASK_STATE.WAITING }))
    expect((await esito(() => cancelTicketTask(null, { taskId: 'k1', reason: 'non serve' }, ctx('incident.write')))).code)
      .toBe('NESSUN RIFIUTO')
  })

  it('uno già chiuso no: si sta guardando una pagina vecchia', async () => {
    compito.mockResolvedValue(task({ state: TASK_STATE.COMPLETED }))
    expect((await esito(() => cancelTicketTask(null, { taskId: 'k1', reason: 'x' }, ctx('incident.write')))).message)
      .toContain('is not open any more (completed)')
  })

  it('annullato: i dipendenti si aprono lo stesso, e il motivo si scrive', async () => {
    await cancelTicketTask(null, { taskId: 'k1', reason: '  il cliente ha disdetto  ' }, ctx('incident.write'))
    expect((txRun.mock.calls[0]![1] as Record<string, unknown>)).toMatchObject({
      cancelled: TASK_STATE.CANCELLED, reason: 'il cliente ha disdetto',
    })
    expect(apriDipendenti).toHaveBeenCalledTimes(1)
    expect((audit.mock.calls[0]![4] as Record<string, unknown>)['reason']).toBe('il cliente ha disdetto')
  })

  it('e anche annullando si riprova la transizione: può essere lui l\'ultimo che teneva fermo il passo', async () => {
    compito.mockResolvedValue(task({ entityType: 'change', entityId: 'c1' }))
    await cancelTicketTask(null, { taskId: 'k1', reason: 'non serve' }, ctx('change.write'))
    expect(evaluateAutoTransitions).toHaveBeenCalledTimes(1)
  })
})

describe('formReferenceFields — tre stringhe, non gli script del cliente', () => {
  it('serve `config.workflow`: la tendina la usa il disegnatore', async () => {
    expect((await esito(() => formReferenceFields(null, null, ctx('config.catalog')))).code).toBe('FORBIDDEN')
  })

  it('escono solo i campi riferimento, e solo nome, etichetta e tipo', async () => {
    runQuery.mockResolvedValue([
      { name: 'server', label: 'Server', fieldType: 'ref_ci' },
      { name: 'capo', label: null, fieldType: 'ref_user' },
    ])
    const out = await formReferenceFields(null, null, ctx('config.workflow'))
    // Senza etichetta si mostra il nome: meglio il nome interno che niente.
    expect(out).toEqual([
      { name: 'server', label: 'Server', fieldType: 'ref_ci' },
      { name: 'capo', label: 'capo', fieldType: 'ref_user' },
    ])
    const params = runQuery.mock.calls[0]![2] as Record<string, unknown>
    expect(params['tipi']).toEqual(['ref_ci', 'ref_user', 'ref_team'])
    // `validationScript` e `formula` — gli script del cliente — non escono.
    const cypher = String(runQuery.mock.calls[0]![1])
    expect(cypher).not.toContain('validation_script')
    expect(cypher).not.toContain('formula')
  })
})
