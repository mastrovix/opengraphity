/**
 * Il motivo di un job fallito, come lo si legge a schermo.
 *
 * Il problema, visto dal proprietario nella pagina Code: un job di
 * `events-maintenance` fallito con Neo4j irraggiungibile mostrava 1606
 * caratteri in cui la stessa frase del driver Neo4j — duecento caratteri,
 * «Failed to connect to server… Caused by: connect ECONNREFUSED …» — era
 * ripetuta CINQUE volte di fila, una per ciascuna delle cinque passate della
 * manutenzione. Illeggibile.
 *
 * La produzione del messaggio è già stata corretta (jobs/eventCorrelateWorker.ts
 * accorpa le passate che condividono la causa), ma quella correzione non
 * raggiunge questo schermo:
 *
 *  - BullMQ SALVA `failedReason` nell'istante del fallimento, quindi ogni job
 *    già fallito conserva per sempre il testo vecchio;
 *  - il messaggio non lo scriviamo solo noi: un errore composto allo stesso
 *    modo può arrivare da una libreria o da una versione precedente.
 *
 * Perciò la ripetizione si scioglie anche in lettura, che è il posto che vale
 * per chiunque guardi la pagina. Nessuna informazione buttata: le etichette
 * restano tutte, elencate davanti alla causa che condividono.
 *
 * Il formato riconosciuto è quello che il prodotto produce:
 * «<etichetta>: <causa>; <etichetta>: <causa>; …», con un eventuale prefisso
 * davanti alla prima («[events-maintenance] events-maintenance: »). Le
 * etichette sono nomi di passata in snake_case — `closed_windows`, `pending`,
 * `gauges` — e questo è ciò che permette di distinguerle dal prefisso, che
 * contiene il nome della coda col trattino. Un testo che non ha questa forma
 * torna indietro identico: qui non si indovina.
 */

/**
 * Il prefisso della prima voce: «[<coda>] <nome del job>: ». Si toglie prima
 * di cercare l'etichetta, e si rimette davanti al risultato.
 *
 * Va riconosciuto per quello che è, non cercando l'etichetta «più a destra»:
 * la prima prova di questa funzione sbagliava proprio qui — dentro
 * «[events-maintenance] events-maintenance: closed_windows: …» leggeva come
 * etichetta il `maintenance` del prefisso, e la prima voce finiva con una
 * causa diversa dalle altre (quindi non accorpata). Cercare l'etichetta più a
 * destra sbaglia in modo opposto: la frase del driver Neo4j contiene
 * «Caused by: connect ECONNREFUSED», e `by` sembra un'etichetta.
 */
const PREFISSO = /^\[[^\]]*\]\s*[A-Za-z0-9_-]+:\s*/

/** `<etichetta>: <causa>`, ancorata all'inizio della voce: l'etichetta è snake_case. */
const VOCE = /^([a-z][a-z0-9_]*): ([\s\S]+)$/

/** Separatore fra due voci: un «; » seguito da un'altra etichetta. */
const FRA_VOCI = /;\s+(?=[a-z][a-z0-9_]*: )/

export function motivoLeggibile(raw: string): string {
  const voci = raw.split(FRA_VOCI)
  if (voci.length < 2) return raw

  const prefisso = PREFISSO.exec(voci[0]!)?.[0] ?? ''
  const perCausa = new Map<string, string[]>()
  for (const [i, voce] of voci.entries()) {
    const m = VOCE.exec(i === 0 ? voce.slice(prefisso.length) : voce)
    // Una voce che non ha la forma attesa: si restituisce il testo originale
    // invece di consegnarne una versione a metà.
    if (!m) return raw
    const causa = m[2]!
    const etichette = perCausa.get(causa)
    if (etichette) etichette.push(m[1]!)
    else perCausa.set(causa, [m[1]!])
  }
  if (perCausa.size === voci.length) return raw // nessuna ripetizione da sciogliere

  const elenco = [...perCausa].map(([causa, etichette]) => `${etichette.join(', ')}: ${causa}`).join('; ')
  return prefisso + elenco
}
