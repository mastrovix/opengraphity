/**
 * L'elenco del Dizionario: un vocabolario per nome, quello che vale per il cliente.
 *
 * Giro UI del 15 set 2026 · U-17: dopo «Personalizza» l'elenco mostrava due
 * righe «Impact», la copia del cliente e l'originale spedito, e chi apriva non
 * sapeva quale stava modificando. In lettura vince la copia (lo stesso ordine
 * di `DomainVocabularyContext`), quindi l'originale si nasconde e la copia dice
 * da dove viene. Se la copia si cancella, l'originale torna nell'elenco.
 */
export interface DictionaryRow { id: string; name: string; isShipped: boolean }

export type DictionaryListRow<T extends DictionaryRow> = T & {
  /** Copia del cliente di un vocabolario spedito col prodotto. */
  customizedFromShipped: boolean
}

export function dictionaryList<T extends DictionaryRow>(rows: readonly T[]): DictionaryListRow<T>[] {
  const ownNames     = new Set(rows.filter((r) => !r.isShipped).map((r) => r.name))
  const shippedNames = new Set(rows.filter((r) => r.isShipped).map((r) => r.name))
  return rows
    .filter((r) => !(r.isShipped && ownNames.has(r.name)))
    .map((r) => ({ ...r, customizedFromShipped: !r.isShipped && shippedNames.has(r.name) }))
}
