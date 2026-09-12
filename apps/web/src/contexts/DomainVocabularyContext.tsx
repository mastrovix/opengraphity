/**
 * I valori ammessi dei vocabolari **di questo cliente**, nel browser
 * (ondata 7 · D-15).
 *
 * Serve a distinguere, in una palette, «valore del vocabolario senza stile»
 * (normale: neutro) da «valore fuori dal vocabolario» (errore: rosso) — vedi
 * `lib/domainStyle.ts`. Senza questo, qualunque valore aggiunto dal cliente
 * sembrava un difetto: pastiglia rossa piena e `console.error` a ogni riga.
 *
 * ## Perché un contesto e non un hook per componente
 * Chi ne ha bisogno sono le pastiglie, e una tabella di incident ne monta
 * cinquanta: cinquanta `useQuery` per una tabella che cambia una volta al mese
 * sarebbero cinquanta osservatori. Il contesto fa UNA query all'avvio, come
 * `MetamodelContext`.
 *
 * ## `null` non è «lista vuota»
 * `valuesOf` restituisce `null` quando non lo sappiamo: query in corso, in
 * errore, provider non montato (un test che rende la pastiglia da sola), o
 * nessun vocabolario con quel nome. «Vuoto» vorrebbe dire «nessun valore è
 * ammesso», che è una cosa diversa — e chi lo consuma deve trattare i due casi
 * in modo diverso.
 *
 * Precedenza, la stessa dell'API (`domainVocabulary`, ondata 1): il
 * vocabolario del tenant vince su quello spedito col prodotto con lo stesso
 * nome. Qui la si applica su `isShipped`.
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { useQuery } from '@apollo/client/react'
import { GET_ENUM_TYPES } from '@/graphql/queries'

interface EnumTypeRow { name: string; values: string[]; isShipped: boolean }

export interface DomainVocabularies {
  /** I valori ammessi, o `null` se non si conoscono (vedi sopra: non è «vuoto»). */
  valuesOf: (name: string) => readonly string[] | null
  loading:  boolean
  error:    string | null
}

/** Esportato per i test, che iniettano il vocabolario del cliente senza query. */
export const DomainVocabularyContext = createContext<DomainVocabularies>({
  valuesOf: () => null,
  loading:  false,
  error:    null,
})

export function DomainVocabularyProvider({ children }: { children: ReactNode }) {
  const { data, loading, error } = useQuery<{ enumTypes: EnumTypeRow[] | null }>(GET_ENUM_TYPES, { fetchPolicy: 'cache-first' })
  const value = useMemo<DomainVocabularies>(() => {
    // Due mappe e una precedenza sola: il vocabolario del cliente vince, e
    // quello spedito resta la seconda scelta.
    const own     = new Map<string, readonly string[]>()
    const shipped = new Map<string, readonly string[]>()
    for (const row of data?.enumTypes ?? []) {
      (row.isShipped ? shipped : own).set(row.name, row.values)
    }
    const ready = !loading && !error
    return {
      valuesOf: (name: string) => (ready ? (own.get(name) ?? shipped.get(name) ?? null) : null),
      loading,
      error: error ? error.message : null,
    }
  }, [data, loading, error])
  return <DomainVocabularyContext.Provider value={value}>{children}</DomainVocabularyContext.Provider>
}

export function useDomainVocabularies(): DomainVocabularies {
  return useContext(DomainVocabularyContext)
}
