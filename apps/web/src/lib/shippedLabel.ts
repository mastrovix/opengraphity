import i18n from '@/i18n/i18n'
import { shippedLabelIn } from '@opengraphity/types'

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
 * `20260922_1020`). Finché l'etichetta è ancora quella spedita la si mostra
 * tradotta; un'etichetta rinominata dal cliente è sua e resta com'è, in
 * qualunque lingua.
 *
 * ## Dove stanno le traduzioni (20 set 2026)
 * In `packages/types` (`SHIPPED_LABELS`), non più nei locale del web: le
 * stesse etichette servono al SERVER, che compone le intestazioni delle
 * tabelle dei report per lo schermo, per il PDF e per l'Excel, e nei locale
 * non poteva leggerle — la stessa colonna si chiamava «Titolo» nel
 * costruttore e «TITLE» nel risultato.
 */
export function shippedLabel(kind: 'field' | 'relation' | 'type', name: string, label: string | null | undefined): string {
  return shippedLabelIn(kind, name, label, i18n.resolvedLanguage ?? i18n.language)
}
