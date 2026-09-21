/**
 * UN SOLO POSTO DA CUI SI PARLA AL MODELLO (revisione AI, ondata 8).
 *
 * ## Il difetto
 * Sei servizi — triage, assistente, post-incident, l'agente dei report e i due
 * progettisti — costruivano ognuno il proprio `new Anthropic()`, con la
 * propria copia del controllo della chiave e della lettura della risposta. Le
 * copie erano DIVERSE, ed è così che si scopre a cosa serve un posto solo:
 *
 * - `stop_reason === 'max_tokens'` era gestito nei due progettisti (l'ho
 *   aggiunto ieri) e NON in triage né in post-incident: là una risposta
 *   tagliata a metà arrivava a `JSON.parse`, che diceva «la risposta non è
 *   leggibile» — una diagnosi sbagliata, che manda a cercare il difetto nel
 *   posto sbagliato;
 * - nessuna delle sei chiamate era CONTATA. Quanto costa l'AI a un cliente,
 *   quante chiamate falliscono, quanto del prompt viene riletto dalla cache:
 *   niente di tutto questo si poteva sapere, e una funzione che costa e non si
 *   misura è una funzione che si scopre dalla fattura.
 *
 * ## La regola
 * Il client si chiede a `getAnthropic()` e la risposta si legge con
 * `leggiJSONDalModello()`. Le metriche si incrementano qui dentro, una volta,
 * per tutti: chi aggiunge la settima funzione AI le ha senza saperlo.
 *
 * ## La cache che non cacheava
 * `cache_control: { type: 'ephemeral' }` stava sul prompt di sistema, che è
 * lungo ~600 token: sotto il minimo cacheabile, quindi non cacheava NIENTE.
 * La parte grossa e stabile di una chiamata è il CONTESTO del cliente (il
 * metamodello, il catalogo dei campi, i vocabolari), che però viaggiava nel
 * messaggio dell'utente insieme alla richiesta — cioè attaccato all'unica cosa
 * che cambia a ogni chiamata, il che rende la cache impossibile per
 * costruzione. `bloccoDiContesto()` lo mette dove va: in coda ai blocchi di
 * sistema, con il punto di cache dopo, e nel messaggio resta la sola frase
 * dell'utente. Da lì in poi il prefisso è identico fra due chiamate dello
 * stesso cliente e la cache può lavorare.
 */
import Anthropic from '@anthropic-ai/sdk'
import { GraphQLError } from 'graphql'
import { config } from './config.js'
import { logger } from './logger.js'
import type { AIFeature } from './aiSettings.js'
import { aiCallsTotal, aiCallDurationSeconds, aiDiscardsTotal, aiTokensTotal } from '../middleware/metrics.js'

const log = logger.child({ module: 'ai-client' })

let _client: Anthropic | null = null

/**
 * Il client, creato una volta sola. La chiave si controlla QUI: chiamarlo
 * prima di leggere il grafo è la regola di fail-fast di casa (leggere tutto il
 * catalogo per poi dire «non configurato» si paga e non serve a niente).
 */
export function getAnthropic(): Anthropic {
  if (!config.anthropicApiKey) {
    throw new GraphQLError('AI is not configured on this platform: ANTHROPIC_API_KEY missing', {
      extensions: { code: 'FAILED_PRECONDITION', i18n: { key: 'errors.ai.notConfigured' } },
    })
  }
  _client ??= new Anthropic()
  return _client
}

/** Solo per i test: scorda il client, così un doppio `getAnthropic()` si vede. */
export function resetAnthropicForTests(): void {
  _client = null
}

/**
 * Il contesto del cliente come ultimo blocco di sistema, con il punto di
 * cache. Va messo DOPO i blocchi che cambiano poco (prompt di sistema, lingua)
 * e prima del messaggio dell'utente, che resta la sola frase.
 */
export function bloccoDiContesto(contesto: unknown): Anthropic.TextBlockParam {
  return {
    type: 'text',
    text: JSON.stringify(contesto, null, 1),
    cache_control: { type: 'ephemeral' },
  }
}

export interface ChiaviDiErrore {
  /** Chiave i18n per «la risposta è arrivata tagliata». */
  readonly troncata: string
  /** Chiave i18n per «la risposta non è JSON». */
  readonly illeggibile: string
}

/**
 * Legge il JSON di una risposta, alzando l'errore GIUSTO per ogni modo in cui
 * può andare storta. `feature` finisce nelle metriche e nei log.
 */
export function leggiJSONDalModello(
  response: Anthropic.Message, feature: AIFeature, chiavi: ChiaviDiErrore,
): unknown {
  if (response.stop_reason === 'max_tokens') {
    registraRisposta(feature, 'truncated', response)
    throw new GraphQLError('The model answer was cut off (max_tokens)', {
      extensions: { code: 'INTERNAL_SERVER_ERROR', i18n: { key: chiavi.troncata } },
    })
  }
  if (response.stop_reason === 'refusal') {
    registraRisposta(feature, 'refused', response)
    throw new GraphQLError('The model refused the request', {
      extensions: { code: 'INTERNAL_SERVER_ERROR', i18n: { key: 'errors.ai.modelRefused' } },
    })
  }
  const blocco = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')
  if (!blocco) {
    // Una risposta senza blocco di testo è illeggibile quanto un JSON rotto, e
    // arriva allo stesso utente: stesso errore, non un `Error` nudo che esce
    // come 500 senza niente da leggere.
    registraRisposta(feature, 'unreadable', response)
    throw new GraphQLError(`[${feature}] response without a text block`, {
      extensions: { code: 'INTERNAL_SERVER_ERROR', i18n: { key: chiavi.illeggibile } },
    })
  }
  try {
    const letto: unknown = JSON.parse(blocco.text)
    registraRisposta(feature, 'ok', response)
    return letto
  } catch (err) {
    registraRisposta(feature, 'unreadable', response)
    throw new GraphQLError(`The model answer is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, {
      extensions: { code: 'INTERNAL_SERVER_ERROR', i18n: { key: chiavi.illeggibile } },
    })
  }
}

/**
 * Come sopra, ma per una risposta di TESTO (la bozza delle note di
 * risoluzione). Una nota tagliata a metà non si consegna in silenzio: chi la
 * legge la firmerebbe credendola finita.
 */
export function leggiTestoDalModello(
  response: Anthropic.Message, feature: AIFeature, chiavi: ChiaviDiErrore,
): string {
  if (response.stop_reason === 'max_tokens') {
    registraRisposta(feature, 'truncated', response)
    throw new GraphQLError('The model answer was cut off (max_tokens)', {
      extensions: { code: 'INTERNAL_SERVER_ERROR', i18n: { key: chiavi.troncata } },
    })
  }
  if (response.stop_reason === 'refusal') {
    registraRisposta(feature, 'refused', response)
    throw new GraphQLError('The model refused the request', {
      extensions: { code: 'INTERNAL_SERVER_ERROR', i18n: { key: 'errors.ai.modelRefused' } },
    })
  }
  const testo = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text?.trim()
  if (!testo) {
    registraRisposta(feature, 'unreadable', response)
    throw new GraphQLError('The model returned an empty answer', {
      extensions: { code: 'INTERNAL_SERVER_ERROR', i18n: { key: chiavi.illeggibile } },
    })
  }
  registraRisposta(feature, 'ok', response)
  return testo
}

export type Esito = 'ok' | 'truncated' | 'refused' | 'unreadable' | 'failed'

/**
 * Quel tanto di una risposta che serve per contarla. È strutturale e non
 * `Anthropic.Message` perché l'assistente usa l'anello degli strumenti, che
 * torna un messaggio dei tipi `Beta*`: sono due tipi diversi con lo stesso
 * `usage`, e una metrica non deve costringere a sceglierne uno.
 */
export interface RispostaMisurabile {
  readonly usage: {
    readonly input_tokens: number
    readonly output_tokens: number
    readonly cache_read_input_tokens?: number | null
    readonly cache_creation_input_tokens?: number | null
  }
}

/**
 * I gettoni di UNA risposta, divisi per tipo. `cache_read` sono quelli che la
 * cache ha risparmiato: è il numero che dice se il punto di cache è messo bene.
 */
export function registraRisposta(feature: AIFeature, esito: Esito, response: RispostaMisurabile): void {
  aiCallsTotal.inc({ feature, outcome: esito })
  /*
   * `usage` con il punto di domanda: una metrica non deve MAI far fallire la
   * funzione che misura. Una risposta senza conteggio (un doppio dell'SDK, una
   * forma nuova del provider) vale zero gettoni, non un TypeError in faccia a
   * chi stava chiedendo un triage.
   */
  const u = response.usage as Partial<RispostaMisurabile['usage']> | undefined
  aiTokensTotal.inc({ feature, kind: 'input' }, u?.input_tokens ?? 0)
  aiTokensTotal.inc({ feature, kind: 'output' }, u?.output_tokens ?? 0)
  aiTokensTotal.inc({ feature, kind: 'cache_read' }, u?.cache_read_input_tokens ?? 0)
  aiTokensTotal.inc({ feature, kind: 'cache_write' }, u?.cache_creation_input_tokens ?? 0)
}

/** Una chiamata che non è nemmeno tornata (rete, 429, 500 del provider). */
export function registraChiamataFallita(feature: AIFeature, err: unknown): void {
  aiCallsTotal.inc({ feature, outcome: 'failed' })
  log.warn({ err, feature }, '[ai] call failed')
}

/** Una chiamata riuscita: quanto ha aspettato l'utente. */
export function registraDurata(feature: AIFeature, ms: number): void {
  aiCallDurationSeconds.observe({ feature }, ms / 1000)
}

/**
 * Quanti pezzi della risposta sono stati BUTTATI dal filtro. È la misura della
 * qualità di un progettista: se sale, il prompt non sta più dicendo al modello
 * quello che il prodotto sa accettare.
 */
export function registraScarti(feature: AIFeature, quanti: number): void {
  if (quanti > 0) aiDiscardsTotal.inc({ feature }, quanti)
}
