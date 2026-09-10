/**
 * Policy dell'Event Management (per tenant, solo admin): quando aprire un
 * incident, raggruppamento, ritardo di apertura, chiusura automatica,
 * soppressione a monte, sfarfallio, conservazione e la mappa
 * severità → impatto/urgenza (JSON nel contratto, tre righe di select qui).
 * Ondata 3: riquadro "Come funziona" in testa e una riga di aiuto sotto ogni
 * campo, così l'effetto di ogni scelta è detto in parole.
 * Ondata 4: campi raggruppati in riquadri (apertura/chiusura, silenzio in
 * finestra di change, sfarfallio e tempeste, conservazione), tre campi nuovi
 * (stabilità dello sfarfallio, soglia e cooldown della tempesta) e
 * validazione in pagina: interi ≥ 0, alcuni ≥ 1; con errori il salvataggio
 * è bloccato e il campo dice perché.
 * Revisione (A-2): riquadro "Riconoscimento del CI" con l'interruttore
 * "nome corto ↔ FQDN" (matchShortHostname).
 */
import { useEffect, useId, useState } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Radar, Loader2, Info } from 'lucide-react'
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
  flapStableMinutes:    number
  stormThresholdPerMinute: number
  stormCooldownMinutes: number
  retentionDays:        number
  matchShortHostname:   boolean
  severityMap:          SeverityMap
}

type NumberField = { [K in keyof FormState]: FormState[K] extends number ? K : never }[keyof FormState]

/** Minimo ammesso per ogni campo numerico (tutti interi; 0 dove "zero" ha un senso: nessun ritardo, nessun hop). */
const MIN: Record<NumberField, number> = {
  openDelaySeconds: 0, suppressUpstreamHops: 0, stormThresholdPerMinute: 0,
  flapThreshold: 1, flapWindowMinutes: 1, flapStableMinutes: 1, stormCooldownMinutes: 1, retentionDays: 1,
}

const NUMBER_FIELDS = Object.keys(MIN) as NumberField[]

type FieldErrors = Partial<Record<NumberField, { key: 'integer' | 'min'; min: number }>>

/** Errori di validazione per campo: intero e ≥ minimo. Vuoto = si può salvare. */
export function validatePolicyForm(form: Pick<FormState, NumberField>): FieldErrors {
  const errors: FieldErrors = {}
  for (const key of NUMBER_FIELDS) {
    const v = form[key]
    if (!Number.isInteger(v)) errors[key] = { key: 'integer', min: MIN[key] }
    else if (v < MIN[key])   errors[key] = { key: 'min', min: MIN[key] }
  }
  return errors
}

function toForm(p: EventPolicy): { form: FormState; mapError: string | null } {
  const { map, error } = parseSeverityMap(p.severityMap)
  return {
    form: {
      openIncidentFrom: p.openIncidentFrom, groupBy: p.groupBy,
      openDelaySeconds: p.openDelaySeconds, autoResolve: p.autoResolve,
      suppressUpstreamHops: p.suppressUpstreamHops, flapThreshold: p.flapThreshold,
      flapWindowMinutes: p.flapWindowMinutes, flapStableMinutes: p.flapStableMinutes,
      stormThresholdPerMinute: p.stormThresholdPerMinute, stormCooldownMinutes: p.stormCooldownMinutes,
      retentionDays: p.retentionDays,
      matchShortHostname: p.matchShortHostname,
      severityMap: map,
    },
    mapError: error,
  }
}

const HOW_IT_WORKS = ['threshold', 'grouping', 'autoResolve', 'changeWindow', 'flapping', 'storm'] as const

type GroupName = 'recognition' | 'incidents' | 'changeWindow' | 'flapStorm' | 'retention'

/**
 * Riquadro titolato: un <fieldset> per gruppo. A livello di modulo (non
 * dentro la pagina) perché un componente ricreato a ogni render smonterebbe
 * gli input e farebbe perdere il focus a ogni tasto.
 */
function Group({ name, children }: { name: GroupName; children: React.ReactNode }) {
  const { t } = useTranslation()
  return (
    <fieldset style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '14px 18px 18px', margin: 0, background: '#fff' }}>
      <legend style={{ padding: '0 6px', fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: colors.slateDark }}>{t(`events.policy.groups.${name}`)}</legend>
      {children}
    </fieldset>
  )
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
  // Campo vuoto → NaN (non 0): la validazione lo segnala invece di salvare uno zero mai scritto.
  const setNum = (key: NumberField) => (e: React.ChangeEvent<HTMLInputElement>) => set(key, e.target.value.trim() === '' ? Number.NaN : Number(e.target.value))
  const setMap = (sev: EventSeverity, field: 'impact' | 'urgency', value: Level) =>
    setForm((f) => (f ? { ...f, severityMap: { ...f.severityMap, [sev]: { ...f.severityMap[sev], [field]: value } } } : f))

  const errors = validatePolicyForm(form)
  const invalid = Object.keys(errors).length > 0

  async function handleSave() {
    if (!form || invalid || !data) return
    try {
      // expectedVersion = la versione letta: se un altro amministratore ha
      // salvato nel frattempo l'API rifiuta e il toast lo dice (niente lost update).
      await update({ variables: { input: {
        expectedVersion: data.eventPolicy.version,
        openIncidentFrom: form.openIncidentFrom, groupBy: form.groupBy,
        openDelaySeconds: form.openDelaySeconds, autoResolve: form.autoResolve,
        suppressUpstreamHops: form.suppressUpstreamHops, flapThreshold: form.flapThreshold,
        flapWindowMinutes: form.flapWindowMinutes, flapStableMinutes: form.flapStableMinutes,
        stormThresholdPerMinute: form.stormThresholdPerMinute, stormCooldownMinutes: form.stormCooldownMinutes,
        retentionDays: form.retentionDays,
        matchShortHostname: form.matchShortHostname,
        severityMap: JSON.stringify(form.severityMap),
      } } })
      toast.success(t('toast.events.policySaved'))
      setMapError(null)
    } catch (err) { toast.error(t('toast.events.policySaveFailed', { error: errorMessage(err) })) }
  }

  // Riga di aiuto sotto ogni campo: l'effetto della scelta in parole
  // (events.policy.help.<campo>), legata al controllo via aria-describedby.
  const helpId  = (key: keyof FormState) => `${fid(key)}-help`
  const errorId = (key: keyof FormState) => `${fid(key)}-error`
  const Help = ({ field }: { field: keyof FormState }) => (
    <p id={helpId(field)} style={{ margin: '4px 0 0', fontSize: 'var(--font-size-label)', color: colors.slateLight, lineHeight: 1.5 }}>
      {t(`events.policy.help.${field}`)}
    </p>
  )

  const numberField = (key: NumberField) => {
    const err = errors[key]
    return (
      <div>
        <FieldLabel htmlFor={fid(key)}>{t(`events.policy.${key}`)}</FieldLabel>
        <Input
          id={fid(key)} type="number" min={MIN[key]} step={1}
          value={Number.isNaN(form[key]) ? '' : String(form[key])}
          onChange={setNum(key)} disabled={saving}
          aria-invalid={err ? true : undefined}
          aria-describedby={err ? `${errorId(key)} ${helpId(key)}` : helpId(key)}
        />
        {err && (
          <p id={errorId(key)} role="alert" style={{ margin: '4px 0 0', fontSize: 'var(--font-size-label)', color: colors.danger, fontWeight: 500 }}>
            {t(`events.policy.validation.${err.key}`, { min: err.min })}
          </p>
        )}
        <Help field={key} />
      </div>
    )
  }

  const grid = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 } as const

  return (
    <PageContainer>
      <div style={{ marginBottom: 24 }}>
        <PageTitle icon={<Radar size={22} color="var(--color-icon-accent)" />}>{t('events.policy.title')}</PageTitle>
        <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', marginTop: 4, marginBottom: 0 }}>{t('events.policy.subtitle')}</p>
      </div>

      {/* Come funziona: le sei regole della correlazione in parole. */}
      <section aria-labelledby={fid('how')} style={{ maxWidth: 760, marginBottom: 16, padding: '14px 18px', background: 'var(--color-brand-light)', border: '1px solid #bae6fd', borderRadius: 10 }}>
        <h2 id={fid('how')} style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 8px', fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: colors.slateDark }}>
          <Info size={15} aria-hidden="true" color="var(--color-brand)" />
          {t('events.policy.howItWorks.title')}
        </h2>
        <ol style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 4, fontSize: 'var(--font-size-body)', color: colors.slateDark, lineHeight: 1.55 }}>
          {HOW_IT_WORKS.map((k) => (
            <li key={k}>
              <strong>{t(`events.policy.howItWorks.${k}Title`)}</strong> — {t(`events.policy.howItWorks.${k}`)}
            </li>
          ))}
        </ol>
      </section>

      {mapError && (
        <div role="alert" style={{ background: 'var(--color-warning-bg)', border: '1px solid #fbbf24', borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 'var(--font-size-body)', color: '#92400e' }}>
          {t('events.policy.severityMapInvalid', { error: mapError })}
        </div>
      )}

      <div style={{ maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* 0. Riconoscimento del CI (A-2): nome corto ↔ FQDN */}
        <Group name="recognition">
          <div style={grid}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Toggle checked={form.matchShortHostname} onChange={(v) => set('matchShortHostname', v)} label={t('events.policy.matchShortHostname')} disabled={saving} />
                <span style={{ fontSize: 'var(--font-size-body)', color: colors.slateDark }}>{t('events.policy.matchShortHostname')}</span>
              </div>
              <Help field="matchShortHostname" />
            </div>
          </div>
        </Group>

        {/* 1. Apertura e chiusura degli incident (+ mappa severità → impatto/urgenza) */}
        <Group name="incidents">
          <div style={grid}>
            <div>
              <FieldLabel htmlFor={fid('openIncidentFrom')}>{t('events.policy.openIncidentFrom')}</FieldLabel>
              <Select id={fid('openIncidentFrom')} value={form.openIncidentFrom} onChange={(e) => set('openIncidentFrom', e.target.value)} disabled={saving} aria-describedby={helpId('openIncidentFrom')}>
                {OPEN_FROM.map((v) => <option key={v} value={v}>{t(`events.policy.openFrom.${v}`)}</option>)}
              </Select>
              <Help field="openIncidentFrom" />
            </div>
            <div>
              <FieldLabel htmlFor={fid('groupBy')}>{t('events.policy.groupBy')}</FieldLabel>
              <Select id={fid('groupBy')} value={form.groupBy} onChange={(e) => set('groupBy', e.target.value)} disabled={saving} aria-describedby={helpId('groupBy')}>
                {GROUP_BY.map((v) => <option key={v} value={v}>{t(`events.policy.groupByOptions.${v}`)}</option>)}
              </Select>
              <Help field="groupBy" />
            </div>
            {numberField('openDelaySeconds')}
            <div style={{ paddingTop: 18 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Toggle checked={form.autoResolve} onChange={(v) => set('autoResolve', v)} label={t('events.policy.autoResolve')} disabled={saving} />
                <span style={{ fontSize: 'var(--font-size-body)', color: colors.slateDark }}>{t('events.policy.autoResolve')}</span>
              </div>
              <Help field="autoResolve" />
            </div>
          </div>

          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: colors.slateDark, marginBottom: 2 }}>{t('events.policy.severityMap')}</div>
            <p style={{ margin: '0 0 8px', fontSize: 'var(--font-size-label)', color: colors.slateLight, lineHeight: 1.5 }}>{t('events.policy.help.severityMap')}</p>
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
        </Group>

        {/* 2. Silenzio in finestra di change */}
        <Group name="changeWindow">
          <div style={grid}>
            {numberField('suppressUpstreamHops')}
          </div>
        </Group>

        {/* 3. Sfarfallio e tempeste */}
        <Group name="flapStorm">
          <div style={grid}>
            {numberField('flapThreshold')}
            {numberField('flapWindowMinutes')}
            {numberField('flapStableMinutes')}
            {numberField('stormThresholdPerMinute')}
            {numberField('stormCooldownMinutes')}
          </div>
        </Group>

        {/* 4. Conservazione */}
        <Group name="retention">
          <div style={grid}>
            {numberField('retentionDays')}
          </div>
        </Group>

        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 12 }}>
          {invalid && <span style={{ fontSize: 'var(--font-size-body)', color: colors.danger }}>{t('events.policy.validation.blocked')}</span>}
          <Button disabled={saving || invalid} icon={saving ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : undefined} onClick={() => void handleSave()}>
            {t('common.save')}
          </Button>
        </div>
      </div>
    </PageContainer>
  )
}
