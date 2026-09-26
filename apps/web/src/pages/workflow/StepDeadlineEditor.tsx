/**
 * LA SCADENZA DEL PASSO, nel disegnatore (verifica «Cosa resta cablato», ondata 3).
 *
 * «Se la change resta in review più di 7 giorni, vai a closed e imposta esito =
 * successful»: dopo quanto (ore o giorni), come conta il tempo (24×7 o un
 * calendario di servizio), verso quale passo — uno di quelli raggiungibili con
 * un arco da qui — e quali campi impostare.
 *
 * Il componente è CONTROLLATO: tiene la bozza, e al pannello restituisce la
 * scadenza come JSON (o `''` = nessuna). Le regole che l'API applica in
 * scrittura qui si dicono PRIMA: un passo di arrivo protetto dalle approvazioni
 * compare spento con il motivo, e il Salva resta spento finché la bozza non è
 * completa. L'API resta l'autorità.
 */
import { Toggle } from '@/components/ui/Toggle'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import {
  DEADLINE_PROTECTED_SOURCE_PURPOSES, DEADLINE_PROTECTED_TARGET_PURPOSES, STEP_DEADLINE_MAX_DAYS, STEP_DEADLINE_UNITS,
  isStepFieldWritable, parseStepDeadline, type StepDeadline, type StepDeadlineUnit,
} from '@opengraphity/types'
import { Input, Select } from '@/components/ui/FormControls'
import { useEntityFieldMetas, type FieldMeta } from '@/hooks/useEntityFields'
import { useDomainVocabularies } from '@/contexts/DomainVocabularyContext'
import { ALWAYS_ON, useServiceCalendars } from '@/components/sla/ServiceTargetFields'
import { colors, palette } from '@/lib/tokens'
import { PanelField, panelInputStyle } from './workflow-panel-helpers'

/** Un passo raggiungibile con un arco dal passo che si sta modificando. */
export interface DeadlineTarget { name: string; label: string; purpose: string | null }

/** La bozza del pannello: stringhe come nei campi, convertite solo al salvataggio. */
export interface DeadlineDraft {
  enabled:  boolean
  after:    string
  unit:     StepDeadlineUnit
  calendar: string            // ALWAYS_ON oppure l'id del calendario
  toStep:   string
  fields:   { field: string; value: string }[]
}

/** Campi che si assegnano, non si scrivono: si usano le azioni di assegnazione. */
const RELATION_TYPES = new Set(['user', 'team', 'reference', 'relation'])

export function draftFromDeadline(raw: string | null | undefined): { draft: DeadlineDraft; error: string | null } {
  const empty: DeadlineDraft = { enabled: false, after: '', unit: 'days', calendar: ALWAYS_ON, toStep: '', fields: [] }
  try {
    const d = parseStepDeadline(raw)
    if (!d) return { draft: empty, error: null }
    return {
      draft: { enabled: true, after: String(d.after), unit: d.unit, calendar: d.calendar_id ?? ALWAYS_ON, toStep: d.to_step, fields: d.set_fields.map((f) => ({ ...f })) },
      error: null,
    }
  } catch (e) {
    return { draft: empty, error: e instanceof Error ? e.message : String(e) }
  }
}

/** La scadenza da salvare: JSON, `''` se spenta. Lancia se la bozza è incompleta (il Salva è spento prima). */
export function deadlineFromDraft(d: DeadlineDraft): string {
  if (!d.enabled) return ''
  const deadline: StepDeadline = {
    after: Number(d.after), unit: d.unit, calendar_id: d.calendar === ALWAYS_ON ? null : d.calendar,
    to_step: d.toStep, set_fields: d.fields.map((f) => ({ field: f.field, value: f.value })),
  }
  return JSON.stringify(parseStepDeadline(deadline))
}

/** Perché la bozza non si può salvare (chiave i18n), o `null`. */
export function draftProblem(d: DeadlineDraft, targets: readonly DeadlineTarget[], entityType: string, sourcePurpose: string | null): string | null {
  if (!d.enabled) return null
  const n = Number(d.after)
  const max = d.unit === 'days' ? STEP_DEADLINE_MAX_DAYS : STEP_DEADLINE_MAX_DAYS * 24
  if (d.after.trim() === '' || !Number.isInteger(n) || n < 1 || n > max) return 'workflow.deadline.problemAfter'
  if (entityType === 'change' && sourcePurpose && (DEADLINE_PROTECTED_SOURCE_PURPOSES as readonly string[]).includes(sourcePurpose)) return 'workflow.deadline.problemSource'
  const target = targets.find((t) => t.name === d.toStep)
  if (!target) return 'workflow.deadline.problemTarget'
  if (isProtectedTarget(target, entityType)) return 'workflow.deadline.problemProtected'
  if (d.fields.some((f) => f.field === '' || f.value.trim() === '')) return 'workflow.deadline.problemFields'
  if (new Set(d.fields.map((f) => f.field)).size !== d.fields.length) return 'workflow.deadline.problemDuplicate'
  return null
}

function isProtectedTarget(target: DeadlineTarget, entityType: string): boolean {
  return entityType === 'change' && target.purpose != null && (DEADLINE_PROTECTED_TARGET_PURPOSES as readonly string[]).includes(target.purpose)
}

interface Props {
  stepLabel:     string
  entityType:    string
  sourcePurpose: string | null
  targets:       readonly DeadlineTarget[]
  draft:         DeadlineDraft
  onChange:      (d: DeadlineDraft) => void
}

export function StepDeadlineEditor({ stepLabel, entityType, sourcePurpose, targets, draft, onChange }: Props) {
  const { t } = useTranslation()
  const { calendars } = useServiceCalendars()
  const { fields: metas } = useEntityFieldMetas(entityType, { withVirtual: false })
  const { labelOf } = useDomainVocabularies()
  const set = (patch: Partial<DeadlineDraft>) => onChange({ ...draft, ...patch })

  const writable = useMemo(
    () => metas.filter((f) => isStepFieldWritable(f.name, entityType) && !RELATION_TYPES.has(f.fieldType)),
    [metas, entityType],
  )
  const problem = draftProblem(draft, targets, entityType, sourcePurpose)
  const sourceProtected = entityType === 'change' && sourcePurpose != null && (DEADLINE_PROTECTED_SOURCE_PURPOSES as readonly string[]).includes(sourcePurpose)

  const target = targets.find((x) => x.name === draft.toStep)
  const calendarName = draft.calendar === ALWAYS_ON ? null : calendars.find((c) => c.id === draft.calendar)?.name ?? null
  const valueLabel = (field: string, value: string) => {
    const meta = metas.find((m) => m.name === field)
    return (meta?.enumTypeName ? labelOf(meta.enumTypeName, value) : null) ?? value
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '8px 0' }}>
      <p style={{ margin: 0, fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', lineHeight: 1.45 }}>
        {t('workflow.deadline.intro')}
      </p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: sourceProtected && !draft.enabled ? 'not-allowed' : 'pointer' }}>
        <Toggle checked={draft.enabled} onChange={(v) => set({ enabled: v })} label={t('workflow.deadline.enable')} disabled={sourceProtected && !draft.enabled} />
        <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', fontWeight: 600 }}>
          {t('workflow.deadline.enable')}
        </span>
      </div>

      {sourceProtected && (
        <div role="note" style={noteStyle}>{t('workflow.deadline.problemSource')}</div>
      )}

      {draft.enabled && (
        <>
          <PanelField label={t('workflow.deadline.after')}>
            <div style={{ display: 'flex', gap: 6 }}>
              <Input
                type="number" min={1} step={1} inputMode="numeric"
                aria-label={t('workflow.deadline.amount')}
                value={draft.after}
                onChange={(e) => set({ after: e.target.value })} style={{ width: 80 }}
              />
              <Select aria-label={t('workflow.deadline.unit')} value={draft.unit} onChange={(e) => set({ unit: e.target.value as StepDeadlineUnit })} style={{ flex: 1 }}>
                {STEP_DEADLINE_UNITS.map((u) => <option key={u} value={u}>{t(`workflow.deadline.units.${u}`)}</option>)}
              </Select>
            </div>
          </PanelField>

          <PanelField label={t('serviceTargets.timeCounting')}>
            <Select aria-label={t('serviceTargets.timeCounting')} value={draft.calendar} onChange={(e) => set({ calendar: e.target.value })}>
              <option value={ALWAYS_ON}>{t('serviceTargets.alwaysOn')}</option>
              {calendars.map((c) => <option key={c.id} value={c.id}>{t('serviceTargets.calendarOption', { name: c.name })}</option>)}
            </Select>
            {draft.calendar !== ALWAYS_ON && draft.unit === 'days' && (
              <span style={hintStyle}>{t('workflow.deadline.serviceDayHint')}</span>
            )}
          </PanelField>

          <PanelField label={t('workflow.deadline.moveTo')}>
            {targets.length === 0 ? (
              <div role="note" style={noteStyle}>{t('workflow.deadline.noArcs', { step: stepLabel })}</div>
            ) : (
              <Select aria-label={t('workflow.deadline.moveTo')} value={draft.toStep} onChange={(e) => set({ toStep: e.target.value })}>
                <option value="">{t('workflow.deadline.chooseStep')}</option>
                {targets.map((x) => (
                  <option key={x.name} value={x.name} disabled={isProtectedTarget(x, entityType)}>
                    {isProtectedTarget(x, entityType) ? t('workflow.deadline.protectedOption', { step: x.label }) : x.label}
                  </option>
                ))}
              </Select>
            )}
          </PanelField>

          <PanelField label={t('workflow.deadline.setFields')}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {draft.fields.map((f, i) => (
                <div key={i} style={fieldRowStyle}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <Select
                      aria-label={t('workflow.deadline.field')}
                      value={f.field}
                      onChange={(e) => set({ fields: draft.fields.map((x, j) => (j === i ? { field: e.target.value, value: '' } : x)) })} style={{ flex: 1, minWidth: 0 }}
                    >
                      <option value="">{t('workflow.deadline.chooseField')}</option>
                      {writable.map((m) => <option key={m.name} value={m.name}>{m.label}</option>)}
                      {f.field && !writable.some((m) => m.name === f.field) && <option value={f.field}>{f.field}</option>}
                    </Select>
                    <button
                      type="button"
                      aria-label={t('workflow.deadline.removeField')}
                      title={t('workflow.deadline.removeField')}
                      onClick={() => set({ fields: draft.fields.filter((_, j) => j !== i) })}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-slate-light)', padding: 2, display: 'flex' }}
                    >
                      <X size={13} aria-hidden="true" />
                    </button>
                  </div>
                  <FieldValueInput
                    meta={metas.find((m) => m.name === f.field)}
                    value={f.value}
                    onChange={(value) => set({ fields: draft.fields.map((x, j) => (j === i ? { ...x, value } : x)) })}
                    labelOf={labelOf}
                  />
                </div>
              ))}
              <button
                type="button"
                onClick={() => set({ fields: [...draft.fields, { field: '', value: '' }] })}
                style={{ padding: '5px 10px', background: 'transparent', border: `1px dashed ${colors.brand}`, borderRadius: 6, fontSize: 'var(--font-size-body)', color: colors.brand, cursor: 'pointer', textAlign: 'left' }}
              >
                + {t('workflow.deadline.addField')}
              </button>
            </div>
          </PanelField>

          {problem ? (
            <div role="alert" style={{ ...noteStyle, borderColor: 'var(--color-warning-border)', background: palette.yellow.bg, color: palette.warning.strong }}>
              {t(problem)}
            </div>
          ) : (
            <div style={summaryStyle}>
              {t(calendarName ? 'workflow.deadline.summaryCalendar' : 'workflow.deadline.summary', {
                amount: Number(draft.after),
                unit: t(`workflow.deadline.unitsCount.${draft.unit}`, { count: Number(draft.after) }),
                step: stepLabel, target: target?.label ?? draft.toStep, calendar: calendarName,
              })}
              {draft.fields.length > 0 && (
                <> {t('workflow.deadline.summaryFields', { fields: draft.fields.map((f) => `${metas.find((m) => m.name === f.field)?.label ?? f.field} = ${valueLabel(f.field, f.value)}`).join(', ') })}</>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function FieldValueInput({ meta, value, onChange, labelOf }: {
  meta: FieldMeta | undefined; value: string; onChange: (v: string) => void
  labelOf: (vocabulary: string, value: string) => string | null
}) {
  const { t } = useTranslation()
  const style = { ...panelInputStyle, width: '100%' }
  if (!meta) return <Input aria-label={t('workflow.deadline.value')} disabled placeholder={t('workflow.deadline.chooseField')} style={style} value="" onChange={() => {}} />
  if (meta.fieldType === 'enum' && meta.enumValues.length > 0) {
    return (
      <Select aria-label={t('workflow.deadline.value')} value={value} onChange={(e) => onChange(e.target.value)} style={style}>
        <option value="">{t('workflow.deadline.chooseValue')}</option>
        {meta.enumValues.map((v) => <option key={v} value={v}>{(meta.enumTypeName ? labelOf(meta.enumTypeName, v) : null) ?? v}</option>)}
      </Select>
    )
  }
  if (meta.fieldType === 'boolean') {
    return (
      <Select aria-label={t('workflow.deadline.value')} value={value} onChange={(e) => onChange(e.target.value)} style={style}>
        <option value="">{t('workflow.deadline.chooseValue')}</option>
        <option value="true">{t('common.yes')}</option>
        <option value="false">{t('common.no')}</option>
      </Select>
    )
  }
  const type = meta.fieldType === 'number' ? 'number' : meta.fieldType === 'date' ? 'date' : 'text'
  return <Input aria-label={t('workflow.deadline.value')} type={type} value={value} onChange={(e) => onChange(e.target.value)} style={style} />
}

const hintStyle: React.CSSProperties = { fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', lineHeight: 1.4 }
const noteStyle: React.CSSProperties = {
  padding: '8px 10px', borderRadius: 6, border: '1px solid var(--color-border)', background: 'var(--color-slate-bg)',
  color: 'var(--color-slate)', fontSize: 'var(--font-size-label)', lineHeight: 1.45,
}
const fieldRowStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 6, padding: 8, borderRadius: 6,
  border: '1px solid var(--color-border)', background: 'var(--color-slate-bg)',
}
const summaryStyle: React.CSSProperties = {
  padding: '8px 10px', borderRadius: 6, background: colors.brandLight, color: palette.teal.base,
  fontSize: 'var(--font-size-label)', lineHeight: 1.5,
}
