import i18n from '@/i18n/i18n'

/**
 * L'etichetta di un campo, di una relazione o di un TIPO del metamodello,
 * nella lingua di chi guarda.
 *
 * I tipi sono arrivati il 20 set 2026, dal giro nel browser: la pagina
 * Anomalie mostrava «businessapplication» e cinque pagine traducevano i sei
 * tipi «storici» con una tabella cablata, mentre la CMDB mostrava l'inglese
 * del nodo. Il meccanismo per dire la stessa cosa dappertutto c'era già —
 * questo — e ai tipi non era applicato.
 *
 * I tipi spediti portano l'etichetta INGLESE nel nodo (migrazione
 * `20260922_1020`). Finché l'etichetta è ancora quella spedita — cioè uguale
 * all'inglese della chiave `metamodel.shipped.<kind>.<name>` — la si mostra
 * tradotta; un'etichetta rinominata dal cliente è sua e resta com'è, in
 * qualunque lingua. L'elenco dei valori spediti è l'inglese dei locale: non
 * c'è una seconda copia da tenere allineata.
 */
export function shippedLabel(kind: 'field' | 'relation' | 'type', name: string, label: string | null | undefined): string {
  const current = label || name
  const key = `metamodel.shipped.${kind}.${name}`
  if (!i18n.exists(key, { lng: 'en' })) return current
  if (i18n.t(key, { lng: 'en' }) !== current) return current
  return i18n.t(key)
}
