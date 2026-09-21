/**
 * LE REGOLE DELL'ANALISTA DEL LAVORO QUOTIDIANO (20 set 2026, ondata 5).
 *
 * Due gruppi di prove, e provano cose diverse:
 *
 *  - i CANDIDATI: che cosa il modello può anche solo vedere. È deterministico,
 *    quindi è qui che si decide il perimetro;
 *  - la VALIDAZIONE: che cosa di quello che il modello risponde diventa una
 *    proposta. Il modello può sbagliare due cose sole, perché due sole gliene
 *    abbiamo lasciate.
 */
import { describe, it, expect } from 'vitest'
import {
  candidatiDa, validaProposte, GENERI, SOGLIE_ANALISTA, type Candidato,
} from '../dailyWorkAnalyst.js'
import type { CoppiaRipetuta, TempoNelPasso } from '../dailyWorkAggregates.js'

const coppia = (e: Partial<CoppiaRipetuta> = {}): CoppiaRipetuta =>
  ({ prima: 'incident.assigned', poi: 'incident.step_entered', n: 22, oggettiDistinti: 6, autoriDistinti: 3, ...e })

const passo = (e: Partial<TempoNelPasso> = {}): TempoNelPasso =>
  ({ stepName: 'assigned', n: 40, medianaOre: 1.5, p90Ore: 8, oltre48h: 0, zeriScartati: 0, ...e })

describe('i candidati: che cosa il modello può vedere', () => {
  it('una coppia di azioni DIVERSE è un candidato da automatizzare', () => {
    const [c] = candidatiDa([coppia()], [], 30)
    expect(c!.genere).toBe('proposal.dailyWorkPairToAutomation')
  })

  it('un passo attraversato in un soffio è l\'ALTRA coda della stessa distribuzione', () => {
    // La prima versione di questo genere leggeva le coppie di un'azione con
    // sé stessa, che `coppieRipetute()` non produce MAI — un genere cablato
    // al vuoto, trovato facendo girare l'analista dal vivo e non qui.
    const passi = [passo({ stepName: 'a', medianaOre: 10 }), passo({ stepName: 'b', medianaOre: 12 }),
                   passo({ stepName: 'lampo', medianaOre: 0.2 })]
    const trovati = candidatiDa([], passi, 30)
    expect(trovati.map((c) => c.genere)).toContain('proposal.dailyWorkInstantStep')
    expect(trovati.find((c) => c.genere === 'proposal.dailyWorkInstantStep')!.params['step']).toBe('lampo')
  })

  it('NESSUN candidato porta un\'azione, finché non c\'è un parametro estratto dal registro', () => {
    // La regola dell'area: il modello sceglie e spiega, i parametri
    // eseguibili li calcola il codice. Senza un valore costante non c'è
    // niente da mettere in un'automazione, e non si inventa.
    const tutti = candidatiDa([coppia(), coppia({ prima: 'a', poi: 'a' })], [passo()], 30)
    for (const c of tutti) expect(c.action).toBeNull()
  })

  it('un passo è lento RISPETTO agli altri, non in assoluto', () => {
    // Un passo di attesa del cliente sta fermo giorni ed è giusto così.
    const passi = [passo({ stepName: 'a', medianaOre: 1 }), passo({ stepName: 'b', medianaOre: 1.2 }),
                   passo({ stepName: 'lento', medianaOre: 40 })]
    const lenti = candidatiDa([], passi, 30).filter((c) => c.genere === 'proposal.dailyWorkSlowStep')
    expect(lenti.map((c) => c.params['step'])).toEqual(['lento'])
  })

  it('con un passo solo non si confronta niente, e non si propone niente', () => {
    expect(candidatiDa([], [passo({ medianaOre: 500 })], 30)).toHaveLength(0)
  })

  it('un passo con poche esecuzioni non entra: la sua mediana non è credibile', () => {
    const passi = [passo({ stepName: 'a', medianaOre: 1 }), passo({ stepName: 'raro', n: 5, medianaOre: 90 })]
    expect(candidatiDa([], passi, 30).map((c) => c.params['step'])).not.toContain('raro')
  })

  it('ogni candidato ha un id STABILE, che è quello che il modello cita', () => {
    const [c] = candidatiDa([coppia()], [], 30)
    expect(c!.id).toBe('coppia:incident.assigned>incident.step_entered')
    // E l'impronta non contiene conteggi: domani la stessa coppia con numeri
    // diversi è la stessa proposta, non una nuova.
    expect(c!.scope).not.toMatch(/\d/)
  })
})

const cand = (e: Partial<Candidato> = {}): Candidato => ({
  id: 'coppia:a>b', genere: 'proposal.dailyWorkPairToAutomation', scope: 'pair:a>b',
  perIlModello: {}, params: { first: 'a', then: 'b', count: '22', actors: '3', objects: '6' },
  n: 22, windowDays: 30, action: null, ...e,
})

const ctx = { tenantId: 'c-test', candidati: [cand()], lingua: 'it' }
const risposta = (e: Record<string, unknown>) => ({
  proposte: [{ kind: 'proposal.dailyWorkPairToAutomation', riferimento: 'coppia:a>b', rationale: 'perché sì', ...e }],
})

describe('la validazione: che cosa diventa una proposta', () => {
  it('un riferimento che non è fra gli aggregati viene scartato', () => {
    const { proposte, motivi } = validaProposte(risposta({ riferimento: 'coppia:inventata>x' }), ctx)
    expect(proposte).toHaveLength(0)
    expect(motivi).toContain('reference not in the aggregates')
  })

  it('un genere che non è quello dell\'aggregato citato viene scartato', () => {
    // Il modello non può ridefinire che cosa È una riga: lo decide il codice.
    const { proposte, motivi } = validaProposte(risposta({ kind: 'proposal.dailyWorkSlowStep' }), ctx)
    expect(proposte).toHaveLength(0)
    expect(motivi).toContain('kind does not match the aggregate')
  })

  it('i dati della frase vengono dall\'AGGREGATO, non dalla risposta del modello', () => {
    const { proposte } = validaProposte(risposta({ params: { count: '999999' }, n: 999999 }), ctx)
    expect(proposte[0]!.params['count']).toBe('22')
    expect(proposte[0]!.evidence.n).toBe(22)
  })

  it('l\'azione è quella del candidato: il modello non può aggiungerne una', () => {
    const { proposte } = validaProposte(
      risposta({ action: { type: 'execute_script', params: { code: 'x' } } }), ctx)
    expect(proposte[0]!.action).toBeNull()
  })

  it('un rationale vuoto non passa: una proposta senza perché non è una proposta', () => {
    const { motivi } = validaProposte(risposta({ rationale: '   ' }), ctx)
    expect(motivi).toContain('empty rationale')
  })

  it('la lingua del rationale viene salvata: la pagina lo dice a chi legge in un\'altra', () => {
    expect(validaProposte(risposta({}), ctx).proposte[0]!.rationaleLanguage).toBe('it')
  })

  it('lo stesso aggregato non produce due proposte nella stessa corsa', () => {
    const doppia = { proposte: [risposta({}).proposte[0], risposta({}).proposte[0]] }
    const { proposte, motivi } = validaProposte(doppia, ctx)
    expect(proposte).toHaveLength(1)
    expect(motivi).toContain('reference already used in this run')
  })

  it('e una corsa non supera il proprio tetto', () => {
    const candidati = Array.from({ length: 10 }, (_, i) => cand({ id: `c${String(i)}`, scope: `s${String(i)}` }))
    const molte = { proposte: candidati.map((c) => ({
      kind: c.genere, riferimento: c.id, rationale: 'x',
    })) }
    const { proposte } = validaProposte(molte, { ...ctx, candidati })
    expect(proposte.length).toBe(SOGLIE_ANALISTA.proposteMassime)
  })

  it('una risposta malformata non fa cadere niente', () => {
    for (const rotto of [null, undefined, 'stringa', 7, { proposte: {} }]) {
      expect(() => validaProposte(rotto, ctx)).not.toThrow()
      expect(validaProposte(rotto, ctx).proposte).toHaveLength(0)
    }
  })
})

describe('il perimetro, dichiarato', () => {
  it('l\'area è `daily_work` e i generi sono tre', () => {
    expect(GENERI).toHaveLength(3)
    expect(validaProposte(risposta({}), ctx).proposte[0]!.area).toBe('daily_work')
  })

  it('le prove non puntano a entità: sono aggregati, non ticket', () => {
    // Un link a un ticket che chi legge non può aprire è peggio di nessun link.
    expect(validaProposte(risposta({}), ctx).proposte[0]!.evidence.refs).toEqual([])
  })
})

describe('quando NON si chiama il modello', () => {
  it('la soglia è due, e la ragione è che con una riga sola non c\'è una scelta da fare', () => {
    // Non è una difesa dai dati sottili: da quelli difendono le soglie
    // dell'ondata 2, che ogni candidato ha già superato. È una difesa dallo
    // spendere gettoni per farsi timbrare l'unica riga disponibile.
    expect(SOGLIE_ANALISTA.aggregatiMinimi).toBe(2)
  })
})
