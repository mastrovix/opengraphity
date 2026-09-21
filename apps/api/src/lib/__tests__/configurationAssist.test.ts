/**
 * L'AIUTO ALLA CONFIGURAZIONE (20 set 2026, ondata 6).
 *
 * È l'unico punto del programma in cui il modello scrive TESTO che le persone
 * leggeranno sullo schermo. Una regola conta più di tutte le altre, e questi
 * test la tengono ferma: **non si sovrascrive mai quello che ha scritto una
 * persona** — valore per valore, lingua per lingua, e anche quando la
 * proposta è nata giorni prima e nel frattempo qualcuno ha riempito il buco a
 * mano.
 */
import { describe, it, expect } from 'vitest'
import {
  etichetteMancanti, soloIBuchi, fondiEtichette, MAX_ETICHETTA,
} from '../configurationAssistActions.js'
import { validaProposte, GENERI, SOGLIE_ANALISTA, type Candidato } from '../configurationAnalyst.js'

describe('quali etichette mancano DAVVERO', () => {
  it('una lingua sola può mancare: non è tutto o niente', () => {
    expect(etichetteMancanti(['a'], { a: { it: 'Alfa' } })).toEqual({ a: ['en'] })
  })

  it('una stringa vuota o di soli spazi è un buco, non un\'etichetta', () => {
    expect(etichetteMancanti(['a'], { a: { it: '  ', en: '' } })).toEqual({ a: ['en', 'it'] })
  })

  it('un valore completo non compare', () => {
    expect(etichetteMancanti(['a'], { a: { it: 'Alfa', en: 'Alpha' } })).toEqual({})
  })

  it('un valore senza nessuna etichetta manca in tutte le lingue', () => {
    expect(etichetteMancanti(['lettura'], {})).toEqual({ lettura: ['en', 'it'] })
  })
})

describe('la regola che conta: non si riscrive il lavoro di una persona', () => {
  const mancanti = { lettura: ['en'] as const }

  it('una proposta su una lingua già scritta viene SCARTATA, non persa in silenzio', () => {
    const { tenute, scartate } = soloIBuchi(
      { lettura: { it: 'Lettura mia', en: 'Read' } }, { lettura: ['en'] })
    expect(tenute).toEqual({ lettura: { en: 'Read' } })
    expect(scartate).toContain('lettura/it: already written')
  })

  it('una proposta su un valore che non ha buchi non passa', () => {
    const { tenute, scartate } = soloIBuchi({ scrittura: { en: 'Write' } }, { ...mancanti })
    expect(tenute).toEqual({})
    expect(scartate).toContain('scrittura: nothing missing')
  })

  it('un\'etichetta vuota non riempie un buco: lo lascia visibile', () => {
    // Un buco si vede; un'etichetta vuota sembra un'etichetta.
    expect(soloIBuchi({ lettura: { en: '   ' } }, { lettura: ['en'] }).tenute).toEqual({})
  })

  it('un\'etichetta lunghissima non passa: è una frase, non un\'etichetta', () => {
    const lunga = 'x'.repeat(MAX_ETICHETTA + 1)
    expect(soloIBuchi({ lettura: { en: lunga } }, { lettura: ['en'] }).tenute).toEqual({})
  })

  it('una lingua che non esiste non passa', () => {
    const { scartate } = soloIBuchi(
      { lettura: { de: 'Lesen' } } as never, { lettura: ['en'] })
    expect(scartate).toContain('lettura/de: unknown language')
  })

  it('gli spazi si normalizzano: un\'etichetta non porta a capo', () => {
    expect(soloIBuchi({ lettura: { en: '  Read\n only ' } }, { lettura: ['en'] }).tenute)
      .toEqual({ lettura: { en: 'Read only' } })
  })
})

describe('la fusione', () => {
  it('aggiunge senza togliere', () => {
    expect(fondiEtichette({ a: { it: 'Alfa' } }, { a: { en: 'Alpha' }, b: { it: 'Beta' } }))
      .toEqual({ a: { it: 'Alfa', en: 'Alpha' }, b: { it: 'Beta' } })
  })

  it('e non muta quello che le è stato passato', () => {
    const prima = { a: { it: 'Alfa' } }
    fondiEtichette(prima, { a: { en: 'Alpha' } })
    expect(prima).toEqual({ a: { it: 'Alfa' } })
  })
})

const cand = (e: Partial<Candidato> = {}): Candidato => ({
  vocabulary: 'tipo_accesso', values: ['lettura', 'scrittura'],
  mancanti: { lettura: ['en'], scrittura: ['en'] }, ...e,
})
const ctx = { tenantId: 'c-test', candidati: [cand()], lingua: 'it' }
const risposta = (e: Record<string, unknown>) => ({
  vocabolari: [{
    vocabulary: 'tipo_accesso', rationale: 'perché sì',
    labels: [{ value: 'lettura', en: 'Read' }], ...e,
  }],
})

describe('la validazione della risposta del modello', () => {
  it('un vocabolario che non è fra i candidati viene scartato', () => {
    const { proposte, motivi } = validaProposte(risposta({ vocabulary: 'inventato' }), ctx)
    expect(proposte).toHaveLength(0)
    expect(motivi).toContain('dictionary not among the candidates')
  })

  it('l\'azione porta SOLO le etichette tenute, e nomina il vocabolario', () => {
    const { proposte } = validaProposte(risposta({}), ctx)
    expect(proposte[0]!.action).toEqual({
      type: 'enum_value_labels.fill',
      params: { vocabulary: 'tipo_accesso', labels: { lettura: { en: 'Read' } } },
    })
  })

  it('un valore inventato dal modello non entra nell\'azione', () => {
    const { proposte } = validaProposte(
      risposta({ labels: [{ value: 'lettura', en: 'Read' }, { value: 'inventato', en: 'Made up' }] }), ctx)
    expect(Object.keys((proposte[0]!.action!.params as { labels: object }).labels)).toEqual(['lettura'])
  })

  it('se non resta niente da riempire, non nasce nessuna proposta', () => {
    const { proposte, motivi } = validaProposte(
      risposta({ labels: [{ value: 'lettura', it: 'Lettura' }] }),
      { ...ctx, candidati: [cand({ mancanti: { lettura: ['en'] } })] })
    expect(proposte).toHaveLength(0)
    expect(motivi.some((m) => m.includes('nothing left to fill'))).toBe(true)
  })

  it('il soggetto è il vocabolario, senza conteggi: domani è la stessa proposta', () => {
    const { proposte } = validaProposte(risposta({}), ctx)
    expect(proposte[0]!.scope).toBe('labels:tipo_accesso')
    expect(proposte[0]!.scope).not.toMatch(/\d/)
  })

  it('una risposta malformata non fa cadere niente', () => {
    for (const rotto of [null, undefined, 'x', 3, { vocabolari: {} }]) {
      expect(() => validaProposte(rotto, ctx)).not.toThrow()
      expect(validaProposte(rotto, ctx).proposte).toHaveLength(0)
    }
  })

  it('il catalogo dei generi di quest\'area è uno solo', () => {
    expect(GENERI).toEqual(['proposal.configMissingLabels'])
    expect(SOGLIE_ANALISTA.proposteMassime).toBeLessThanOrEqual(2)
  })
})
