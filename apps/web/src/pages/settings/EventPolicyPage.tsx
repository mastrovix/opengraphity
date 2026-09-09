/**
 * Policy dell'Event Management (per tenant, solo admin): quando aprire un
 * incident, raggruppamento, ritardo di apertura, chiusura automatica,
 * soppressione a monte, sfarfallio, conservazione e la mappa
 * severità → impatto/urgenza (JSON nel contratto, tre righe di select qui).
 */
import { useEffect, useId, useState } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Radar, Loader2 } from 'lucide-react'
import { PageContainer } from '@/components/PageContainer'
import { PageTitle } from '@/components/PageTitle'
import { PageLoader } from '@/components/PageLoader'
import { QueryError } from '@/components/QueryError'
import { Button } from '@/components/Button'
import { Input, Select, FieldLabel } from '@/components/ui/FormControls'
import { Toggle } from '@/components/ui/Toggle'
import { errorMessage } from '@/hooks/useMutationWithToast'
import { GET_EVENT_POLICY } from '@/graphql/queries'
import { UPDATE_EVENT_POLICY } from '@/graphql/mutations'
import { colors } from '@/lib/tokens'
import { EVENT_SEVERITIES, type EventPolicy, type EventSeverity } from '@/types/events'

const OPEN_FROM  = ['info', 'warning', 'critical', 'never'] as const
const GROUP_BY   = ['ci', 'fingerprint'] as const
const LEVELS     = ['low', 'medium', 'high'] as const
type Level = typeof LEVELS[number]

type SeverityMap = Record<EventSeverity, { impact: Level; urgency: Level }>

const DEFAULT_MAP: SeverityMap = {
  critical: { impact: 'high',   urgency: 'high' },
  warning:  { impact: 'medium', urgency: 'medium' },
  info:     { impact: 'low',    urgency: 'low' },
}

const isLevel = (v: unknown): v is Level => typeof v === 'string' && (LEVELS as readonly string[]).includes(v)

/**
 * severityMap (JSON) → tabella. Un JSON malformato o con valori fuori
 * vocabolario NON viene corretto in silenzio: torna `error` e il form parte
 * dai default, con l'avviso visibile finché l'admin non salva.
 */
function parseSeverityMap(raw: string): { map: SeverityMap; error: string | null } {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return { map: DEFAULT_MAP, error: 'severityMap: atteso un oggetto JSON' }
    const obj = parsed as Record<string, unknown>
    const map = { ...DEFAULT_MAP }
    for (const sev of EVENT_SEVERITIES) {
      const entry = obj[sev]
      if (entry === undefined) return { map: DEFAULT_MAP, error: `severityMap: manca la severità "${sev}"` }
      const { impact, urgency } = (entry ?? {}) as Record<string, unknown>
      if (!isLevel(impact) || !isLevel(urgency)) return { map: DEFAULT_MAP, error: `severityMap.${sev}: impact/urgency devono essere low|medium|high` }
      map[sev] = { impact, urgency }
    }
    return { map, error: null }
  } catch (e) {
    return { map: DEFAULT_MAP, error: e instanceof Error ? e.message : String(e) }
  }
}

interface FormState {
  openIncidentFrom:     string
  groupBy:              string
  openDelaySeconds:     number
  autoResolve:          boolean
  suppressUpstreamHops: number
  flapThreshold:        number
  flapWindowMinutes:    number
  retentionDays:        number
  severityMap:          SeverityMap
}

function toForm(p: EventPolicy): { form: FormState; mapError: string | null } {
  const { map, error } = parseSeverityMap(p.severityMap)
  return {
    form: {
      openIncidentFrom: p.openIncidentFrom, groupBy: p.groupBy,
      openDelaySeconds: p.openDelaySeconds, autoResolve: p.autoResolve,
      suppressUpstreamHops: p.suppressUpstreamHops, flapThreshold: p.flapThreshold,
      flapWindowMinutes: p.flapWindowMinutes, retentionDays: p.retentionDays,
      severityMap: map,
    },
    mapError: error,
  }
}

export function EventPolicyPage() {
  const { t } = useTranslation()
  const uid = useId()
  const fid = (name: string) => `${uid}-${name}`

  const { data, loading, error, refetch } = useQuery<{ eventPolicy: EventPolicy }>(GET_EVENT_POLICY, { fetchPolicy: 'cache-and-network' })
  const [update, { loading: saving }] = useMutation<{ updateEventPolicy: EventPolicy }>(UPDATE_EVENT_POLICY)

  const [form, setForm] = useState<FormState | null>(null)
  const [mapError, setMapError] = useState<string | null>(null)

  // Il form parte dai dati del server; un refetch dopo il salvataggio riallinea.
  useEffect(() => {
    if (!data) return
    const { form: f, mapError: e } = toForm(data.eventPolicy)
    setForm(f); setMapError(e)
  }, [data])

  if (error && !data) return <PageContainer><QueryError message={error.message} onRetry={() => void refetch()} /></PageContainer>
  if (loading && !form) return <PageLoader />
  if (!form) return null

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => (f ? { ...f, [key]: value } : f))
  const setNum = (key: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement>) => set(key, Number(e.target.value) as never)
  const setMap = (sev: EventSeverity, field: 'impact' | 'urgency', value: Level) =>
    setForm((f) => (f ? { ...f, severityMap: { ...f.severityMap, [sev]: { ...f.severityMap[sev], [field]: value } } } : f))

  async function handleSave() {
    if (!form) return
    try {
      await update({ variables: { input: {
        openIncidentFrom: form.openIncidentFrom, groupBy: form.groupBy,
        openDelaySeconds: form.openDelaySeconds, autoResolve: form.autoResolve,
        suppressUpstreamHops: form.suppressUpstreamHops, flapThreshold: form.flapThreshold,
        flapWindowMinutes: form.flapWindowMinutes, retentionDays: form.retentionDays,
        severityMap: JSON.stringify(form.severityMap),
      } } })
      toast.success(t('toast.events.policySaved'))
      setMapError(null)
    } catch (err) { toast.error(t('toast.events.policySaveFailed', { error: errorMessage(err) })) }
  }

  const numberField = (key: keyof FormState, labelKey: string, min = 0) => (
    <div>
      <FieldLabel htmlFor={fid(key)}>{t(labelKey)}</FieldLabel>
      <Input id={fid(key)} type="number" min={min} value={String(form[key])} onChange={setNum(key)} disabled={saving} />
    </div>
  )

  return (
    <PageContainer>
      <div style={{ marginBottom: 24 }}>
        <PageTitle icon={<Radar size={22} color="var(--color-icon-accent)" />}>{t('events.policy.title')}</PageTitle>
        <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', marginTop: 4, marginBottom: 0 }}>{t('events.policy.subtitle')}</p>
      </div>

      {mapError && (
        <div role="alert" style={{ background: 'var(--color-warning-bg)', border: '1px solid #fbbf24', borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 'var(--font-size-body)', color: '#92400e' }}>
          {t('events.policy.severityMapInvalid', { error: mapError })}
        </div>
      )}

      <div style={{ background: '#fff', border: '1px solid var(--border)', borderRadius: 10, padding: 20, maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div>
            <FieldLabel htmlFor={fid('openIncidentFrom')}>{t('events.policy.openIncidentFrom')}</FieldLabel>
            <Select id={fid('openIncidentFrom')} value={form.openIncidentFrom} onChange={(e) => set('openIncidentFrom', e.target.value)} disabled={saving}>
              {OPEN_FROM.map((v) => <option key={v} value={v}>{t(`events.policy.openFrom.${v}`)}</option>)}
            </Select>
          </div>
          <div>
            <FieldLabel htmlFor={fid('groupBy')}>{t('events.policy.groupBy')}</FieldLabel>
            <Select id={fid('groupBy')} value={form.groupBy} onChange={(e) => set('groupBy', e.target.value)} disabled={saving}>
              {GROUP_BY.map((v) => <option key={v} value={v}>{t(`events.policy.groupByOptions.${v}`)}</option>)}
            </Select>
          </div>
          {numberField('openDelaySeconds', 'events.policy.openDelaySeconds')}
          {numberField('suppressUpstreamHops', 'events.policy.suppressUpstreamHops')}
          {numberField('flapThreshold', 'events.policy.flapThreshold', 1)}
          {numberField('flapWindowMinutes', 'events.policy.flapWindowMinutes', 1)}
          {numberField('retentionDays', 'events.policy.retentionDays', 1)}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 18 }}>
            <Toggle checked={form.autoResolve} onChange={(v) => set('autoResolve', v)} label={t('events.policy.autoResolve')} disabled={saving} />
            <span style={{ fontSize: 'var(--font-size-body)', color: colors.slateDark }}>{t('events.policy.autoResolve')}</span>
          </div>
        </div>

        <div>
          <div style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: colors.slateDark, marginBottom: 8 }}>{t('events.policy.severityMap')}</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-size-body)' }}>
            <thead>
              <tr>
                {['severity', 'impact', 'urgency'].map((h) => (
                  <th key={h} scope="col" style={{ textAlign: 'left', padding: '4px 8px', color: colors.slateLight, fontWeight: 500, fontSize: 'var(--font-size-label)', textTransform: 'uppercase', borderBottom: `1px solid ${colors.border}` }}>
                    {t(`events.policy.map.${h}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {EVENT_SEVERITIES.map((sev) => (
                <tr key={sev}>
                  <td style={{ padding: '6px 8px', fontWeight: 500, color: colors.slateDark }}>{t(`events.severity.${sev}`)}</td>
                  {(['impact', 'urgency'] as const).map((field) => (
                    <td key={field} style={{ padding: '6px 8px' }}>
                      <Select aria-label={`${t(`events.severity.${sev}`)} – ${t(`events.policy.map.${field}`)}`} value={form.severityMap[sev][field]} onChange={(e) => setMap(sev, field, e.target.value as Level)} disabled={saving}>
                        {LEVELS.map((l) => <option key={l} value={l}>{t(`events.policy.level.${l}`)}</option>)}
                      </Select>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button disabled={saving} icon={saving ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : undefined} onClick={() => void handleSave()}>
            {t('common.save')}
          </Button>
        </div>
      </div>
    </PageContainer>
  )
}
