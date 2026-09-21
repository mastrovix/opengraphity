/**
 * IL TETTO DI SPESA DELL'AI (20 set 2026, rimedio c).
 *
 * ## Il buco
 * `aiCostLedger.ts` dichiarava, in testa: «il registro serve a SAPERE, non a
 * bloccare… il tetto si decide quando il registro avrà un mese di dati».
 * Era una decisione ragionevole il giorno in cui l'ho scritta, e la revisione
 * adversarial ha mostrato che intanto restava aperta questa:
 *
 *  - `runProposalAnalysis` esegue TRE chiamate al modello dentro la richiesta
 *    HTTP (`max_tokens: 4000`, `thinking: adaptive`);
 *  - l'unico freno è `MUTATION_LIMITS.runProposalAnalysis: 5`, che è **per
 *    tenant**, **in memoria** e **per replica** — con tre repliche sono 15 al
 *    minuto per cliente;
 *  - la chiave Anthropic è **una sola per tutta la piattaforma**.
 *
 * Quindi un cliente solo poteva prosciugare il budget di triage, assistente e
 * report di tutti gli altri. Non serviva un mese di dati per sapere che
 * «illimitato» non è il numero giusto.
 *
 * ## Che cosa copre, detto invece che sottinteso
 * Solo le funzioni che passano dal registro: i tre analisti autonomi
 * (`platformSelfAnalysis`, `dailyWorkAnalysis`, `configurationAssist`). Sono
 * le uniche che spendono SENZA che nessuno clicchi, più l'unica dietro un
 * bottone che chiama il modello tre volte.
 *
 * Le altre otto funzioni AI non sono ancora misurate per cliente
 * (`registraCosto` ha tre chiamanti su undici punti che chiamano il modello),
 * quindi non sono nemmeno limitate. È un limite REALE di questo tetto e sta
 * scritto qui invece che essere scoperto da qualcun altro: il passo dopo è
 * portare il registro sugli altri otto punti.
 *
 * ## Due tetti, perché i rischi sono due
 * Quello per cliente impedisce che uno solo mangi tutto. Quello di
 * piattaforma impedisce che dieci clienti sotto la loro soglia facciano
 * insieme un conto che nessuno ha approvato. Servono entrambi: nessuno dei
 * due implica l'altro.
 *
 * ## Fallisce CHIUSO, e lo dice
 * Se il registro non si può leggere non si indovina: non si chiama il
 * modello. Una spesa non misurabile è esattamente quella che non si vuole
 * autorizzare, ed è la stessa regola del varco dell'archivio (rimedio a).
 */
import { getSession, toNumber } from '@opengraphity/neo4j'
import { logger } from './logger.js'
import { consumoDi, meseDi } from './aiCostLedger.js'
import type { AIFeature } from './aiSettings.js'

const log = logger.child({ module: 'ai-budget' })

/**
 * Le funzioni che il tetto governa: quelle che il registro misura.
 *
 * Elencate e non dedotte, così aggiungere un analista senza pensare al costo
 * è un gesto che si vede.
 */
export const FUNZIONI_CON_TETTO: ReadonlySet<AIFeature> =
  new Set<AIFeature>(['platformSelfAnalysis', 'dailyWorkAnalysis', 'configurationAssist'])

/**
 * Il tetto mensile di gettoni per un cliente.
 *
 * Default 2.000.000: la misura vera del 20 set 2026 è ~3.000 gettoni a
 * chiamata e 3 chiamate a giro notturno, cioè ~280.000 gettoni l'anno per
 * cliente. Due milioni al mese lascia spazio a un uso del bottone molto più
 * intenso del previsto e ferma comunque un ciclo. Un valore malformato è un
 * errore di configurazione, non un default silenzioso.
 */
export function leggiTettoDelCliente(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  return intero(env['AI_MONTHLY_TOKEN_BUDGET_TENANT'], 'AI_MONTHLY_TOKEN_BUDGET_TENANT', 2_000_000)
}

/**
 * Il tetto mensile di gettoni di tutta la piattaforma.
 *
 * Default 20.000.000, cioè dieci clienti al loro tetto. Non è la somma dei
 * tetti dei clienti per costruzione: è il numero che il gestore della
 * piattaforma è disposto a spendere, e resta suo anche quando i clienti
 * diventano cinquanta.
 */
export function leggiTettoDellaPiattaforma(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  return intero(env['AI_MONTHLY_TOKEN_BUDGET_PLATFORM'], 'AI_MONTHLY_TOKEN_BUDGET_PLATFORM', 20_000_000)
}

function intero(grezzo: string | undefined, nome: string, predefinito: number): number {
  if (grezzo === undefined || grezzo === '') return predefinito
  const n = Number(grezzo)
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Environment variable ${nome} must be an integer >= 1 (got "${grezzo}")`)
  }
  return n
}

/** I gettoni di una riga del registro. Input e output insieme: è quello che si paga. */
export function gettoniDi(r: { input: number; output: number; cacheRead: number; cacheWrite: number }): number {
  return r.input + r.output + r.cacheRead + r.cacheWrite
}

export interface Verdetto {
  /** `true` quando si può chiamare il modello. */
  consentito:  boolean
  /** Quale tetto ha fermato la chiamata. `null` se è passata. */
  tetto:       'tenant' | 'platform' | 'unreadable' | null
  usati:       number
  limite:      number
}

/**
 * Si può spendere?
 *
 * Il conto è sul mese in corso e comprende TUTTE le funzioni con tetto, non
 * solo quella che sta per partire: il budget è del cliente, non della
 * funzione. Il consumo della chiamata che sta per partire non si conosce
 * ancora — quindi il tetto morde al giro dopo quello che lo supera, ed è il
 * comportamento giusto: fermare a metà una chiamata già pagata non
 * restituirebbe niente.
 */
export async function puoSpendere(
  tenantId: string,
  feature: AIFeature,
  leggiConsumo: typeof consumoDi = consumoDi,
): Promise<Verdetto> {
  if (!FUNZIONI_CON_TETTO.has(feature)) {
    return { consentito: true, tetto: null, usati: 0, limite: 0 }
  }
  const mese = meseDi()
  const tettoCliente = leggiTettoDelCliente()

  let righe
  try {
    righe = await leggiConsumo(tenantId, 2)
  } catch (err) {
    /*
     * Chiuso. Una spesa che non si può misurare è quella che non si vuole
     * autorizzare — e se il registro è irraggiungibile, `registraCosto`
     * fallirà anche dopo, quindi quella chiamata non verrebbe mai contata.
     */
    log.error(
      { tenantId, feature, err: err instanceof Error ? err.message : String(err) },
      'ai-budget: ledger unreadable, spending refused',
    )
    return { consentito: false, tetto: 'unreadable', usati: 0, limite: tettoCliente }
  }

  const delMese = righe.filter((r) => r.month === mese && FUNZIONI_CON_TETTO.has(r.feature as AIFeature))
  const usati = delMese.reduce((s, r) => s + gettoniDi(r), 0)
  if (usati >= tettoCliente) {
    log.warn({ tenantId, feature, usati, limite: tettoCliente }, 'ai-budget: tenant monthly cap reached')
    return { consentito: false, tetto: 'tenant', usati, limite: tettoCliente }
  }

  const tettoPiattaforma = leggiTettoDellaPiattaforma()
  let dellaPiattaforma: number
  try {
    dellaPiattaforma = await totaleDellaPiattaforma(mese)
  } catch (err) {
    log.error(
      { feature, err: err instanceof Error ? err.message : String(err) },
      'ai-budget: platform total unreadable, spending refused',
    )
    return { consentito: false, tetto: 'unreadable', usati, limite: tettoPiattaforma }
  }
  if (dellaPiattaforma >= tettoPiattaforma) {
    log.warn({ feature, usati: dellaPiattaforma, limite: tettoPiattaforma }, 'ai-budget: platform monthly cap reached')
    return { consentito: false, tetto: 'platform', usati: dellaPiattaforma, limite: tettoPiattaforma }
  }

  return { consentito: true, tetto: null, usati, limite: tettoCliente }
}

/** I gettoni spesi da TUTTI i clienti nel mese, sulle sole funzioni con tetto. */
export async function totaleDellaPiattaforma(mese: string = meseDi()): Promise<number> {
  const session = getSession()
  try {
    const r = await session.run(TOTALE_PIATTAFORMA_CYPHER, { mese, funzioni: [...FUNZIONI_CON_TETTO] })
    return toNumber(r.records[0]?.get('gettoni') ?? 0)
  } finally {
    await session.close()
  }
}

/** La query del totale di piattaforma: un numero solo, tutti i clienti, mese corrente. */
export const TOTALE_PIATTAFORMA_CYPHER = `
  // tenant-ok: il tetto di piattaforma è la somma di TUTTI i clienti, ed è
  // il suo scopo. Lo legge solo il gestore della piattaforma, e restituisce
  // un numero, non righe di nessuno.
  MATCH (u:AIUsage {month: $mese})
  WHERE u.feature IN $funzioni
  RETURN sum(u.input + u.output + u.cache_read + u.cache_write) AS gettoni
`
