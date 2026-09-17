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

vi.mock('@opengraphity/neo4j', () => ({
  runQuery: vi.fn(async () => candidati),
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

const { changesStuckWithOpenPath, MAX_CHANGE_DA_VALUTARE } = await import('../changesStuck.js')

const session = {} as never

const candidato = (code: string, condition: string | null) => ({
  code, changeId: `id-${code}`, instanceId: `wi-${code}`,
  fromStep: 'assessment', toStep: 'approval', condition, props: { id: `id-${code}`, code },
})

beforeEach(() => {
  valutate.length = 0
  candidati = []
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
})
