/**
 * IL TETTO DI SPESA (20 set 2026, rimedio c).
 *
 * Nasce da un rilievo verificato della revisione adversarial: non esisteva
 * nessun tetto, da nessuna parte, mentre `runProposalAnalysis` faceva tre
 * chiamate al modello dentro la richiesta HTTP con un freno da 5 al minuto
 * PER TENANT e PER REPLICA, su una chiave Anthropic unica per tutta la
 * piattaforma. Un cliente solo poteva prosciugare il budget di tutti.
 *
 * Due regole contano più delle altre e questi test le tengono ferme:
 * il tetto è del CLIENTE (non della funzione), e se il consumo non si può
 * LEGGERE non si spende.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

/** Il totale di piattaforma che il finto Neo4j restituisce. `null` = query rotta. */
const piattaforma = { gettoni: 0 as number | null }
vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => ({
    run: async () => {
      if (piattaforma.gettoni === null) throw new Error('Neo4j irraggiungibile')
      return { records: [{ get: () => piattaforma.gettoni }] }
    },
    close: async () => undefined,
  }),
  toNumber: (v: unknown) => Number(v),
}))

const {
  puoSpendere, gettoniDi, FUNZIONI_CON_TETTO,
  leggiTettoDelCliente, leggiTettoDellaPiattaforma,
} = await import('../aiBudget.js')

const riga = (e: Partial<{ month: string; feature: string; input: number; output: number }> = {}) => ({
  tenantId: 'c-test', month: new Date().toISOString().slice(0, 7),
  feature: 'dailyWorkAnalysis', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 1, ...e,
})

afterEach(() => { piattaforma.gettoni = 0 })

describe('quali funzioni governa', () => {
  it('le tre autonome, elencate: aggiungerne una senza pensare al costo si deve vedere', () => {
    expect([...FUNZIONI_CON_TETTO].sort())
      .toEqual(['configurationAssist', 'dailyWorkAnalysis', 'platformSelfAnalysis'])
  })

  it('una funzione senza tetto passa sempre, e non interroga niente', async () => {
    const mai = vi.fn()
    const v = await puoSpendere('c-test', 'triage', mai as never)
    expect(v.consentito).toBe(true)
    expect(mai).not.toHaveBeenCalled()
  })
})

describe('il tetto è del CLIENTE, non della funzione', () => {
  it('sotto la soglia si spende', async () => {
    const v = await puoSpendere('c-test', 'dailyWorkAnalysis',
      async () => [riga({ input: 1000, output: 500 })])
    expect(v.consentito).toBe(true)
    expect(v.usati).toBe(1500)
  })

  it('il conto SOMMA le funzioni con tetto: il budget è del cliente', async () => {
    // Tre analisti sotto soglia da soli possono essere sopra soglia insieme.
    const v = await puoSpendere('c-test', 'dailyWorkAnalysis', async () => [
      riga({ feature: 'dailyWorkAnalysis',   input: 900_000 }),
      riga({ feature: 'configurationAssist', input: 900_000 }),
      riga({ feature: 'platformSelfAnalysis', input: 900_000 }),
    ])
    expect(v.consentito).toBe(false)
    expect(v.tetto).toBe('tenant')
  })

  it('una funzione SENZA tetto non consuma il budget di chi ce l\'ha', async () => {
    const v = await puoSpendere('c-test', 'dailyWorkAnalysis', async () => [
      riga({ feature: 'triage', input: 9_000_000 }),
    ])
    expect(v.consentito).toBe(true)
    expect(v.usati).toBe(0)
  })

  it('i mesi passati non contano: il tetto è mensile', async () => {
    const v = await puoSpendere('c-test', 'dailyWorkAnalysis', async () => [
      riga({ month: '2020-01', input: 9_000_000 }),
    ])
    expect(v.consentito).toBe(true)
    expect(v.usati).toBe(0)
  })

  it('anche i gettoni di cache si pagano, quindi si contano', () => {
    expect(gettoniDi({ input: 1, output: 2, cacheRead: 4, cacheWrite: 8 })).toBe(15)
  })
})

describe('il tetto della PIATTAFORMA è un secondo tetto, non lo stesso', () => {
  it('un cliente sotto la sua soglia si ferma se la piattaforma è alla sua', async () => {
    piattaforma.gettoni = 99_000_000
    const v = await puoSpendere('c-test', 'dailyWorkAnalysis', async () => [riga({ input: 10 })])
    expect(v.consentito).toBe(false)
    expect(v.tetto).toBe('platform')
  })
})

describe('se il consumo non si può LEGGERE, non si spende', () => {
  it('registro irraggiungibile = chiuso', async () => {
    // Stessa regola del varco dell'archivio: una spesa che non si può
    // misurare è quella che non si vuole autorizzare. E se il registro non
    // si legge, `registraCosto` non scriverà nemmeno dopo: quella chiamata
    // non verrebbe MAI contata.
    const v = await puoSpendere('c-test', 'dailyWorkAnalysis',
      async () => { throw new Error('Neo4j irraggiungibile') })
    expect(v.consentito).toBe(false)
    expect(v.tetto).toBe('unreadable')
  })

  it('totale di piattaforma irraggiungibile = chiuso', async () => {
    piattaforma.gettoni = null
    const v = await puoSpendere('c-test', 'dailyWorkAnalysis', async () => [riga()])
    expect(v.consentito).toBe(false)
    expect(v.tetto).toBe('unreadable')
  })
})

describe('i due tetti si configurano, e un valore storto ferma l\'avvio', () => {
  it('senza variabile, il default dichiarato', () => {
    expect(leggiTettoDelCliente({})).toBe(2_000_000)
    expect(leggiTettoDellaPiattaforma({})).toBe(20_000_000)
  })

  it('un valore valido vince sul default', () => {
    expect(leggiTettoDelCliente({ AI_MONTHLY_TOKEN_BUDGET_TENANT: '500' })).toBe(500)
  })

  it.each(['zero', '-1', '0', '1.5', ''])('«%s» non diventa un default silenzioso', (v) => {
    if (v === '') {
      // Vuota = non impostata: è il caso di una variabile presente e non valorizzata.
      expect(leggiTettoDelCliente({ AI_MONTHLY_TOKEN_BUDGET_TENANT: v })).toBe(2_000_000)
      return
    }
    expect(() => leggiTettoDelCliente({ AI_MONTHLY_TOKEN_BUDGET_TENANT: v })).toThrow()
  })
})
