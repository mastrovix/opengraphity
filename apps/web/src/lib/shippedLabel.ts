import i18n from '@/i18n/i18n'

/**
 * L'etichetta di un campo o di una relazione del metamodello, nella lingua di
 * chi guarda.
 *
 * I tipi spediti portano l'etichetta INGLESE nel nodo (migrazione
 * `20260922_1020`). Finché l'etichetta è ancora quella spedita — cioè uguale
 * all'inglese della chiave `metamodel.shipped.<kind>.<name>` — la si mostra
 * tradotta; un'etichetta rinominata dal cliente è sua e resta com'è, in
 * qualunque lingua. L'elenco dei valori spediti è l'inglese dei locale: non
 * c'è una seconda copia da tenere allineata.
 */
export function shippedLabel(kind: 'field' | 'relation', name: string, label: string | null | undefined): string {
  const current = label || name
  const key = `metamodel.shipped.${kind}.${name}`
  if (!i18n.exists(key, { lng: 'en' })) return current
  if (i18n.t(key, { lng: 'en' }) !== current) return current
  return i18n.t(key)
}
