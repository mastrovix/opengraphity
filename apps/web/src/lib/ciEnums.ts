/**
 * Enumerazioni base dei CI (status, environment) e relative palette.
 *
 * Prima le triple `active/inactive/maintenance` e `production/staging/
 * development` erano hardcoded in 5 file ciascuna, mentre CIDetailPage le
 * leggeva dal metamodello: se un tenant aggiunge `decommissioned` le liste
 * divergono. Ora l'unica sorgente è `baseCIType.fields[].enumValues`.
 *
 * Fail-loud: se il tipo base non espone l'enum, l'hook restituisce liste
 * vuote E un messaggio d'errore (loggato) che i chiamanti mostrano.
 */
import { useMemo } from 'react'
import { useQuery } from '@apollo/client/react'
import { GET_BASE_CI_TYPE } from '@/graphql/queries'
import type { ValueColor } from '@opengraphity/types'
import { vocabularyValueStyle, type ValueStyle } from '@/lib/domainStyle'
import { METAMODEL_FETCH_POLICY } from '@/lib/fetchPolicy'
import { humanizeValue } from '@opengraphity/web-core'

interface BaseCITypeData {
  baseCIType: {
    fields: { name: string; fieldType: string; enumValues: string[] | null }[]
  } | null
}

export interface CIBaseEnums {
  statuses:     string[]
  environments: string[]
  loading:      boolean
  /** Presente quando il metamodello non fornisce i valori: da mostrare, non da ignorare. */
  error:        string | null
}

function enumOf(fields: BaseCITypeData['baseCIType'], name: string): string[] | string {
  const f = fields?.fields.find((x) => x.name === name)
  if (!f) return `base field "${name}" is not in the metamodel`
  if (f.fieldType !== 'enum') return `base field "${name}" is not an enum (${f.fieldType})`
  if (!f.enumValues || f.enumValues.length === 0) return `base field "${name}" has no enumValues`
  return f.enumValues
}

export function useCIBaseEnums(): CIBaseEnums {
  const { data, loading, error } = useQuery<BaseCITypeData>(GET_BASE_CI_TYPE, { fetchPolicy: METAMODEL_FETCH_POLICY })
  return useMemo(() => {
    if (loading && !data) return { statuses: [], environments: [], loading: true, error: null }
    if (error) {
      console.error('[ciEnums] baseCIType not loaded:', error.message)
      return { statuses: [], environments: [], loading: false, error: error.message }
    }
    const st = enumOf(data?.baseCIType ?? null, 'status')
    const en = enumOf(data?.baseCIType ?? null, 'environment')
    const problems = [st, en].filter((x): x is string => typeof x === 'string')
    if (problems.length > 0) console.error('[ciEnums]', problems.join(' · '))
    return {
      statuses:     Array.isArray(st) ? st : [],
      environments: Array.isArray(en) ? en : [],
      loading:      false,
      error:        problems.length > 0 ? problems.join(' · ') : null,
    }
  }, [data, loading, error])
}

/**
 * The options of a vocabulary field: the Dictionary label when there is one,
 * otherwise the value as `humanizeValue` shows it (D29, tour of 23 Sep 2026:
 * «in_progress» → «In progress», and a value written as a sentence stays as
 * it is — it used to become «Pick Up At The IT Desk»).
 */
export function toEnumOptions(values: readonly string[], labelOf?: (value: string) => string | null | undefined): { value: string; label: string }[] {
  return values.map((v) => ({ value: v, label: labelOf?.(v) || humanizeValue(v) }))
}

// ── Palette stato CI (unica: prima solo TopologyPage la coloriva) ────────────

/**
 * Lo stile dello stato del CI. Il colore è quello che il Dizionario assegna al
 * valore del vocabolario `ci_status` (revisione del 14 set 2026 · F9): prima
 * era `CI_STATUS_STYLE`, una tabella con quattro stati scritta qui.
 *
 * Ondata 7 · D-15: `vocabulary` sono gli stati ammessi per QUESTO cliente (o
 * `null` mentre non si sanno). Uno stato del vocabolario senza colore — o un
 * valore che il cliente ha aggiunto — è normale e prende lo stile neutro; uno
 * stato **fuori** dal vocabolario resta rosso, perché quello è un record da
 * sistemare.
 */
export function ciStatusStyle(status: string, vocabulary: readonly string[] | null, color: ValueColor | null): ValueStyle {
  return vocabularyValueStyle('ci_status', status, vocabulary, color)
}
