/**
 * LE AZIONI DELL'AIUTO ALLA CONFIGURAZIONE (20 set 2026, ondata 6).
 *
 * Qui il modello non propone di leggere: propone di SCRIVERE del testo che le
 * persone leggeranno sullo schermo — le etichette dei valori di un
 * vocabolario. È la cosa più invasiva di tutto il programma, e per questo ha
 * tre regole invece di una.
 *
 * ## 1. Non si sovrascrive MAI quello che ha scritto una persona
 * È la regola che conta più di tutte. Un vocabolario può avere metà etichette
 * fatte a mano e metà mancanti: l'azione riempie i buchi e lascia stare il
 * resto, valore per valore e lingua per lingua. Se anche il modello
 * proponesse una traduzione per un valore già tradotto, quella proposta viene
 * SCARTATA — non «vinta dall'esistente», scartata, perché una proposta che
 * chiede di riscrivere il lavoro di qualcuno è una proposta sbagliata e va
 * contata come tale.
 *
 * ## 2. Si riparte dallo stato di ADESSO, non da quello di ieri sera
 * Fra la notte in cui la proposta è nata e il momento in cui qualcuno la
 * accetta possono passare giorni, e in mezzo una persona può aver scritto
 * proprio quelle etichette. Quindi l'azione rilegge il vocabolario al momento
 * dell'esecuzione e riapplica la regola 1 su quello che trova. Una proposta
 * che al momento dell'esecuzione non ha più niente da riempire non fa niente
 * e lo dice.
 *
 * ## 3. Si disfa per intero
 * `undoState` porta il JSON di `value_labels` com'era PRIMA — `null`
 * compreso, che è lo stato più comune. Disfare rimette quello, non «toglie le
 * etichette che sembrano del modello».
 */
import { getSession } from '@opengraphity/neo4j'
import { NotFoundError, ValidationError } from './errors.js'
import {
  LINGUE, parseValueLabels, serializeValueLabels,
  type EnumValueLabels, type Lingua,
} from './enumValueLabels.js'

/** Quanto può essere lunga un'etichetta. Più di così non è un'etichetta, è una frase. */
export const MAX_ETICHETTA = 60

export interface EtichetteProposte {
  /** Il vocabolario, per nome. */
  vocabulary: string
  /** valore → lingua → etichetta. Solo quelle che mancavano. */
  labels: Record<string, Partial<Record<Lingua, string>>>
}

/**
 * Le etichette che MANCANO davvero, date quelle che ci sono.
 *
 * Pura ed esportata: è il cuore della regola 1, e deve poter essere provata
 * senza database. Restituisce, per ogni valore, le lingue scoperte.
 */
export function etichetteMancanti(
  values: readonly string[], esistenti: EnumValueLabels,
): Record<string, Lingua[]> {
  const out: Record<string, Lingua[]> = {}
  for (const v of values) {
    const mancano = LINGUE.filter((l) => {
      const testo = esistenti[v]?.[l]
      return typeof testo !== 'string' || testo.trim() === ''
    })
    if (mancano.length > 0) out[v] = mancano
  }
  return out
}

/**
 * Tiene della proposta del modello solo ciò che riempie un buco VERO, e dice
 * che cosa ha scartato.
 *
 * Gli scarti non sono un dettaglio da inghiottire: sono la misura di quanto
 * la proposta si è allontanata dallo stato reale nel frattempo, e finiscono
 * nei dettagli della voce di Audit.
 */
export function soloIBuchi(
  proposte: Record<string, Partial<Record<Lingua, string>>>,
  mancanti: Record<string, Lingua[]>,
): { tenute: Record<string, Partial<Record<Lingua, string>>>; scartate: string[] } {
  const tenute: Record<string, Partial<Record<Lingua, string>>> = {}
  const scartate: string[] = []
  for (const [valore, perLingua] of Object.entries(proposte)) {
    const buchi = mancanti[valore]
    if (!buchi) { scartate.push(`${valore}: nothing missing`); continue }
    for (const [lingua, testo] of Object.entries(perLingua)) {
      if (!(LINGUE as readonly string[]).includes(lingua)) { scartate.push(`${valore}/${lingua}: unknown language`); continue }
      if (!buchi.includes(lingua as Lingua)) { scartate.push(`${valore}/${lingua}: already written`); continue }
      const pulito = String(testo ?? '').replace(/\s+/g, ' ').trim()
      if (pulito === '') { scartate.push(`${valore}/${lingua}: empty`); continue }
      if (pulito.length > MAX_ETICHETTA) { scartate.push(`${valore}/${lingua}: too long`); continue }
      tenute[valore] = { ...tenute[valore], [lingua]: pulito }
    }
  }
  return { tenute, scartate }
}

/** Fonde le etichette nuove con quelle che c'erano, senza toccare le esistenti. */
export function fondiEtichette(
  esistenti: EnumValueLabels, nuove: Record<string, Partial<Record<Lingua, string>>>,
): EnumValueLabels {
  const out: Record<string, Partial<Record<Lingua, string>>> = {}
  for (const [v, perLingua] of Object.entries(esistenti)) out[v] = { ...perLingua }
  for (const [v, perLingua] of Object.entries(nuove)) out[v] = { ...out[v], ...perLingua }
  return out
}

interface RigaVocabolario { values: string[]; raw: unknown }

/**
 * L'azione. `params` arriva dalla proposta e porta il vocabolario e le
 * etichette che il modello aveva scritto.
 */
export async function riempiEtichette(
  tenantId: string, params: Record<string, unknown>,
): Promise<{ details: Record<string, unknown>; undoState: Record<string, unknown> | null }> {
  const vocabulary = String(params['vocabulary'] ?? '')
  const proposte = (params['labels'] ?? {}) as Record<string, Partial<Record<Lingua, string>>>
  if (vocabulary === '') {
    throw new ValidationError('The proposal does not say which dictionary', { key: 'errors.proposal.labelsVocabulary', params: {} })
  }

  const session = getSession(undefined, 'WRITE')
  try {
    const letto = await session.run(`
      MATCH (e:EnumTypeDefinition {tenant_id: $tenantId, name: $vocabulary})
      RETURN e.values AS values, e.value_labels AS raw
    `, { tenantId, vocabulary })
    const riga = letto.records[0]
    if (!riga) throw new NotFoundError('EnumTypeDefinition', `${tenantId}/${vocabulary}`)
    const dati: RigaVocabolario = {
      values: (riga.get('values') as string[] | null) ?? [],
      raw: riga.get('raw'),
    }

    const { labels: esistenti, error } = parseValueLabels(dati.raw)
    if (error) {
      // Un documento illeggibile non si «ripara» scrivendoci sopra: lo si
      // dice, e qualcuno lo guarda. Sovrascriverlo perderebbe quello che
      // c'era dentro senza che nessuno lo sappia.
      throw new ValidationError(
        `The labels of "${vocabulary}" cannot be read (${error}): they must be fixed by hand before anything writes to them`,
        { key: 'errors.proposal.labelsUnreadable', params: { vocabulary } },
      )
    }

    /* Regola 2: si guarda lo stato di ADESSO, non quello di quando la proposta è nata. */
    const mancanti = etichetteMancanti(dati.values, esistenti)
    const { tenute, scartate } = soloIBuchi(proposte, mancanti)
    const quante = Object.values(tenute).reduce((n, v) => n + Object.keys(v).length, 0)
    if (quante === 0) {
      /*
       * Niente da fare NON è un errore: è quello che succede quando fra la
       * notte e l'accettazione qualcuno ha scritto le etichette a mano. Si
       * torna dicendolo, e `undoState: null` toglie il bottone «disfa»,
       * perché non c'è niente da disfare.
       */
      return { details: { vocabulary, written: 0, discarded: scartate }, undoState: null }
    }

    const fuse = fondiEtichette(esistenti, tenute)
    await session.run(`
      MATCH (e:EnumTypeDefinition {tenant_id: $tenantId, name: $vocabulary})
      SET e.value_labels = $labels, e.updated_at = $now
    `, { tenantId, vocabulary, labels: serializeValueLabels(fuse), now: new Date().toISOString() })

    return {
      details: { vocabulary, written: quante, values: Object.keys(tenute), discarded: scartate },
      /* Regola 3: si rimette quello che c'era, `null` compreso. */
      undoState: { vocabulary, precedente: typeof dati.raw === 'string' ? dati.raw : null },
    }
  } finally {
    await session.close()
  }
}

/** Disfare = rimettere il JSON di prima, qualunque fosse. */
export async function ripristinaEtichette(
  tenantId: string, undoState: Record<string, unknown>,
): Promise<void> {
  const vocabulary = String(undoState['vocabulary'] ?? '')
  if (vocabulary === '') return
  const precedente = undoState['precedente']
  const session = getSession(undefined, 'WRITE')
  try {
    await session.run(`
      MATCH (e:EnumTypeDefinition {tenant_id: $tenantId, name: $vocabulary})
      SET e.value_labels = $precedente, e.updated_at = $now
    `, { tenantId, vocabulary, precedente: typeof precedente === 'string' ? precedente : null, now: new Date().toISOString() })
  } finally {
    await session.close()
  }
}
