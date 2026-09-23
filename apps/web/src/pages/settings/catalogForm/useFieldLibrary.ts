/**
 * THE FIELD LIBRARY AS THE FORM BUILDER READS IT: every field of the tenant,
 * labelled in the language of whoever is looking, and found by name.
 *
 * It is read again after every write that changes it — a field created from a
 * type, a field edited from the properties, the fields an AI design created —
 * and those readings fail in two different ways on purpose:
 *
 *  - `reload` never throws: it says whether it worked. By then the write has
 *    happened, and a library that could not be read again must not undo it or
 *    leave a modal inviting the same write twice; the caller says, in its own
 *    words, that the page shows a stale library.
 *  - `refetch` rejects, as Apollo's does, for the one caller whose failure
 *    must stop what it is doing (landing an AI design on the open item: the
 *    AI modal then says the landing failed).
 */
import { useCallback, useMemo } from 'react'
import { useQuery } from '@apollo/client/react'
import { GET_FORM_FIELDS } from '@/graphql/queries'
import type { FormFieldRow } from './FieldLibraryPanel'

export function useFieldLibrary(language: string) {
  const { data, refetch } = useQuery<{ formFields: FormFieldRow[] }>(GET_FORM_FIELDS, {
    variables: { language }, fetchPolicy: 'cache-and-network',
  })
  // `?? []` crea un array nuovo a ogni render: dentro le dipendenze di un
  // useMemo lo farebbe ricalcolare sempre (avviso react-hooks).
  const fields = useMemo(() => data?.formFields ?? [], [data])
  const byName = useMemo(() => {
    const m = new Map<string, FormFieldRow>()
    for (const f of fields) m.set(f.name, f)
    return m
  }, [fields])

  /** Reads the library again; `false` when it could not be. Stable, so an effect can depend on it. */
  const reload = useCallback(async (): Promise<boolean> => {
    try {
      await refetch()
      return true
    } catch {
      return false
    }
  }, [refetch])

  return { fields, byName, refetch, reload }
}
