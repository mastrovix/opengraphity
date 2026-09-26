/**
 * LE CHANGE FERME CON LA STRADA APERTA.
 *
 * È il rilievo che chiude un silenzio: le transizioni automatiche si valutano
 * solo dentro una mutation sulla change, quindi una che si perde la sua
 * occasione resta ferma per sempre pur avendo le condizioni soddisfatte, e
 * niente lo dice. Trovato su `CHG00000003` di `c-one`, ferma dal 7 settembre
 * con i tre task completati.
 *
 * Quello che si pinna qui è il DISCRIMINE: chi finisce nel rilievo e chi no.
 * Un rilievo che nomina una change che non si muoverebbe comunque manda ad
 * aprire il ticket sbagliato, e chi lo legge impara a ignorare il banner.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

/** I candidati che la query restituisce: li decide ogni caso. */
let candidati: Array<Record<string, unknown>> = []
/** L'esito della condizione, per nome. Una condizione assente qui «non è registrata». */
let condizioni: Record<string, boolean> = {}
const valutate: string[] = []

const queries: Array<{ q: string; params: Record<string, unknown> }> = []
vi.mock('@opengraphity/neo4j', () => ({
  runQuery: vi.fn(async (_s: unknown, q: string, params: Record<string, unknown>) => { queries.push({ q, params }); return candidati }),
}))
vi.mock('@opengraphity/workflow', () => ({
  workflowEngine: {
    evaluateCondition: vi.fn(async (_s: unknown, nome: string) => {
      valutate.push(nome)
      if (!(nome in condizioni)) throw new Error(`Condizione di transizione sconosciuta: ${nome}`)
      return condizioni[nome]!
    }),
  },
}))
// Nel prodotto questo import registra le condizioni sul motore; qui il motore
// è già finto, e il modulo non deve trascinarsi dietro mezza API.
vi.mock('../../workflow/conditions.js', () => ({ registerWorkflowConditions: vi.fn() }))
/**
 * IL VARCO DELLA FINESTRA DI RILASCIO, finto: la sua decisione ha i suoi test
 * (`change/__tests__/windowGate.test.ts`). Qui conta che il rilievo la
 * RISPETTI — e prima non la chiedeva affatto.
 */
let varcoApre = true
const automaticTransitionOutcome = vi.fn(async () => (varcoApre ? { allowed: true, reason: 'open' } : { allowed: false, reason: 'needs_approvals' }))
vi.mock('../../services/change/windowGate.js', () => ({
  automaticTransitionOutcome: () => automaticTransitionOutcome(),
}))

const { changesStuckWithOpenPath, changeChePossonoMuoversi, MAX_CHANGE_DA_VALUTARE } = await import('../changesStuck.js')
const { TIMER_GRACE_MINUTES } = await import('../waitSteps.js')

const session = {} as never

const candidato = (code: string, condition: string | null) => ({
  code, changeId: `id-${code}`, instanceId: `wi-${code}`,
  fromStep: 'assessment', toStep: 'approval', condition, props: { id: `id-${code}`, code },
})

beforeEach(() => {
  queries.length = 0
  valutate.length = 0
  candidati = []
  varcoApre = true
  automaticTransitionOutcome.mockClear()
  condizioni = { all_assessments_complete: false }
})

describe('changesStuckWithOpenPath', () => {
  it('una change la cui condizione è VERA è ferma con la strada aperta', async () => {
    candidati = [candidato('CHG00000003', 'all_assessments_complete')]
    condizioni = { all_assessments_complete: true }
    expect(await changesStuckWithOpenPath(session, 't1')).toEqual(['CHG00000003'])
  })

  it('una change la cui condizione è FALSA non è ferma: sta aspettando, ed è giusto', async () => {
    candidati = [candidato('CHG00000004', 'all_assessments_complete')]
    condizioni = { all_assessments_complete: false }
    expect(await changesStuckWithOpenPath(session, 't1')).toEqual([])
  })

  it('un arco automatico SENZA condizione doveva scattare subito: se è ancora lì, è ferma', async () => {
    candidati = [candidato('CHG1', null)]
    expect(await changesStuckWithOpenPath(session, 't1')).toEqual(['CHG1'])
    // E non si chiede niente al motore: non c'è condizione da valutare.
    expect(valutate).toEqual([])
  })

  it('una condizione NON REGISTRATA non entra nel rilievo', async () => {
    // È un workflow mal configurato, e ha già il suo sintomo: il motore rifiuta
    // ogni transizione su quell'arco. Nominarla qui manderebbe ad aprire una
    // change che non si muoverà comunque.
    candidati = [candidato('CHG-ROTTA', 'all_assessment_complete')] // refuso storico, al singolare
    expect(await changesStuckWithOpenPath(session, 't1')).toEqual([])
    expect(valutate).toEqual(['all_assessment_complete'])
  })

  it('una change con DUE archi aperti è un rilievo solo, e la condizione si valuta una volta', async () => {
    candidati = [
      candidato('CHG9', 'all_assessments_complete'),
      { ...candidato('CHG9', 'all_assessments_complete'), toStep: 'scheduled' },
    ]
    condizioni = { all_assessments_complete: true }
    expect(await changesStuckWithOpenPath(session, 't1')).toEqual(['CHG9'])
    expect(valutate).toHaveLength(1)
  })

  it('niente candidati: nessuna valutazione, e il motore non si carica nemmeno', async () => {
    candidati = []
    expect(await changesStuckWithOpenPath(session, 't1')).toEqual([])
    expect(valutate).toEqual([])
  })

  it('il tetto dei candidati è dichiarato, non nascosto in una query', () => {
    // Un controllo di diagnostica non deve diventare un lavoro: il numero sta
    // in una costante esportata, così si legge e si prova.
    expect(MAX_CHANGE_DA_VALUTARE).toBeGreaterThan(0)
    expect(MAX_CHANGE_DA_VALUTARE).toBeLessThanOrEqual(1000)
  })

  it('le change ferme tornano in ordine, senza ripetizioni', async () => {
    candidati = [candidato('CHG-B', null), candidato('CHG-A', null), candidato('CHG-B', null)]
    expect(await changesStuckWithOpenPath(session, 't1')).toEqual(['CHG-B', 'CHG-A'])
  })

  /**
   * IL VARCO, e non solo la condizione (18 set 2026).
   *
   * Trovato dal vivo: `CHG00000008` era elencata fra le ferme mentre il varco
   * rifiutava entrambi i suoi archi automatici. Il rilievo consiglia «apri
   * quella change e fai avanzare il passo», che su una change trattenuta dal
   * varco non muove niente — e un rilievo che manda a premere un bottone
   * inutile insegna a ignorare il banner.
   */
  describe('quello che il varco trattiene NON è «fermo con la strada aperta»', () => {
    it('condizione soddisfatta ma varco chiuso: non si conta', async () => {
      varcoApre = false
      candidati = [candidato('CHG-1', 'all_assessments_complete')]
      condizioni = { all_assessments_complete: true }
      expect(await changesStuckWithOpenPath(session, 't1')).toEqual([])
    })

    it('vale anche per un arco SENZA condizione, che è il caso che l\'ha scoperto', async () => {
      // L'arco `assessment → scheduled` disegnato a mano, automatico e senza
      // condizione: sempre «aperto» per la condizione, sempre rifiutato dal varco.
      varcoApre = false
      candidati = [candidato('CHG-1', null)]
      expect(await changesStuckWithOpenPath(session, 't1')).toEqual([])
    })

    it('varco aperto: la change resta nel rilievo, com\'è giusto', async () => {
      candidati = [candidato('CHG-1', null)]
      expect(await changesStuckWithOpenPath(session, 't1')).toEqual(['CHG-1'])
    })

    it('il varco si chiede DOPO la condizione: su una condizione falsa non si legge niente', async () => {
      // Il varco fa due letture (scopi dei passi, approvazioni): farle per
      // ogni candidato, anche quelli già esclusi, sarebbe lavoro buttato su
      // ogni apertura di pagina.
      candidati = [candidato('CHG-1', 'all_assessments_complete')]
      condizioni = { all_assessments_complete: false }
      await changesStuckWithOpenPath(session, 't1')
      expect(automaticTransitionOutcome).not.toHaveBeenCalled()
    })
  })
})

describe('a wait is never cut short (26 Sep 2026)', () => {
  // The arcs out of a `timer_wait` step are automatic too: the resume pass moved a
  // change out of its wait within a minute. Only a LOST timer lets a pass finish it.
  const NOW = new Date('2026-09-26T08:00:00Z')
  const agoMin = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString()
  const inWait = (code: string, since: string) => ({ ...candidato(code, null), fromStep: 'cooling_off', stepType: 'timer_wait', delay: 60, since })

  it('a change in a wait still running is not stuck', async () => {
    candidati = [inWait('CHG-W', agoMin(60 + TIMER_GRACE_MINUTES - 1))]
    expect(await changeChePossonoMuoversi(session, 't1', NOW)).toEqual([])
  })

  it('a change whose wait ended long ago, the timer lost: it is, and its exit is followed', async () => {
    candidati = [inWait('CHG-L', agoMin(60 + TIMER_GRACE_MINUTES + 1))]
    expect((await changeChePossonoMuoversi(session, 't1', NOW)).map((c) => c.code)).toEqual(['CHG-L'])
  })

  it('the query reads a wait\'s exits as the timer job does, and every other step\'s automatic arcs', async () => {
    await changeChePossonoMuoversi(session, 't1', NOW)
    const { q, params } = queries[0]!
    expect(q).toContain("(coalesce(cur.type, '') <> $timerWait AND tr.trigger = 'automatic') OR (cur.type = $timerWait AND tr.trigger IN $waitExit)")
    expect(params).toMatchObject({ timerWait: 'timer_wait', waitExit: ['automatic', 'timer'] })
  })
})
