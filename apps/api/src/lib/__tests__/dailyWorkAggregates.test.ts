/**
 * LE REGOLE DEGLI AGGREGATI (20 set 2026, ondata 2).
 *
 * Non provano che i numeri siano giusti — quello lo prova guardarli su dati
 * veri, ed è il motivo per cui esiste la pagina. Provano le REGOLE che, se
 * saltano, rendono i numeri sbagliati in modo silenzioso:
 *
 *  - il lavoro delle macchine non conta come lavoro di persone;
 *  - questo stesso programma non finisce nei propri aggregati (l'anello);
 *  - gli zeri finti dell'import non entrano nelle statistiche;
 *  - la media non compare da nessuna parte;
 *  - le soglie sono nella query o nel filtro, non nella testa di chi legge.
 */
import { describe, it, expect, vi } from 'vitest'

const eseguite = vi.hoisted(() => ({ query: [] as string[], params: [] as Record<string, unknown>[] }))

vi.mock('@opengraphity/neo4j', () => ({ getSession: () => ({ close: async () => undefined }) }))
vi.mock('../../graphql/resolvers/ci-utils.js', () => ({
  runQuery: async (_s: unknown, q: string, p: Record<string, unknown>) => {
    eseguite.query.push(q); eseguite.params.push(p)
    return []
  },
  runQueryOne: async (_s: unknown, q: string, p: Record<string, unknown>) => {
    eseguite.query.push(q); eseguite.params.push(p)
    return { n: 0, creati: 0 }
  },
}))
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const {
  azioniUmane, tempiNeiPassi, coppieRipetute, adozioneFunzioniAI, SOGLIE,
} = await import('../dailyWorkAggregates.js')

const ultimaQuery = () => eseguite.query[eseguite.query.length - 1] ?? ''
const ultimiParams = () => eseguite.params[eseguite.params.length - 1] ?? {}

describe('il lavoro delle macchine non è lavoro di persone', () => {
  it('le azioni umane escludono gli attori sintetici, e li passano come parametro', async () => {
    await azioniUmane('t1', 30)
    expect(ultimaQuery()).toContain('NOT a.user_id IN $__attoriSintetici')
    const sintetici = ultimiParams()['__attoriSintetici'] as string[]
    // I tre che pesano davvero, misurati sul grafo: monitoring 1.051 voci,
    // e2e 148, automation 35.
    expect(sintetici).toContain('monitoring')
    expect(sintetici).toContain('e2e')
    expect(sintetici).toContain('automation')
  })

  it('anche le coppie: due azioni di una macchina non sono un\'abitudine', async () => {
    await coppieRipetute('t1', 30)
    expect(ultimaQuery()).toContain('NOT a.user_id IN $__attoriSintetici')
  })

  it('un user_id vuoto non passa per persona', async () => {
    await azioniUmane('t1', 30)
    expect(ultimaQuery()).toContain("a.user_id <> ''")
    expect(ultimaQuery()).toContain('a.user_id IS NOT NULL')
  })
})

describe('l\'anello: gli aggregati non guardano sé stessi', () => {
  it('le azioni sulle proposte sono escluse — altrimenti l\'analista propone di automatizzarsi', async () => {
    await azioniUmane('t1', 30)
    const escluse = ultimiParams()['__azioniDelProgramma'] as string[]
    expect(escluse).toContain('proposal.accepted')
    expect(escluse).toContain('proposal.analysis_run')
    expect(ultimaQuery()).toContain('NOT a.action IN $__azioniDelProgramma')
  })

  it('nelle coppie l\'esclusione vale per TUTTE E DUE le azioni', async () => {
    await coppieRipetute('t1', 30)
    const q = ultimaQuery()
    expect(q).toContain('NOT a.action IN $__azioniDelProgramma')
    expect(q, 'anche la seconda azione della coppia').toContain('NOT b.action IN $__azioniDelProgramma')
  })
})

describe('i tempi nei passi', () => {
  it('MEDIANA E p90, e la media non compare', async () => {
    await tempiNeiPassi('t1', 30)
    const q = ultimaQuery()
    expect(q).toContain('percentileCont(ore, 0.5)')
    expect(q).toContain('percentileCont(ore, 0.9)')
    // Su c-one la media di `assigned` è 5,57 h contro una mediana di 1,14:
    // chi la leggesse crederebbe a un problema che riguarda 3 ticket su 1.185.
    expect(q, 'niente avg(): la media mente su questi dati').not.toContain('avg(')
  })

  it('gli ZERI DELL\'IMPORT non entrano nelle statistiche, e si contano a parte', async () => {
    await tempiNeiPassi('t1', 30)
    const q = ultimaQuery()
    expect(q).toContain('WHEN w.duration_ms > 0')
    expect(q).toContain('WHEN w.duration_ms = 0 THEN 1')
  })

  it('`percentileCont` riceve righe, NON una lista', async () => {
    // L'errore della prima versione: `collect()` e poi il percentile sulla
    // lista. Neo4j lo rifiuta, e il guardiano delle query allora taceva.
    await tempiNeiPassi('t1', 30)
    expect(ultimaQuery()).not.toContain('collect(')
  })
})

describe('le soglie', () => {
  it('sono dichiarate, e la finestra delle coppie arriva alla query in secondi', async () => {
    await coppieRipetute('t1', 30)
    expect(ultimiParams()['finestraSecondi']).toBe(SOGLIE.coppia.minutiMassimi * 60)
  })

  it('una coppia ha bisogno di ripetersi, su oggetti diversi, per mano di più persone', () => {
    // Dieci occorrenze su un solo ticket sono una correzione; dieci per mano
    // di una persona sola sono il suo modo di lavorare.
    expect(SOGLIE.coppia.occorrenze).toBeGreaterThanOrEqual(10)
    expect(SOGLIE.coppia.oggettiDistinti).toBeGreaterThanOrEqual(3)
    expect(SOGLIE.coppia.autoriDistinti).toBeGreaterThanOrEqual(2)
  })

  it('un passo senza abbastanza esecuzioni non ha una mediana credibile', () => {
    expect(SOGLIE.esecuzioniMinimePerPasso).toBeGreaterThanOrEqual(30)
  })
})

describe('l\'adozione delle funzioni AI', () => {
  it('guarda solo le persone: un giro automatico non è adozione', async () => {
    await adozioneFunzioniAI('t1', 30)
    expect(ultimaQuery()).toContain('NOT a.user_id IN $__attoriSintetici')
  })
})

describe('la finestra', () => {
  it('arriva alla query come data, non come numero di giorni', async () => {
    await azioniUmane('t1', 7)
    const da = String(ultimiParams()['da'])
    expect(da).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    const giorni = (Date.now() - new Date(da).getTime()) / 86_400_000
    expect(giorni).toBeGreaterThan(6.9)
    expect(giorni).toBeLessThan(7.1)
  })
})
