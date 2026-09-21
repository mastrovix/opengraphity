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
import { useTranslation } from 'react-i18next'
import type { ValueColor } from '@opengraphity/types'
import { GET_ENUM_TYPES } from '@/graphql/queries'
import { METAMODEL_FETCH_POLICY } from '@/lib/fetchPolicy'

interface LocalizedLabelRow { language: string; label: string }
interface EnumValueLabelRow { value: string; label: string; labels: LocalizedLabelRow[] }
interface EnumValueColorRow { value: string; color: ValueColor }
interface EnumTypeRow { name: string; label: string; values: string[]; isShipped: boolean; valueLabels: EnumValueLabelRow[]; valueColors: EnumValueColorRow[] }

export interface DomainVocabularies {
  /** I valori ammessi, o `null` se non si conoscono (vedi sopra: non è «vuoto»). */
  valuesOf: (name: string) => readonly string[] | null
  /**
   * L'ETICHETTA con cui si legge un valore (ondata 1): `impact`/`high` → «Alto».
   *
   * Restituisce `null` quando non la conosciamo — query in corso, in errore,
   * provider non montato, vocabolario assente — e chi chiama mostra il valore,
   * che è vero. NON ripiega da sé sul title-case: quel ripiego lo fa già il
   * server, che ha il valore e l'etichetta insieme, e farlo anche qui
   * nasconderebbe la differenza fra «l'etichetta è il valore» e «non so
   * ancora».
   *
   * Un valore fuori vocabolario torna `null`: non gli si inventa un'etichetta.
   */
  labelOf: (name: string, value: string) => string | null
  /**
   * Il COLORE che il Dizionario assegna al valore (revisione del 14 set 2026 ·
   * F9), o `null` se nessuno gliel'ha dato o se non lo sappiamo ancora. Lo
   * stile lo compone `vocabularyValueStyle` (lib/domainStyle.ts).
   */
  colorOf: (name: string, value: string) => ValueColor | null
  /** Valore + etichetta, nell'ordine del vocabolario: per le tendine e i gruppi di bottoni. */
  entriesOf: (name: string) => readonly EnumValueLabelRow[] | null
  /**
   * Il NOME con cui il Dizionario presenta il vocabolario («Impatto» per
   * `impact`), o `null` se non lo sappiamo. Giro UI del 15 set 2026 · U-20: le
   * matrici di dominio intestavano righe e colonne col nome interno.
   */
  vocabularyLabelOf: (name: string) => string | null
  loading:  boolean
  error:    string | null
}

/** Esportato per i test, che iniettano il vocabolario del cliente senza query. */
export const DomainVocabularyContext = createContext<DomainVocabularies>({
  valuesOf:  () => null,
  labelOf:   () => null,
  colorOf:   () => null,
  entriesOf: () => null,
  vocabularyLabelOf: () => null,
  loading:   false,
  error:     null,
})

export function DomainVocabularyProvider({ children }: { children: ReactNode }) {
  /*
    La lingua fa parte della CHIAVE della query: l'API non la conosce (non c'e'
    `Accept-Language` e l'utente non la porta), quindi la manda il client — ed
    e' il client l'unico a saperla. Passandola come variabile, cambiare lingua
    dal profilo ricarica le etichette invece di lasciare quelle di prima.
  */
  const { i18n } = useTranslation()
  const lingua = i18n.resolvedLanguage ?? i18n.language
  const { data, loading, error } = useQuery<{ enumTypes: EnumTypeRow[] | null }>(
    GET_ENUM_TYPES, { variables: { language: lingua }, fetchPolicy: METAMODEL_FETCH_POLICY },
  )
  const value = useMemo<DomainVocabularies>(() => {
    // Due mappe e una precedenza sola: il vocabolario del cliente vince, e
    // quello spedito resta la seconda scelta.
    const own     = new Map<string, EnumTypeRow>()
    const shipped = new Map<string, EnumTypeRow>()
    for (const row of data?.enumTypes ?? []) {
      (row.isShipped ? shipped : own).set(row.name, row)
    }
    const ready = !loading && !error
    /** Il vocabolario che vince per questo cliente, o `undefined`. */
    const riga = (name: string) => (ready ? (own.get(name) ?? shipped.get(name)) : undefined)
    return {
      valuesOf:  (name) => riga(name)?.values ?? null,
      entriesOf: (name) => riga(name)?.valueLabels ?? null,
      labelOf:   (name, value) => riga(name)?.valueLabels.find((v) => v.value === value)?.label ?? null,
      colorOf:   (name, value) => riga(name)?.valueColors.find((v) => v.value === value)?.color ?? null,
      vocabularyLabelOf: (name) => riga(name)?.label || null,
      loading,
      error: error ? error.message : null,
    }
  }, [data, loading, error])
  return <DomainVocabularyContext.Provider value={value}>{children}</DomainVocabularyContext.Provider>
}

export function useDomainVocabularies(): DomainVocabularies {
  return useContext(DomainVocabularyContext)
}
