/**
 * IL MODELLO DEL CALENDARIO DELLE CHANGE.
 *
 * Tre cose che a occhio non si controllano, e che sbagliate rendono il
 * calendario plausibile e falso: l'intervallo che si guarda, i giorni in cui
 * cade una finestra, e le sovrapposizioni. Un calendario che nasconde un
 * rilascio si legge come «quella notte non si rilascia niente».
 */
import { describe, it, expect } from 'vitest'
import {
  intervallo, scorri, inizioSettimana, conSovrapposizioni, riassunto, barreDellaSettimana, settimane, soloDelTipo, soloDelloStato,
  type VoceCalendario,
} from '../changeCalendarModel'

const voce = (over: Partial<VoceCalendario> & { code: string; start: string; end: string }): VoceCalendario => ({
  changeId: `id-${over.code}`, title: 'T', changeType: 'normal', priority: 'medium',
  currentStep: 'scheduled', kind: 'release', stepTitle: 'P', taskCode: 'TASK1',
  ciId: 'ci-1', ciName: 'srv-01', ...over,
})

describe('l\'intervallo che si guarda', () => {
  it('la settimana comincia di LUNEDÌ, anche partendo da una domenica', () => {
    // `getDay()` dà 0 per domenica: tirarla avanti di uno darebbe la settimana
    // dopo, e la domenica sparirebbe dal calendario di entrambe.
    expect(inizioSettimana(new Date(2026, 8, 20)).getDate()).toBe(14) // dom 20 set → lun 14
    expect(inizioSettimana(new Date(2026, 8, 14)).getDate()).toBe(14) // un lunedì resta sé stesso
  })

  it('in settimana sono sette giorni, dal lunedì alla domenica', () => {
    const { giorni } = intervallo('week', new Date(2026, 8, 17))
    expect(giorni).toHaveLength(7)
    expect(giorni[0]!.getDate()).toBe(14)
    expect(giorni[6]!.getDate()).toBe(20)
  })

  it('in mese la griglia parte dal lunedì prima del primo e chiude la domenica dopo l\'ultimo', () => {
    // Settembre 2026 comincia di martedì: la casella iniziale è lunedì 31
    // agosto. Senza le code, quei giorni resterebbero vuoti per finta.
    const { giorni } = intervallo('month', new Date(2026, 8, 17))
    expect(giorni[0]!.getMonth()).toBe(7)
    expect(giorni[0]!.getDate()).toBe(31)
    expect(giorni[giorni.length - 1]!.getDay()).toBe(0)
    expect(giorni.length % 7).toBe(0)
  })

  it('l\'intervallo chiesto all\'API copre tutte le caselle disegnate', () => {
    const { da, a, giorni } = intervallo('month', new Date(2026, 8, 17))
    expect(da.getTime()).toBe(giorni[0]!.getTime())
    // `a` è l'istante dopo l'ultimo giorno: una finestra che comincia alle
    // 23:00 dell'ultima domenica deve ancora entrare.
    expect(a.getTime()).toBe(giorni[giorni.length - 1]!.getTime() + 86_400_000)
  })

  it('scorrere avanti e indietro torna al punto di partenza', () => {
    const rif = new Date(2026, 8, 17)
    expect(scorri('week', scorri('week', rif, 1), -1).getTime()).toBe(rif.getTime())
    expect(scorri('month', rif, 1).getMonth()).toBe(9)
    expect(scorri('month', rif, -1).getMonth()).toBe(7)
  })
})

describe('le sovrapposizioni', () => {
  it('due rilasci che si accavallano sullo STESSO CI sono un conflitto', () => {
    const r = conSovrapposizioni([
      voce({ code: 'CHG1', start: '2026-09-21T22:00:00Z', end: '2026-09-22T00:00:00Z', ciId: 'ci-A' }),
      voce({ code: 'CHG2', start: '2026-09-21T23:00:00Z', end: '2026-09-22T01:00:00Z', ciId: 'ci-A' }),
    ])
    expect(r.map((v) => v.sovrapposizione)).toEqual(['clash', 'clash'])
    expect(r[0]!.conflittoCon).toEqual(['CHG2'])
    expect(r[1]!.conflittoCon).toEqual(['CHG1'])
  })

  it('su CI diversi è un avviso, non un conflitto', () => {
    const r = conSovrapposizioni([
      voce({ code: 'CHG1', start: '2026-09-21T22:00:00Z', end: '2026-09-22T00:00:00Z', ciId: 'ci-A' }),
      voce({ code: 'CHG2', start: '2026-09-21T23:00:00Z', end: '2026-09-22T01:00:00Z', ciId: 'ci-B' }),
    ])
    expect(r.map((v) => v.sovrapposizione)).toEqual(['warn', 'warn'])
  })

  it('una change NON si sovrappone a sé stessa: i suoi passi sono un piano', () => {
    const r = conSovrapposizioni([
      voce({ code: 'CHG1', changeId: 'x', start: '2026-09-21T22:00:00Z', end: '2026-09-22T00:00:00Z', ciId: 'ci-A' }),
      voce({ code: 'CHG1', changeId: 'x', start: '2026-09-21T23:00:00Z', end: '2026-09-22T01:00:00Z', ciId: 'ci-A' }),
    ])
    expect(r.map((v) => v.sovrapposizione)).toEqual(['none', 'none'])
  })

  it('le VALIDAZIONI non contano: sono verifiche, non rilasci', () => {
    const r = conSovrapposizioni([
      voce({ code: 'CHG1', kind: 'validation', start: '2026-09-21T20:00:00Z', end: '2026-09-21T22:00:00Z', ciId: 'ci-A' }),
      voce({ code: 'CHG2', kind: 'validation', start: '2026-09-21T21:00:00Z', end: '2026-09-21T23:00:00Z', ciId: 'ci-A' }),
    ])
    expect(r.map((v) => v.sovrapposizione)).toEqual(['none', 'none'])
  })

  it('due finestre che si TOCCANO (una finisce quando l\'altra comincia) non si sovrappongono', () => {
    const r = conSovrapposizioni([
      voce({ code: 'CHG1', start: '2026-09-21T22:00:00Z', end: '2026-09-21T23:00:00Z', ciId: 'ci-A' }),
      voce({ code: 'CHG2', start: '2026-09-21T23:00:00Z', end: '2026-09-22T00:00:00Z', ciId: 'ci-A' }),
    ])
    expect(r.map((v) => v.sovrapposizione)).toEqual(['none', 'none'])
  })

  it('il livello di una voce è il PEGGIORE dei suoi urti', () => {
    const r = conSovrapposizioni([
      voce({ code: 'CHG1', start: '2026-09-21T22:00:00Z', end: '2026-09-22T02:00:00Z', ciId: 'ci-A' }),
      voce({ code: 'CHG2', start: '2026-09-21T23:00:00Z', end: '2026-09-22T00:00:00Z', ciId: 'ci-B' }),
      voce({ code: 'CHG3', start: '2026-09-22T00:30:00Z', end: '2026-09-22T01:00:00Z', ciId: 'ci-A' }),
    ])
    // La prima urta CHG2 su un altro CI (avviso) e CHG3 sullo stesso (conflitto).
    expect(r[0]!.sovrapposizione).toBe('clash')
    expect(r[0]!.conflittoCon).toEqual(['CHG2', 'CHG3'])
    expect(r[1]!.sovrapposizione).toBe('warn')
    expect(r[2]!.sovrapposizione).toBe('clash')
  })
})

describe('il riassunto in testa', () => {
  it('conta le change distinte, non le finestre', () => {
    const r = riassunto(conSovrapposizioni([
      voce({ code: 'CHG1', changeId: 'x', kind: 'validation', start: '2026-09-21T20:00:00Z', end: '2026-09-21T21:00:00Z' }),
      voce({ code: 'CHG1', changeId: 'x', kind: 'release',    start: '2026-09-21T22:00:00Z', end: '2026-09-21T23:00:00Z' }),
      voce({ code: 'CHG2', changeId: 'y', kind: 'release',    start: '2026-09-22T22:00:00Z', end: '2026-09-22T23:00:00Z' }),
    ]))
    expect(r).toEqual({ change: 2, finestre: 3, rilasci: 2, conflitti: 0, avvisi: 0 })
  })
})

describe('le barre della settimana', () => {
  const sett = intervallo('week', new Date(2026, 8, 7)).giorni // lun 7 → dom 13
  const f = (d1: number, h1: number, d2: number, h2: number) => ({
    start: new Date(2026, 8, d1, h1, 0).toISOString(),
    end:   new Date(2026, 8, d2, h2, 0).toISOString(),
  })

  it('una finestra di due giorni è UNA barra che ne attraversa due', () => {
    // Era il difetto: due caselle separate, il 9 e il 10, che non dicevano di
    // essere la stessa finestra.
    const b = barreDellaSettimana(conSovrapposizioni([voce({ code: 'CHG2', ...f(9, 6, 10, 6) })]), sett)
    expect(b).toHaveLength(1)
    expect(b[0]).toMatchObject({ colonna: 2, span: 2, continuaPrima: false, continuaDopo: false, corsia: 0 })
  })

  it('tre rilasci accavallati stanno su TRE corsie: si vede dalla forma', () => {
    const b = barreDellaSettimana(conSovrapposizioni([
      voce({ code: 'CHG2', changeId: 'a', ciId: 'ci-1', ...f(9, 6, 10, 6) }),
      voce({ code: 'CHG1', changeId: 'b', ciId: 'ci-2', ...f(9, 12, 10, 12) }),
      voce({ code: 'CHG4', changeId: 'c', ciId: 'ci-3', ...f(9, 15, 10, 15) }),
    ]), sett)
    expect(b.map((x) => x.corsia).sort()).toEqual([0, 1, 2])
    // E tutte e tre sono segnate come accavallate.
    expect(b.every((x) => x.v.sovrapposizione === 'warn')).toBe(true)
  })

  it('due finestre che NON si toccano dividono la stessa corsia', () => {
    const b = barreDellaSettimana(conSovrapposizioni([
      voce({ code: 'A', changeId: 'a', ...f(7, 8, 7, 10) }),
      voce({ code: 'B', changeId: 'b', ...f(11, 8, 11, 10) }),
    ]), sett)
    expect(b.map((x) => x.corsia)).toEqual([0, 0])
  })

  it('una finestra che esce dalla settimana lo DICE, invece di sembrare tagliata a misura', () => {
    const b = barreDellaSettimana(conSovrapposizioni([voce({ code: 'X', ...f(5, 20, 9, 6) })]), sett)
    expect(b[0]).toMatchObject({ colonna: 0, span: 3, continuaPrima: true, continuaDopo: false })
    const c = barreDellaSettimana(conSovrapposizioni([voce({ code: 'Y', ...f(12, 20, 16, 6) })]), sett)
    expect(c[0]).toMatchObject({ colonna: 5, span: 2, continuaPrima: false, continuaDopo: true })
  })

  it('una finestra fuori dalla settimana non produce barre', () => {
    expect(barreDellaSettimana(conSovrapposizioni([voce({ code: 'Z', ...f(20, 8, 20, 10) })]), sett)).toEqual([])
  })

  it('le date illeggibili non producono barre', () => {
    expect(barreDellaSettimana(conSovrapposizioni([voce({ code: 'R', start: 'x', end: 'y' })]), sett)).toEqual([])
  })

  it('il mese si divide in settimane da sette', () => {
    const g = intervallo('month', new Date(2026, 8, 17)).giorni
    const s = settimane(g)
    expect(s.every((x) => x.length === 7)).toBe(true)
    expect(s.length).toBe(g.length / 7)
  })
})

describe('il filtro per tipo di finestra', () => {
  const tre = () => conSovrapposizioni([
    voce({ code: 'CHG1', changeId: 'a', ciId: 'ci-1', kind: 'validation', start: '2026-09-21T18:00:00Z', end: '2026-09-21T19:00:00Z' }),
    voce({ code: 'CHG1', changeId: 'a', ciId: 'ci-1', kind: 'release',    start: '2026-09-21T22:00:00Z', end: '2026-09-22T02:00:00Z' }),
    voce({ code: 'CHG2', changeId: 'b', ciId: 'ci-1', kind: 'release',    start: '2026-09-21T23:00:00Z', end: '2026-09-22T01:00:00Z' }),
  ])

  it('«entrambi» non toglie niente', () => {
    expect(soloDelTipo(tre(), 'all')).toHaveLength(3)
  })

  it('«solo rilasci» e «solo validazioni» tengono il loro tipo', () => {
    expect(soloDelTipo(tre(), 'release').map((v) => v.kind)).toEqual(['release', 'release'])
    expect(soloDelTipo(tre(), 'validation').map((v) => v.kind)).toEqual(['validation'])
  })

  it('il filtro NON cancella un conflitto: si applica dopo il calcolo', () => {
    // I due rilasci sono sullo stesso CI: restano segnati come conflitto anche
    // guardando il calendario filtrato. Un filtro di vista non cambia i fatti.
    const soloRilasci = soloDelTipo(tre(), 'release')
    expect(soloRilasci.every((v) => v.sovrapposizione === 'clash')).toBe(true)
    // E il riassunto del periodo continua a contarli, anche filtrando: se lo
    // calcolassimo sul filtrato, «solo validazioni» nasconderebbe l'allerta.
    expect(riassunto(tre()).conflitti).toBe(2)
  })
})

describe('il filtro sullo stato della change', () => {
  const categorie: Record<string, string> = {
    scheduled: 'waiting', deployment: 'active', closed: 'closed',
    annullata: 'failed', risolta: 'resolved',
  }
  const categoriaDi = (s: string | null) => (s ? categorie[s] ?? null : null)
  const w = { start: '2026-09-21T22:00:00Z', end: '2026-09-21T23:00:00Z' }
  const insieme = () => conSovrapposizioni([
    voce({ code: 'IN-CORSO',  changeId: 'a', currentStep: 'deployment', ...w }),
    voce({ code: 'CHIUSA',    changeId: 'b', currentStep: 'closed',     ...w }),
    voce({ code: 'ANNULLATA', changeId: 'c', currentStep: 'annullata',  ...w }),
    voce({ code: 'RISOLTA',   changeId: 'd', currentStep: 'risolta',    ...w }),
    voce({ code: 'SENZA',     changeId: 'e', currentStep: null,         ...w }),
  ])

  it('«tutte» non toglie niente', () => {
    expect(soloDelloStato(insieme(), 'all', categoriaDi)).toHaveLength(5)
  })

  it('«concluse» comprende chiusa, risolta e ANNULLATA', () => {
    // Una change annullata è finita: fra quelle «in corso» gonfierebbe il
    // calendario di lavoro che nessuno farà.
    expect(soloDelloStato(insieme(), 'done', categoriaDi).map((v) => v.code).sort())
      .toEqual(['ANNULLATA', 'CHIUSA', 'RISOLTA'])
  })

  it('«in corso» tiene anche la change senza passo noto, invece di farla sparire', () => {
    expect(soloDelloStato(insieme(), 'open', categoriaDi).map((v) => v.code).sort())
      .toEqual(['IN-CORSO', 'SENZA'])
  })

  it('guarda la CATEGORIA, non il nome: un passo rinominato resta classificato', () => {
    const rinominato = (s: string | null) => (s === 'Chiusa e archiviata' ? 'closed' : null)
    const v = conSovrapposizioni([voce({ code: 'X', currentStep: 'Chiusa e archiviata', ...w })])
    expect(soloDelloStato(v, 'done', rinominato).map((x) => x.code)).toEqual(['X'])
    expect(soloDelloStato(v, 'open', rinominato)).toEqual([])
  })
})
