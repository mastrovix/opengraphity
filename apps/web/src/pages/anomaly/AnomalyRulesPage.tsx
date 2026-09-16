/**
 * LE REGOLE DI ANOMALIA, configurate dal cliente (verifica «Cosa resta
 * cablato», ondata 5).
 *
 * Prima soglie, gravità, tipi di CI, relazioni e severità contate erano scritti
 * nelle Cypher dell'API: un cliente con una CMDB diversa riceveva le anomalie
 * di un'altra CMDB. Qui ogni regola si accende o si spegne e si sceglie su cosa
 * lavora; cos'è un orfano o un ciclo resta del prodotto, e la pagina lo dice.
 *
 * Le scelte possibili arrivano dal server (metamodello e Dizionario del
 * cliente): nessuna lista copiata nel web. Una regola che cita un tipo tolto
 * dopo il salvataggio mostra il problema invece di sembrare a posto.
 */
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ArrowLeft, Plus, Save, ShieldAlert, X } from 'lucide-react'
import { toast } from 'sonner'
import { PageContainer } from '@/components/PageContainer'
import { PageTitle } from '@/components/PageTitle'
import { SectionCard } from '@/components/ui/SectionCard'
import { Toggle } from '@/components/ui/Toggle'
import { Button } from '@/components/Button'
import { Select, Input, LabelledField } from '@/components/ui/FormControls'
// G-ANO-6: la severità delle anomalie è una scala del prodotto, non il vocabolario del cliente.
import { AnomalySeverityBadge } from '@/components/ui/badges'
import { GET_ANOMALY_RULES, UPDATE_ANOMALY_RULE } from '@/graphql/queries'
import { useDomainVocabularies } from '@/contexts/DomainVocabularyContext'
import { ciTypeLabelKey } from '@/lib/ciEnums'
import { colors } from '@/lib/tokens'
import { formatDateTime } from '@/lib/datetime'
import { RULE_LABEL_KEYS } from './AnomalyPage'

// ── Tipi ──────────────────────────────────────────────────────────────────────

interface Forbidden { fromType: string; relation: string; toType: string }

export interface AnomalyRuleSettings {
  enabled:            boolean
  severity:           string
  ciTypes:            string[]
  relations:          string[]
  threshold:          number | null
  incidentSeverities: string[]
  forbidden:          Forbidden[]
}

export interface AnomalyRuleSpec {
  ciTypes: boolean; relations: boolean; incidentSeverities: boolean; forbidden: boolean
  thresholdMin: number | null; thresholdMax: number | null
}

interface AnomalyRule extends AnomalyRuleSettings {
  ruleKey:   string
  spec:      AnomalyRuleSpec
  isDefault: boolean
  updatedAt: string | null
  openCount: number
  problem:   { key: string; message: string; params: Array<{ key: string; value: string }> } | null
}

interface Options {
  ciTypes:            Array<{ name: string; label: string; neo4jLabel: string }>
  relations:          string[]
  incidentSeverities: string[]
  severities:         string[]
}

/** Il motivo per cui la bozza non si può salvare (le stesse regole dell'API), come chiave i18n; `null` se va bene. */
export function ruleDraftProblem(draft: AnomalyRuleSettings, spec: AnomalyRuleSpec): string | null {
  if (spec.thresholdMin !== null && spec.thresholdMax !== null) {
    const n = draft.threshold
    if (n === null || !Number.isInteger(n) || n < spec.thresholdMin || n > spec.thresholdMax) return 'pages.anomalyRules.problemThreshold'
  }
  if (spec.relations && draft.relations.length === 0) return 'pages.anomalyRules.problemRelations'
  if (spec.incidentSeverities && draft.incidentSeverities.length === 0) return 'pages.anomalyRules.problemSeverities'
  if (spec.forbidden) {
    if (draft.forbidden.length === 0) return 'pages.anomalyRules.problemForbiddenEmpty'
    if (draft.forbidden.some((f) => !f.fromType || !f.relation || !f.toType)) return 'pages.anomalyRules.problemForbiddenIncomplete'
    const keys = draft.forbidden.map((f) => `${f.fromType}|${f.relation}|${f.toType}`)
    if (new Set(keys).size !== keys.length) return 'pages.anomalyRules.problemForbiddenDuplicate'
  }
  return null
}

const settingsOf = (r: AnomalyRule): AnomalyRuleSettings => ({
  enabled: r.enabled, severity: r.severity, ciTypes: r.ciTypes, relations: r.relations, threshold: r.threshold,
  incidentSeverities: r.incidentSeverities, forbidden: r.forbidden.map(({ fromType, relation, toType }) => ({ fromType, relation, toType })),
})

// ── Pezzi ─────────────────────────────────────────────────────────────────────

function Chips({ values, selected, labelOf, onChange, label }: {
  values: readonly string[]; selected: readonly string[]; labelOf: (v: string) => string
  onChange: (next: string[]) => void; label: string
}) {
  const { t } = useTranslation()
  /**
   * Anche i valori SALVATI che non sono (più) fra le opzioni (revisione totale
   * · G-ANO-5): prima si disegnavano solo le opzioni, quindi un tipo di CI
   * cancellato restava nella regola — invisibile, non deselezionabile, e
   * spedito a ogni salvataggio, che l'API rifiutava: la regola non era più
   * riparabile dall'interfaccia.
   */
  const orphans = selected.filter((v) => !values.includes(v))
  return (
    <div role="group" aria-label={label} style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {[...values, ...orphans].map((v) => {
        const on = selected.includes(v)
        const orphan = orphans.includes(v)
        return (
          <button
            key={v} type="button" aria-pressed={on}
            title={orphan ? t('pages.anomalyRules.orphanValue', { value: v }) : undefined}
            onClick={() => onChange(on ? selected.filter((x) => x !== v) : [...selected, v])}
            style={{
              font: 'inherit', fontSize: 'var(--font-size-body)', cursor: 'pointer', padding: '4px 10px', borderRadius: 999,
              border: `1px solid ${orphan ? 'var(--color-danger-text)' : on ? colors.brand : colors.border}`,
              background: orphan ? 'var(--color-danger-bg)' : on ? 'var(--color-brand-light)' : 'var(--surface)',
              color: orphan ? 'var(--color-danger-text)' : on ? colors.brandHover : colors.slate, fontWeight: on ? 600 : 400,
            }}
          >
            {orphan ? t('pages.anomalyRules.orphanChip', { value: v }) : labelOf(v)}
          </button>
        )
      })}
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <LabelledField
      label={label}
      style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
      labelStyle={{ fontSize: 'var(--font-size-label)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: colors.slateLight }}
      after={hint && <div style={{ fontSize: 'var(--font-size-label)', color: colors.slateLight }}>{hint}</div>}
    >
      {children}
    </LabelledField>
  )
}

function RuleCard({ rule, options }: { rule: AnomalyRule; options: Options }) {
  const { t } = useTranslation()
  const { labelOf: vocabularyLabel } = useDomainVocabularies()
  const [draft, setDraft] = useState<AnomalyRuleSettings | null>(null)
  const current = draft ?? settingsOf(rule)
  const set = (patch: Partial<AnomalyRuleSettings>) => setDraft({ ...current, ...patch })
  const problem = ruleDraftProblem(current, rule.spec)
  const [save, { loading: saving }] = useMutation(UPDATE_ANOMALY_RULE, {
    refetchQueries: [GET_ANOMALY_RULES],
    onCompleted: () => { toast.success(t('pages.anomalyRules.saved')); setDraft(null) },
  })

  const typeLabel = useMemo(() => {
    const byName = new Map(options.ciTypes.map((c) => [c.name, c.label]))
    // F-22: prima l'etichetta del cliente, poi la chiave dei tipi spediti.
    return (name: string) => { const key = ciTypeLabelKey(name); return byName.get(name) || (key ? t(key) : name) }
  }, [options.ciTypes, t])
  const title = t(RULE_LABEL_KEYS[rule.ruleKey] ?? rule.ruleKey)
  const thresholdId = `anomaly-threshold-${rule.ruleKey}`
  const severityId = `anomaly-severity-${rule.ruleKey}`
  const enabledId = `anomaly-enabled-${rule.ruleKey}`

  return (
    <SectionCard
      title={title}
      headerRight={(
        <span style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 'var(--font-size-label)' }}>
          {rule.problem && <AlertTriangle size={14} color="var(--color-danger-text)" aria-label={t('pages.anomalyRules.hasProblem')} />}
          <span style={{ color: rule.enabled ? colors.success : colors.slateLight, fontWeight: 600 }}>
            {rule.enabled ? t('pages.anomalyRules.on') : t('pages.anomalyRules.off')}
          </span>
          <AnomalySeverityBadge value={rule.severity} />
          <span style={{ color: colors.slateLight }}>{t('pages.anomalyRules.openCount', { count: rule.openCount })}</span>
        </span>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <p style={{ margin: 0, fontSize: 'var(--font-size-body)', color: colors.slateLight, maxWidth: '72ch' }}>
          {t(`pages.anomalyRules.logic.${rule.ruleKey}`)}
        </p>

        {rule.problem && (
          <div role="alert" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '10px 12px', borderRadius: 6, background: 'var(--color-danger-bg)', color: 'var(--color-danger-text)', fontSize: 'var(--font-size-body)' }}>
            <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
            <span>
              {t('pages.anomalyRules.problemSaved')}{' '}
              {t(rule.problem.key, { defaultValue: rule.problem.message, ...Object.fromEntries(rule.problem.params.map((p) => [p.key, p.value])) })}
            </span>
          </div>
        )}

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'flex-end' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Toggle checked={current.enabled} onChange={(v) => set({ enabled: v })} label={t('pages.anomalyRules.enabled')} labelledBy={enabledId} />
            <span id={enabledId} style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', fontWeight: 500 }}>
              {t('pages.anomalyRules.enabled')}
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label htmlFor={severityId} style={{ fontSize: 'var(--font-size-label)', color: colors.slateLight }}>{t('pages.anomalyRules.severity')}</label>
            <Select id={severityId} value={current.severity} onChange={(e) => set({ severity: e.target.value })} style={{ width: 150 }}>
              {options.severities.map((s) => <option key={s} value={s}>{t(`pages.anomalies.severities.${s}`)}</option>)}
            </Select>
          </div>
          {rule.spec.thresholdMin !== null && rule.spec.thresholdMax !== null && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label htmlFor={thresholdId} style={{ fontSize: 'var(--font-size-label)', color: colors.slateLight }}>
                {t(`pages.anomalyRules.threshold.${rule.ruleKey}`)}
              </label>
              <Input
                id={thresholdId} type="number" step={1} min={rule.spec.thresholdMin} max={rule.spec.thresholdMax}
                value={current.threshold === null ? '' : String(current.threshold)}
                onChange={(e) => set({ threshold: e.target.value === '' ? null : Number(e.target.value) })}
                style={{ width: 110 }}
              />
            </div>
          )}
        </div>

        {rule.spec.ciTypes && (
          <Field
            label={t(rule.ruleKey === 'isolated_cluster' ? 'pages.anomalyRules.candidateTypes' : 'pages.anomalyRules.ciTypes')}
            hint={current.ciTypes.length === 0 ? t('pages.anomalyRules.allTypes') : t('pages.anomalyRules.someTypes', { count: current.ciTypes.length })}
          >
            <Chips values={options.ciTypes.map((c) => c.name)} selected={current.ciTypes} labelOf={typeLabel} onChange={(v) => set({ ciTypes: v })} label={t('pages.anomalyRules.ciTypes')} />
          </Field>
        )}

        {rule.spec.relations && (
          <Field label={t('pages.anomalyRules.relations')} hint={t('pages.anomalyRules.relationsHint')}>
            <Chips values={options.relations} selected={current.relations} labelOf={(v) => v} onChange={(v) => set({ relations: v })} label={t('pages.anomalyRules.relations')} />
          </Field>
        )}

        {rule.spec.incidentSeverities && (
          <Field label={t('pages.anomalyRules.incidentSeverities')} hint={t('pages.anomalyRules.incidentSeveritiesHint')}>
            <Chips values={options.incidentSeverities} selected={current.incidentSeverities} labelOf={(v) => vocabularyLabel('severity', v) ?? v} onChange={(v) => set({ incidentSeverities: v })} label={t('pages.anomalyRules.incidentSeverities')} />
          </Field>
        )}

        {rule.spec.forbidden && (
          <Field label={t('pages.anomalyRules.forbidden')} hint={t('pages.anomalyRules.forbiddenHint')}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {current.forbidden.map((f, i) => {
                const patch = (p: Partial<Forbidden>) => set({ forbidden: current.forbidden.map((x, j) => (j === i ? { ...x, ...p } : x)) })
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <Select value={f.fromType} onChange={(e) => patch({ fromType: e.target.value })} aria-label={t('pages.anomalyRules.fromType')} style={{ width: 180 }}>
                      <option value="">—</option>
                      {options.ciTypes.map((c) => <option key={c.name} value={c.name}>{typeLabel(c.name)}</option>)}
                    </Select>
                    <Select value={f.relation} onChange={(e) => patch({ relation: e.target.value })} aria-label={t('pages.anomalyRules.relation')} style={{ width: 180 }}>
                      <option value="">—</option>
                      {options.relations.map((r) => <option key={r} value={r}>{r}</option>)}
                    </Select>
                    <span aria-hidden="true" style={{ color: colors.slateLight }}>→</span>
                    <Select value={f.toType} onChange={(e) => patch({ toType: e.target.value })} aria-label={t('pages.anomalyRules.toType')} style={{ width: 180 }}>
                      <option value="">—</option>
                      {options.ciTypes.map((c) => <option key={c.name} value={c.name}>{typeLabel(c.name)}</option>)}
                    </Select>
                    <button type="button" onClick={() => set({ forbidden: current.forbidden.filter((_, j) => j !== i) })}
                      aria-label={t('pages.anomalyRules.removeForbidden')}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-slate-light)', display: 'flex' }}>
                      <X size={14} aria-hidden="true" />
                    </button>
                  </div>
                )
              })}
              <div>
                <Button variant="secondary" onClick={() => set({ forbidden: [...current.forbidden, { fromType: '', relation: '', toType: '' }] })}>
                  <Plus size={14} /> {t('pages.anomalyRules.addForbidden')}
                </Button>
              </div>
            </div>
          </Field>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, borderTop: `1px solid ${colors.border}`, paddingTop: 12 }}>
          <Button
            onClick={() => void save({ variables: { ruleKey: rule.ruleKey, settings: current } })}
            disabled={draft === null || problem !== null || saving}
          >
            <Save size={14} /> {t('common.save')}
          </Button>
          {draft !== null && (
            <Button variant="secondary" onClick={() => setDraft(null)}>{t('common.cancel')}</Button>
          )}
          <span role={problem && draft ? 'alert' : undefined} style={{ fontSize: 'var(--font-size-label)', color: problem && draft ? 'var(--color-danger-text)' : colors.slateLight }}>
            {problem && draft
              ? t(problem, { min: rule.spec.thresholdMin, max: rule.spec.thresholdMax })
              : rule.isDefault ? t('pages.anomalyRules.factory') : rule.updatedAt ? t('pages.anomalyRules.updatedAt', { date: formatDateTime(rule.updatedAt) }) : null}
          </span>
        </div>
      </div>
    </SectionCard>
  )
}

// ── Pagina ────────────────────────────────────────────────────────────────────

export function AnomalyRulesPage() {
  const { t } = useTranslation()
  const { data, loading, error } = useQuery<{ anomalyRules: AnomalyRule[]; anomalyRuleOptions: Options }>(GET_ANOMALY_RULES, { fetchPolicy: 'cache-and-network' })

  return (
    <PageContainer style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <Link to="/anomalies" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--font-size-label)', color: colors.brand, textDecoration: 'none', marginBottom: 8 }}>
          <ArrowLeft size={13} aria-hidden="true" /> {t('pages.anomalyRules.backToAnomalies')}
        </Link>
        <PageTitle icon={<ShieldAlert size={22} color="var(--color-icon-accent)" />}>{t('pages.anomalyRules.title')}</PageTitle>
        <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', marginTop: 4, marginBottom: 0, maxWidth: '80ch' }}>
          {t('pages.anomalyRules.subtitle')}
        </p>
      </div>
      {loading && !data && <p>{t('common.loading')}</p>}
      {error && <p role="alert" style={{ color: 'var(--color-danger-text)' }}>{error.message}</p>}
      {data?.anomalyRules.map((r) => <RuleCard key={r.ruleKey} rule={r} options={data.anomalyRuleOptions} />)}
    </PageContainer>
  )
}
