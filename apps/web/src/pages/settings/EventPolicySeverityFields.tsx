/**
 * HOW SERIOUS AN INCIDENT OPENED BY THE MONITORING IS, INSIDE AND OUTSIDE
 * PRODUCTION (alarm policy, 23 Sep 2026).
 *
 * Two policy fields, which the API applies:
 *  - `productionEnvironments`: which values of the tenant's `environment`
 *    vocabulary count as production (a CI without an environment counts as
 *    production);
 *  - `nonProductionSeverityMap`: a second severity → impact/urgency table for
 *    the CIs outside production; off = the main table everywhere.
 *
 * The severity table itself lives here too, so the page and the
 * non-production switch draw the same editor.
 */
import { useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { Select, FieldLabel } from '@/components/ui/FormControls'
import { Toggle } from '@/components/ui/Toggle'
import { GET_DOMAIN_MATRICES } from '@/graphql/queries'
import { METAMODEL_FETCH_POLICY } from '@/lib/fetchPolicy'
import { useDomainVocabularies } from '@/contexts/DomainVocabularyContext'
import { colors } from '@/lib/tokens'
import { EVENT_SEVERITIES, type EventSeverity } from '@/types/events'

export type SeverityMap = Record<EventSeverity, { impact: string; urgency: string }>

export const EMPTY_SEVERITY_MAP: SeverityMap = Object.fromEntries(
  EVENT_SEVERITIES.map((sev) => [sev, { impact: '', urgency: '' }]),
) as SeverityMap

/** Every severity has an impact and an urgency: a table with a hole is not saved. */
export function severityMapComplete(map: SeverityMap): boolean {
  return EVENT_SEVERITIES.every((sev) => map[sev].impact !== '' && map[sev].urgency !== '')
}

/** The tenant's `priority` matrix: its two inputs ARE the impact and urgency vocabularies. */
export interface PriorityMatrix { kind: string; inputs: string[]; inputValues: string[][] }

/**
 * The values the severity tables offer. The PAGE reads it, together with the
 * policy: read by the tables, it started only once the form was drawn, and
 * for a moment every select offered nothing but «Choose a value…».
 */
export function usePriorityMatrix(): PriorityMatrix | undefined {
  const matrices = useQuery<{ domainMatrices: PriorityMatrix[] }>(GET_DOMAIN_MATRICES, { fetchPolicy: METAMODEL_FETCH_POLICY })
  return matrices.data?.domainMatrices.find((m) => m.kind === 'priority')
}

/** The environment vocabulary of the tenant: the one `productionEnvironments` is checked against. */
const ENVIRONMENT_VOCABULARY = 'environment'

const helpStyle = { margin: '4px 0 0', fontSize: 'var(--font-size-label)', color: colors.slateLight, lineHeight: 1.5 } as const

/**
 * The severity → impact/urgency table. The values come from the tenant's
 * `priority` matrix (its two inputs ARE the impact and urgency vocabularies);
 * a saved value that is not (any more) in the vocabulary stays, marked
 * unknown, so the first save does not replace it silently.
 */
export function SeverityMapEditor({ map, priority, onChange, disabled, describedBy, caption }: {
  map: SeverityMap
  /** From `usePriorityMatrix`; undefined while it is read. */
  priority: PriorityMatrix | undefined
  onChange: (sev: EventSeverity, field: 'impact' | 'urgency', value: string) => void
  disabled: boolean
  describedBy?: string | undefined
  /** Prefixed to the accessible name of each select, to tell two tables apart. */
  caption?: string
}) {
  const { t } = useTranslation()
  const { labelOf } = useDomainVocabularies()
  const options = (field: 'impact' | 'urgency', current: string): { value: string; label: string }[] => {
    const i = priority?.inputs.indexOf(field) ?? -1
    const values = i >= 0 ? (priority?.inputValues[i] ?? []) : []
    const entries = values.map((v) => ({ value: v, label: labelOf(field, v) ?? v }))
    if (current && !values.includes(current)) entries.push({ value: current, label: t('events.policy.lifecycleUnknown', { value: current }) })
    if (entries.length === 0) entries.push({ value: '', label: t('events.policy.map.chooseValue') })
    else if (current === '') entries.unshift({ value: '', label: t('events.policy.map.chooseValue') })
    return entries
  }
  return (
    <div className="og-scroll-x">
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-size-body)' }}>
        <thead>
          <tr>
            {['severity', 'impact', 'urgency'].map((h) => (
              <th key={h} scope="col" style={{ textAlign: 'left', padding: '4px 8px' }}>{t(`events.policy.map.${h}`)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {EVENT_SEVERITIES.map((sev) => (
            <tr key={sev}>
              <td style={{ padding: '6px 8px', fontWeight: 500, color: colors.slateDark }}>{t(`events.severity.${sev}`)}</td>
              {(['impact', 'urgency'] as const).map((field) => (
                <td key={field} style={{ padding: '6px 8px' }}>
                  <Select
                    aria-label={`${caption ? `${caption} – ` : ''}${t(`events.severity.${sev}`)} – ${t(`events.policy.map.${field}`)}`}
                    value={map[sev][field]}
                    onChange={(e) => onChange(sev, field, e.target.value)}
                    disabled={disabled}
                    aria-describedby={describedBy}
                  >
                    {options(field, map[sev][field]).map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
                  </Select>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * Which environments count as production, and the switch for a different
 * impact and urgency outside production. With the switch on, the list of
 * production environments cannot be empty (the API refuses it): it is said
 * here, before the save.
 */
export function ProductionFields({ environments, nonProductionMap, priority, onEnvironments, onNonProductionMap, onNonProductionValue, disabled, idPrefix, mapError }: {
  environments: string[]
  nonProductionMap: SeverityMap | null
  priority: PriorityMatrix | undefined
  onEnvironments: (values: string[]) => void
  onNonProductionMap: (map: SeverityMap | null) => void
  onNonProductionValue: (sev: EventSeverity, field: 'impact' | 'urgency', value: string) => void
  disabled: boolean
  idPrefix: string
  /** The saved table could not be read: said until it is saved again. */
  mapError: string | null
}) {
  const { t } = useTranslation()
  const { valuesOf, labelOf } = useDomainVocabularies()
  const vocabulary = valuesOf(ENVIRONMENT_VOCABULARY) ?? []
  // A saved value the vocabulary does not have any more stays, marked unknown: nothing disappears silently.
  const options = [...vocabulary, ...environments.filter((v) => !vocabulary.includes(v))]
  const toggle = (value: string, on: boolean) => onEnvironments(options.filter((v) => (v === value ? on : environments.includes(v))))
  const on = nonProductionMap !== null
  return (
    <div style={{ marginTop: 16 }}>
      <FieldLabel><span id={`${idPrefix}-envs-label`}>{t('events.policy.productionEnvironments')}</span></FieldLabel>
      <div role="group" aria-labelledby={`${idPrefix}-envs-label`} style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 20px', marginTop: 4 }}>
        {options.map((value) => (
          <label key={value} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-body)', color: colors.slateDark }}>
            <input type="checkbox" checked={environments.includes(value)} disabled={disabled} onChange={(e) => toggle(value, e.target.checked)} />
            {vocabulary.includes(value) ? (labelOf(ENVIRONMENT_VOCABULARY, value) ?? value) : t('events.policy.lifecycleUnknown', { value })}
          </label>
        ))}
      </div>
      <p style={helpStyle}>{t('events.policy.help.productionEnvironments')}</p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
        <Toggle
          id={`${idPrefix}-nonprod`}
          checked={on}
          onChange={(v) => onNonProductionMap(v ? EMPTY_SEVERITY_MAP : null)}
          label={t('events.policy.nonProductionSeverityMap')}
          labelledBy={`${idPrefix}-nonprod-label`}
          disabled={disabled}
        />
        <label id={`${idPrefix}-nonprod-label`} htmlFor={`${idPrefix}-nonprod`} style={{ fontSize: 'var(--font-size-body)', color: disabled ? colors.slateLight : colors.slateDark }}>
          {t('events.policy.nonProductionSeverityMap')}
        </label>
      </div>
      <p style={helpStyle}>{t('events.policy.help.nonProductionSeverityMap')}</p>
      {mapError && (
        <p role="alert" style={{ ...helpStyle, color: colors.danger, fontWeight: 500 }}>{t('events.policy.nonProductionMapInvalid', { error: mapError })}</p>
      )}
      {on && environments.length === 0 && (
        <p role="alert" style={{ ...helpStyle, color: colors.danger, fontWeight: 500 }}>{t('events.policy.validation.productionEnvironmentsRequired')}</p>
      )}
      {on && (
        <div style={{ marginTop: 8 }}>
          <SeverityMapEditor map={nonProductionMap} priority={priority} onChange={onNonProductionValue} disabled={disabled} caption={t('events.policy.outsideProduction')} />
        </div>
      )}
    </div>
  )
}
