/**
 * Le traduzioni spedite di un passo o di una transizione quando il cliente ne
 * cambia l'etichetta (secondo giro UI del 15 set 2026 · V-5).
 *
 * Un'etichetta cambiata nel disegnatore è del cliente: le traduzioni spedite
 * non valgono più (#22), e `labels` si svuota. Ma rinominare «On Hold» in «On
 * Hold (giro)» e poi rimetterlo «On Hold» perdeva per sempre «In Attesa»:
 * l'etichetta tornava quella spedita, la traduzione no, e nessuno lo diceva.
 *
 * Qui, al primo cambio, l'etichetta d'origine e le sue traduzioni si mettono da
 * parte (`labels_origin_label`, `labels_origin`); se l'etichetta torna quella
 * d'origine, le traduzioni tornano con lei e la copia si toglie.
 *
 * Le clausole `SET` sono separate di proposito: ognuna legge i valori lasciati
 * dalla precedente, nell'ordine scritto.
 */

/** Le clausole Cypher che aggiornano `labels` di `alias` prima di scrivere `newLabel` (un'espressione Cypher). */
export function labelTranslationsCypher(alias: string, newLabel: string): string {
  const a = alias
  const changing = `${a}.label <> ${newLabel}`
  return [
    `SET ${a}.labels_origin_label = CASE WHEN ${changing} AND ${a}.labels IS NOT NULL AND ${a}.labels_origin IS NULL THEN ${a}.label ELSE ${a}.labels_origin_label END`,
    `SET ${a}.labels_origin = CASE WHEN ${changing} AND ${a}.labels IS NOT NULL AND ${a}.labels_origin IS NULL THEN ${a}.labels ELSE ${a}.labels_origin END`,
    `SET ${a}.labels = CASE WHEN ${a}.label = ${newLabel} THEN ${a}.labels WHEN ${a}.labels_origin_label = ${newLabel} THEN ${a}.labels_origin ELSE null END`,
    `SET ${a}.labels_origin = CASE WHEN ${a}.labels_origin_label = ${newLabel} THEN null ELSE ${a}.labels_origin END`,
    `SET ${a}.labels_origin_label = CASE WHEN ${a}.labels_origin_label = ${newLabel} THEN null ELSE ${a}.labels_origin_label END`,
  ].join('\n        ')
}
