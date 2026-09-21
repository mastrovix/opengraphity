/**
 * QUANDO DUE FINESTRE DI RILASCIO SI PESTANO I PIEDI — una regola, un posto
 * (18 set 2026).
 *
 * La sovrapposizione delle finestre nasce nel calendario delle change, dove
 * serviva a colorare le barre. Poi è servita anche sul DETTAGLIO di una change
 * («quali altre change toccano i miei CI mentre rilascio?»), e quella domanda
 * si risponde nel server: il dettaglio non può scaricarsi i piani di tutto il
 * tenant per confrontarli nel browser.
 *
 * Due implementazioni della stessa frase — una nel web per dipingere, una
 * nell'API per rispondere — sarebbero divergute al primo dubbio: un rilascio
 * che finisce nell'istante in cui l'altro comincia è un conflitto? Qui la
 * risposta è NO, ed è scritta una volta: due finestre si sovrappongono se si
 * toccano per più di un istante. Un piano che dice «rilascio fino alle 22:00»
 * e un altro «dalle 22:00» sono consecutivi, ed è esattamente come li legge
 * chi li ha scritti.
 *
 * Puro e senza ripieghi: una data non parsabile non «non si sovrappone per
 * sicurezza» — non è confrontabile, e chi chiama deve saperlo (`finestraValida`).
 */

/** Una finestra del piano: due istanti ISO 8601 con offset esplicito. */
export interface FinestraDiRilascio {
  start: string
  end:   string
}

/** Vero quando entrambe le date si leggono e l'intervallo non è a rovescio. */
export function finestraValida(f: FinestraDiRilascio | null | undefined): boolean {
  if (!f) return false
  const da = Date.parse(f.start)
  const a  = Date.parse(f.end)
  return !Number.isNaN(da) && !Number.isNaN(a) && da < a
}

/**
 * LA REGOLA, sui millisecondi: due intervalli si sovrappongono se si toccano
 * per più di un istante.
 *
 * Esiste in due forme — questa e `finestreSiSovrappongono` sulle date ISO —
 * perché i chiamanti sono due: le corsie del calendario confrontano numeri
 * già convertiti, l'API confronta finestre appena lette dal grafo. Due forme
 * dello STESSO confronto in un file solo; due file avrebbero dato due
 * risposte.
 */
export function intervalliSiSovrappongono(aDa: number, aA: number, bDa: number, bA: number): boolean {
  return aDa < bA && bDa < aA
}

/**
 * Due finestre si sovrappongono se si toccano per più di un istante.
 * Una finestra non valida non si sovrappone a niente: il chiamante che vuole
 * saperlo usa `finestraValida` e lo dice a chi guarda.
 */
export function finestreSiSovrappongono(a: FinestraDiRilascio, b: FinestraDiRilascio): boolean {
  if (!finestraValida(a) || !finestraValida(b)) return false
  return intervalliSiSovrappongono(Date.parse(a.start), Date.parse(a.end), Date.parse(b.start), Date.parse(b.end))
}

/** La parte in comune di due finestre, `null` se non si sovrappongono. */
export function sovrapposizione(a: FinestraDiRilascio, b: FinestraDiRilascio): FinestraDiRilascio | null {
  if (!finestreSiSovrappongono(a, b)) return null
  const da = Math.max(Date.parse(a.start), Date.parse(b.start))
  const al = Math.min(Date.parse(a.end),   Date.parse(b.end))
  return { start: new Date(da).toISOString(), end: new Date(al).toISOString() }
}
