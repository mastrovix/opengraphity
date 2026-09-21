/**
 * Etichette di passi e transizioni nella lingua di chi guarda. Giro nel browser
 * del 14 set 2026 (#22): i workflow spediti mostravano «Nuovo», «Prendi in
 * carico» con l'interfaccia inglese. L'API manda `label` (base) e `labels`
 * (le traduzioni delle etichette spedite); qui si sceglie, come fa il
 * Dizionario per i valori. Un'etichetta scritta dal cliente non ha traduzioni:
 * resta la sua.
 */
import i18n from '@/i18n/i18n'

export interface LocalizedLabel { language: string; label: string }

/** L'etichetta nella lingua attiva, altrimenti quella di base. */
export function localizedLabel(item: { label: string; labels?: readonly LocalizedLabel[] | null }): string {
  const language = i18n.resolvedLanguage ?? i18n.language
  return (language && item.labels?.find((l) => l.language === language)?.label) || item.label
}

/** Lo stesso oggetto con `label` già nella lingua attiva: per le liste di transizioni. */
export function withLocalizedLabel<T extends { label: string; labels?: readonly LocalizedLabel[] | null }>(item: T): T {
  return { ...item, label: localizedLabel(item) }
}

/** Il frammento da chiedere accanto a `label`. */
export const LABELS_SELECTION = 'labels { language label }'
