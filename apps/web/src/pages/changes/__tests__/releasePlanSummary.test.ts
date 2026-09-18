/**
 * IL PIANO COMPLESSIVO DI UNA CHANGE, in ordine di data.
 *
 * Quello che si pinna qui è l'ORDINE e la CONTA, perché sono le due cose che
 * un errore rende plausibili invece che visibili: un elenco ordinato male si
 * legge come un piano diverso, e un inviluppo che somma una data illeggibile
 * dà `NaN` senza dirlo.
 */
import { describe, it, expect } from 'vitest'
import type { AffectedCI, DeployStep } from '@/types/change'
import { riepilogoRilascio, contaFinestreDistinte, asseDelPiano, barreDelPiano, taccheDelPiano, vociFiltrate, contaPerTipo } from '../releasePlanSummary'

const w = (start: string, end: string) => ({ start, end })

const passo = (title: string, val: [string, string], rel: [string, string]): DeployStep =>
  ({ title, validationWindow: w(...val), releaseWindow: w(...rel) })

/** Un CI impattato col suo piano. Gli assessment contano solo per l'avanzamento. */
const ci = (
  name: string,
  steps: DeployStep[],
  over: { taskCode?: string; pianoStato?: string; assess?: [string, string]; supportGroup?: string } = {},
): AffectedCI => {
  const [funz, tecn] = over.assess ?? ['completed', 'completed']
  return {
    ciPhase: 'assessment', riskScore: 3,
    ci: {
      id: `ci-${name}`, name, type: 'server', environment: 'production',
      ownerGroup: null,
      supportGroup: over.supportGroup ? { id: 't1', name: over.supportGroup } : null,
    },
    assessmentOwner:   { id: 'a1', code: 'TASK1', responderRole: 'owner',   status: funz, score: 3, completedBy: null, completedAt: null, assignedTeam: null, assignee: null, responses: [] },
    assessmentSupport: { id: 'a2', code: 'TASK2', responderRole: 'support', status: tecn, score: 3, completedBy: null, completedAt: null, assignedTeam: null, assignee: null, responses: [] },
    deployPlan: {
      id: `dp-${name}`, code: over.taskCode ?? `TASK-${name}`, status: over.pianoStato ?? 'completed',
      steps, completedBy: null, completedAt: null, assignedTeam: null, assignee: null,
    },
    validation: null, deployment: null, review: null,
  } as unknown as AffectedCI
}

describe('il piano complessivo è una cronologia', () => {
  it('mette in fila le finestre di TUTTI i CI, non un CI per volta', () => {
    const r = riepilogoRilascio([
      // Il secondo CI rilascia PRIMA del primo: se l'elenco seguisse l'ordine
      // dei CI invece delle date, questo test sarebbe l'unico a dirlo.
      ci('srv-app-01', [passo('Deploy 4.2', ['2026-09-22T20:00:00Z', '2026-09-22T21:00:00Z'], ['2026-09-22T22:00:00Z', '2026-09-22T23:00:00Z'])]),
      ci('db-prod-01', [passo('Backup',     ['2026-09-21T01:00:00Z', '2026-09-21T01:30:00Z'], ['2026-09-21T02:00:00Z', '2026-09-21T03:00:00Z'])]),
    ])
    expect(r.voci.map((v) => `${v.ciName}/${v.tipo}`)).toEqual([
      'db-prod-01/validation', 'db-prod-01/release',
      'srv-app-01/validation', 'srv-app-01/release',
    ])
  })

  it('ogni voce porta tipo, task e CI: è così che si reclama un piano', () => {
    const r = riepilogoRilascio([
      ci('srv-app-01', [passo('Stop servizi', ['2026-09-21T20:00:00Z', '2026-09-21T21:00:00Z'], ['2026-09-21T22:00:00Z', '2026-09-21T23:00:00Z'])], { taskCode: 'TASK00000042' }),
    ])
    expect(r.voci).toHaveLength(2)
    expect(r.voci[0]).toMatchObject({ tipo: 'validation', taskCode: 'TASK00000042', ciName: 'srv-app-01', stepTitle: 'Stop servizi' })
    expect(r.voci[1]).toMatchObject({ tipo: 'release',    taskCode: 'TASK00000042', ciName: 'srv-app-01' })
  })

  it('a pari ora la validazione viene prima del rilascio, non a caso', () => {
    const r = riepilogoRilascio([
      ci('x', [passo('P', ['2026-09-21T22:00:00Z', '2026-09-21T22:30:00Z'], ['2026-09-21T22:00:00Z', '2026-09-21T23:00:00Z'])]),
    ])
    expect(r.voci.map((v) => v.tipo)).toEqual(['validation', 'release'])
  })

  it('l\'inviluppo guarda i RILASCI, non le validazioni', () => {
    const r = riepilogoRilascio([
      // La validazione comincia alle 18: se entrasse nell'inviluppo, «cosa va
      // in produzione da quando» direbbe due ore prima del vero.
      ci('x', [passo('P', ['2026-09-21T18:00:00Z', '2026-09-21T19:00:00Z'], ['2026-09-21T20:00:00Z', '2026-09-21T21:00:00Z'])]),
    ])
    expect(r.inviluppo).toEqual({ start: '2026-09-21T20:00:00.000Z', end: '2026-09-21T21:00:00.000Z' })
  })
})

describe('le finestre distinte', () => {
  const f = (da: string, a: string) => ({ da: Date.parse(da), a: Date.parse(a) })

  it('due finestre adiacenti sono UN blocco: per chi approva è un fermo continuo', () => {
    expect(contaFinestreDistinte([
      f('2026-09-21T22:00:00Z', '2026-09-21T23:00:00Z'),
      f('2026-09-21T23:00:00Z', '2026-09-22T00:00:00Z'),
    ])).toBe(1)
  })

  it('un buco in mezzo fa due blocchi', () => {
    expect(contaFinestreDistinte([
      f('2026-09-21T22:00:00Z', '2026-09-21T23:00:00Z'),
      f('2026-09-21T23:30:00Z', '2026-09-22T00:00:00Z'),
    ])).toBe(2)
  })

  it('una finestra dentro l\'altra non aggiunge un blocco', () => {
    expect(contaFinestreDistinte([
      f('2026-09-21T22:00:00Z', '2026-09-22T02:00:00Z'),
      f('2026-09-21T23:00:00Z', '2026-09-22T00:00:00Z'),
    ])).toBe(1)
  })

  it('nessuna finestra, nessun blocco (e non uno)', () => {
    expect(contaFinestreDistinte([])).toBe(0)
  })

  it('tre CI in tre notti diverse: il riepilogo lo dice, l\'inviluppo da solo no', () => {
    const r = riepilogoRilascio([
      ci('a', [passo('P', ['2026-09-21T20:00:00Z', '2026-09-21T21:00:00Z'], ['2026-09-21T22:00:00Z', '2026-09-21T23:00:00Z'])]),
      ci('b', [passo('P', ['2026-09-23T20:00:00Z', '2026-09-23T21:00:00Z'], ['2026-09-23T22:00:00Z', '2026-09-23T23:00:00Z'])]),
      ci('c', [passo('P', ['2026-09-25T20:00:00Z', '2026-09-25T21:00:00Z'], ['2026-09-25T22:00:00Z', '2026-09-25T23:00:00Z'])]),
    ])
    expect(r.finestreDistinte).toBe(3)
    // L'inviluppo copre quattro giorni, ma il fermo vero è di tre ore in tutto.
    expect(r.inviluppo).toEqual({ start: '2026-09-21T22:00:00.000Z', end: '2026-09-25T23:00:00.000Z' })
  })
})

describe('quello che non si può mettere in fila si dice, non si nasconde', () => {
  it('un piano senza passi è elencato col suo task, fuori dalla cronologia', () => {
    const r = riepilogoRilascio([
      ci('srv-app-01', [passo('Deploy', ['2026-09-21T20:00:00Z', '2026-09-21T21:00:00Z'], ['2026-09-21T22:00:00Z', '2026-09-21T23:00:00Z'])]),
      ci('srv-app-02', [], { taskCode: 'TASK00000051', pianoStato: 'pending', supportGroup: 'Team Sistemi' }),
    ])
    expect(r.voci).toHaveLength(2)
    expect(r.senzaDate).toHaveLength(1)
    expect(r.senzaDate[0]).toMatchObject({ ciName: 'srv-app-02', taskCode: 'TASK00000051', vuoto: true, teamName: 'Team Sistemi' })
  })

  it('una data illeggibile non entra nell\'inviluppo: sommarla darebbe NaN in silenzio', () => {
    const r = riepilogoRilascio([
      ci('rotto', [passo('P', ['non-una-data', 'nemmeno'], ['neanche', 'questa'])], { taskCode: 'TASK-R' }),
      ci('buono', [passo('P', ['2026-09-21T20:00:00Z', '2026-09-21T21:00:00Z'], ['2026-09-21T22:00:00Z', '2026-09-21T23:00:00Z'])]),
    ])
    expect(r.voci.every((v) => Number.isFinite(v.inizio))).toBe(true)
    expect(r.inviluppo).toEqual({ start: '2026-09-21T22:00:00.000Z', end: '2026-09-21T23:00:00.000Z' })
    // E il piano rotto non sparisce: ha dei passi, ma date inservibili.
    expect(r.senzaDate[0]).toMatchObject({ ciName: 'rotto', vuoto: false })
  })

  it('una finestra che finisce prima di cominciare si rifiuta, invece di ordinarsi a rovescio', () => {
    const r = riepilogoRilascio([
      ci('x', [passo('P', ['2026-09-21T20:00:00Z', '2026-09-21T21:00:00Z'], ['2026-09-21T23:00:00Z', '2026-09-21T22:00:00Z'])]),
    ])
    expect(r.voci.map((v) => v.tipo)).toEqual(['validation'])
    expect(r.inviluppo).toBeNull()
  })
})

describe('l\'avanzamento si conta task per task', () => {
  it('conta i tre task di OGNI CI impattato, anche di quelli non ancora pianificati', () => {
    const r = riepilogoRilascio([
      ci('a', [passo('P', ['2026-09-21T20:00:00Z', '2026-09-21T21:00:00Z'], ['2026-09-21T22:00:00Z', '2026-09-21T23:00:00Z'])]),
      // Solo il funzionale è chiuso: gli altri due task pesano nel totale.
      ci('b', [], { assess: ['completed', 'pending'], pianoStato: 'pending' }),
    ])
    expect(r.taskTotali).toBe(6)
    expect(r.taskChiusi).toBe(4)
  })

  it('«compilato» e «completato» sono due conte diverse', () => {
    const r = riepilogoRilascio([
      // Ha dei passi ma il task è ancora aperto: si sta lavorando.
      ci('a', [passo('P', ['2026-09-21T20:00:00Z', '2026-09-21T21:00:00Z'], ['2026-09-21T22:00:00Z', '2026-09-21T23:00:00Z'])], { pianoStato: 'in-progress' }),
      ci('b', [passo('P', ['2026-09-22T20:00:00Z', '2026-09-22T21:00:00Z'], ['2026-09-22T22:00:00Z', '2026-09-22T23:00:00Z'])], { pianoStato: 'completed' }),
    ])
    expect(r.pianiCompilati).toBe(2)
    expect(r.pianiCompletati).toBe(1)
  })
})

/**
 * IL GANTT: l'aritmetica delle barre (18 set 2026).
 *
 * Un diagramma si guarda e sembra giusto — è il tipo di cosa che a occhio non
 * si controlla. Quello che si pinna qui è dove comincia una barra, quanto è
 * larga, e la sola bugia ammessa: una finestra troppo breve per vedersi viene
 * ALLARGATA, e la barra lo dichiara.
 */
describe('le barre del Gantt', () => {
  const g = (ms: number) => new Date(2026, 9, 1, 0, 0, 0, 0).getTime() + ms
  const ora = 60 * 60 * 1000
  const voce = (inizio: number, fine: number, tipo: 'validation' | 'release' = 'release') => ({
    tipo, start: new Date(g(inizio)).toISOString(), end: new Date(g(fine)).toISOString(),
    inizio: g(inizio), fine: g(fine),
    stepTitle: 'Passo', taskCode: 'TASK1', ciId: 'ci1', ciName: 'srv-01',
  })

  it('la prima barra parte da zero e l\'ultima finisce a cento', () => {
    const barre = barreDelPiano([voce(0, 2 * ora), voce(8 * ora, 10 * ora)])
    expect(barre[0]!.sinistra).toBe(0)
    expect(barre[1]!.sinistra + barre[1]!.larghezza).toBeCloseTo(100, 6)
  })

  it('la larghezza è la durata, in proporzione all\'asse', () => {
    // Asse di 10 ore: una finestra di 2 ore è il 20%.
    const barre = barreDelPiano([voce(0, 2 * ora), voce(8 * ora, 10 * ora)])
    expect(barre[0]!.larghezza).toBeCloseTo(20, 6)
    expect(barre[0]!.allungata).toBe(false)
  })

  it('una finestra troppo breve si vede, e la barra DICHIARA di essere allargata', () => {
    // Mezz'ora su venti giorni: lo 0,1%, cioè invisibile. Mentire sulla durata
    // è accettabile solo se il codice lo dice a chi disegna, che lo dirà a chi
    // guarda: il titolo della barra porta le date vere.
    const venti = 20 * 24 * ora
    const barre = barreDelPiano([voce(0, ora / 2), voce(venti - ora, venti)])
    expect(barre[0]!.allungata).toBe(true)
    expect(barre[0]!.larghezza).toBeGreaterThan(1)
  })

  it('una barra allargata non esce mai dall\'asse', () => {
    const venti = 20 * 24 * ora
    const barre = barreDelPiano([voce(0, ora), voce(venti - ora / 4, venti)])
    for (const b of barre) expect(b.sinistra + b.larghezza).toBeLessThanOrEqual(100.0001)
  })

  it('l\'asse comprende le VALIDAZIONI, non solo i rilasci: il Gantt mostra tutto il piano', () => {
    const barre = barreDelPiano([voce(0, ora, 'validation'), voce(9 * ora, 10 * ora, 'release')])
    expect(barre).toHaveLength(2)
    expect(barre[0]!.sinistra).toBe(0)
  })

  it('senza voci non c\'è niente da disegnare, e nemmeno un asse', () => {
    expect(barreDelPiano([])).toEqual([])
    expect(asseDelPiano([])).toBeNull()
  })

  it('un piano di durata zero non si disegna: un asse che non si può dividere', () => {
    expect(asseDelPiano([voce(0, 0)])).toBeNull()
    expect(barreDelPiano([voce(0, 0)])).toEqual([])
  })

  it('la prima tacca è l\'inizio del piano, le altre cadono a mezzanotte', () => {
    // Le tacche dopo la prima stanno a mezzanotte: un riferimento a un'ora
    // qualunque non è un riferimento, è un numero in mezzo al disegno.
    const tacche = taccheDelPiano([voce(6 * ora, 3 * 24 * ora)])
    expect(tacche.length).toBeGreaterThan(1)
    expect(tacche[0]!.sinistra).toBe(0)
    for (const tacca of tacche.slice(1)) {
      const d = new Date(tacca.quando)
      expect([d.getHours(), d.getMinutes()]).toEqual([0, 0])
    }
    for (const tacca of tacche) {
      expect(tacca.sinistra).toBeGreaterThanOrEqual(0)
      expect(tacca.sinistra).toBeLessThanOrEqual(100)
    }
  })

  it('su un piano lungo le tacche si diradano invece di diventare illeggibili', () => {
    const tacche = taccheDelPiano([voce(0, 60 * 24 * ora)], 8)
    expect(tacche.length).toBeLessThanOrEqual(9)
  })
})

describe('la prima tacca del Gantt', () => {
  const g = (ms: number) => new Date(2026, 9, 2, 0, 0, 0, 0).getTime() + ms
  const ora = 60 * 60 * 1000
  const voce = (inizio: number, fine: number) => ({
    tipo: 'release' as const, start: new Date(g(inizio)).toISOString(), end: new Date(g(fine)).toISOString(),
    inizio: g(inizio), fine: g(fine),
    stepTitle: 'P', taskCode: null, ciId: 'ci1', ciName: 'srv-01',
  })

  it('c\'è sempre, ed è l\'inizio del piano', () => {
    // Il caso visto dal vivo: si comincia alle 14:00 del 2 ottobre, e la prima
    // mezzanotte utile è il 3 — la prima barra restava senza data.
    const tacche = taccheDelPiano([voce(14 * ora, 2 * 24 * ora + ora)])
    expect(tacche[0]!.sinistra).toBe(0)
    expect(tacche[0]!.quando).toBe(g(14 * ora))
  })

  it('una mezzanotte troppo vicina all\'inizio non si aggiunge: due date attaccate non si leggono', () => {
    // Comincia alle 23:00: la mezzanotte è un'ora dopo, su un asse di 5 giorni.
    const tacche = taccheDelPiano([voce(23 * ora, 5 * 24 * ora)])
    const vicine = tacche.filter((x) => x.sinistra > 0 && x.sinistra < 8)
    expect(vicine).toHaveLength(0)
  })
})

describe('il filtro per tipo', () => {
  /* Due CI: uno con validazione + rilascio, uno col solo rilascio. */
  const voci = riepilogoRilascio([
    ci('fw-01', [passo('Regole', ['2026-10-02T09:00:00Z', '2026-10-02T10:00:00Z'], ['2026-10-02T22:00:00Z', '2026-10-02T23:00:00Z'])]),
    ci('db-01', [{ title: 'Migrazione', releaseWindow: { start: '2026-10-03T22:00:00Z', end: '2026-10-03T23:00:00Z' } } as DeployStep]),
  ]).voci

  it('«entrambi» non toglie niente', () => {
    expect(vociFiltrate(voci, 'all')).toEqual([...voci])
  })

  it('tiene solo il tipo chiesto, e NON riordina', () => {
    const rilasci = vociFiltrate(voci, 'release')
    expect(rilasci.map((v) => `${v.ciName}/${v.tipo}`)).toEqual(['fw-01/release', 'db-01/release'])
    // Filtrare non è riordinare: i rilasci restano in ordine di data, come
    // stavano nella cronologia completa.
    expect(rilasci.map((v) => v.inizio)).toEqual([...rilasci.map((v) => v.inizio)].sort((a, b) => a - b))
    expect(vociFiltrate(voci, 'validation').map((v) => v.ciName)).toEqual(['fw-01'])
  })

  it('conta per tipo, e il totale è la somma dei due', () => {
    const c = contaPerTipo(voci)
    expect(c).toEqual({ all: 3, release: 2, validation: 1 })
    expect(c.release + c.validation).toBe(c.all)
  })

  it('un piano senza validazioni lo dice col conto, prima del clic', () => {
    const soloRilasci = vociFiltrate(voci, 'release')
    expect(contaPerTipo(soloRilasci).validation).toBe(0)
    expect(vociFiltrate(soloRilasci, 'validation')).toEqual([])
  })

  it('il Gantt filtrato si ridisegna sulle sole voci rimaste', () => {
    // L'asse segue quello che si vede: togliendo la validazione del mattino,
    // il disegno comincia dal primo rilascio. Le tacche portano le date vere,
    // quindi la scala resta leggibile.
    const asseTutto = asseDelPiano(voci)
    const asseSoloRilasci = asseDelPiano(vociFiltrate(voci, 'release'))
    expect(asseTutto?.da).toBeLessThan(asseSoloRilasci?.da ?? 0)
  })
})
