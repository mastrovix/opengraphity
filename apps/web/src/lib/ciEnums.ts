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
import { palette } from '@/lib/tokens'
import { domainValueStyle } from '@/lib/domainStyle'

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
  if (!f) return `campo base "${name}" assente nel metamodello`
  if (f.fieldType !== 'enum') return `campo base "${name}" non è un enum (${f.fieldType})`
  if (!f.enumValues || f.enumValues.length === 0) return `campo base "${name}" senza enumValues`
  return f.enumValues
}

export function useCIBaseEnums(): CIBaseEnums {
  const { data, loading, error } = useQuery<BaseCITypeData>(GET_BASE_CI_TYPE, { fetchPolicy: 'cache-first' })
  return useMemo(() => {
    if (loading && !data) return { statuses: [], environments: [], loading: true, error: null }
    if (error) {
      console.error('[ciEnums] baseCIType non caricato:', error.message)
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

/** "active" → "Active", "database_instance" → "Database Instance" */
export function enumLabel(v: string): string {
  return v.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export function toEnumOptions(values: string[]): { value: string; label: string }[] {
  return values.map((v) => ({ value: v, label: enumLabel(v) }))
}

// ── Palette stato CI (unica: prima solo TopologyPage la coloriva) ────────────

export const CI_STATUS_STYLE: Record<string, { bg: string; color: string }> = {
  active:         { bg: palette.success.tint, color: palette.success.strong },
  inactive:       { bg: palette.danger.tint, color: palette.danger.strong },
  maintenance:    { bg: palette.yellow.bg, color: palette.yellow.text },
  decommissioned: { bg: 'var(--color-slate-bg)', color: 'var(--color-slate)' },
}

/**
 * Ondata 7 · D-15: `vocabulary` sono gli stati ammessi per QUESTO cliente
 * (`useCIBaseEnums().statuses`, o `null` mentre non si sanno). Uno stato del
 * vocabolario senza colore assegnato — `expired`, `revoked`, o un valore che
 * il cliente ha aggiunto — è normale e prende lo stile neutro; uno stato
 * **fuori** dal vocabolario resta rosso, perché quello è un record da
 * sistemare. Prima erano lo stesso caso, e ogni riga di lista finiva con una
 * pastiglia rossa e un `console.error`.
 */
export function ciStatusStyle(status: string, vocabulary: readonly string[] | null = null): { bg: string; color: string } {
  return domainValueStyle(CI_STATUS_STYLE, status, 'CI_STATUS_STYLE', vocabulary)
}

// ── Etichette i18n dei tipi CI "storici" ─────────────────────────────────────
// Unione delle due mappe che vivevano in CIListPage e AnomalyPage.

export const CI_TYPE_LABEL_KEYS: Record<string, string> = {
  application:       'sidebar.application',
  server:            'sidebar.server',
  database:          'sidebar.database',
  database_instance: 'sidebar.dbInstance',
  certificate:       'sidebar.certificate',
  ssl_certificate:   'sidebar.certificate',
}

/** Chiave i18n del tipo, o null se il tipo non ha un'etichetta fissa (si usa `ciType.label`). */
export function ciTypeLabelKey(typeName: string | null | undefined): string | null {
  return typeName ? (CI_TYPE_LABEL_KEYS[typeName] ?? null) : null
}
