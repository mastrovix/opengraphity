/**
 * Lo stile di un valore di vocabolario, col colore che il cliente gli ha dato
 * nel Dizionario (revisione del 14 set 2026 · F9).
 *
 * Sostituisce le tabelle per valore che vivevano nelle pagine
 * (`PRIORITY_COLOR` in cinque copie, `PRIORITY_DOT`, `SEVERITY_STYLES`…), che
 * fra l'altro non erano d'accordo fra loro: `high` era arancione in una pagina
 * e blu in un'altra.
 */
import { useCallback } from 'react'
import { useDomainVocabularies } from '@/contexts/DomainVocabularyContext'
import { vocabularyValueStyle, type ValueStyle } from '@/lib/domainStyle'

export function useValueStyle(): (vocabulary: string, value: string) => ValueStyle {
  const { valuesOf, colorOf } = useDomainVocabularies()
  return useCallback(
    (vocabulary: string, value: string) => vocabularyValueStyle(vocabulary, value, valuesOf(vocabulary), colorOf(vocabulary, value)),
    [valuesOf, colorOf],
  )
}
