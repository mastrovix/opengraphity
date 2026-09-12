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
 * Revisione D: con «Mai» i campi che dipendono dall'apertura sono disabilitati
 * con la nota del perché (D·2.5); indicatore "modifiche non salvate" e
 * "Ripristina", Salva attivo solo con modifiche; dopo il salvataggio la
 * risposta finisce nella cache di GET_EVENT_POLICY, così console e dettaglio
 * evento (cache-first) leggono subito la policy nuova (D·1.5).
 * Revisione 2 (D6.3): riquadro «Ciclo di vita del CI» con la scelta multipla
 * «Stati del ciclo di vita da ignorare» (`ignoreLifecycleStatuses`). Il
 * vocabolario è quello del metamodello (`useCIBaseEnums`), non una lista
 * scritta qui: se il metamodello non lo fornisce lo si dice (fail-loud) e uno
 * stato salvato che il metamodello non conosce resta spuntabile, marcato
 * «Sconosciuto: <valore>».
 */
import { useEffect, useId, useMemo, useState } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Radar, Loader2, Info, RotateCcw } from 'lucide-react'
import i18n from '@/i18n/i18n'
import { PageContainer } from '@/components/PageContainer'
import { PageTitle } from '@/components/PageTitle'
import { PageLoader } from '@/components/PageLoader'
import { QueryError } from '@/components/QueryError'
import { Button } from '@/components/Button'
import { Input, Select, FieldLabel } from '@/components/ui/FormControls'
import { Toggle } from '@/components/ui/Toggle'
import { errorMessage } from '@/hooks/useMutationWithToast'
import { enumLabel, useCIBaseEnums } from '@/lib/ciEnums'
import { GET_EVENT_POLICY } from '@/graphql/queries'
import { UPDATE_EVENT_POLICY } from '@/graphql/mutations'
import { colors, palette } from '@/lib/tokens'
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
    if (parsed === null || typeof parsed !== 'object') return { map: DEFAULT_MAP, error: i18n.t('events.policy.errors.expectedObject') }
    const obj = parsed as Record<string, unknown>
    const map = { ...DEFAULT_MAP }
    for (const sev of EVENT_SEVERITIES) {
      const entry = obj[sev]
      if (entry === undefined) return { map: DEFAULT_MAP, error: i18n.t('events.policy.errors.missingSeverity', { severity: sev }) }
      const { impact, urgency } = (entry ?? {}) as Record<string, unknown>
      if (!isLevel(impact) || !isLevel(urgency)) return { map: DEFAULT_MAP, error: i18n.t('events.policy.errors.invalidLevel', { severity: sev }) }
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
  /** Stati del ciclo di vita ignorati dagli allarmi (D6.3): sempre nell'ordine del vocabolario, così il confronto con i valori letti è stabile. */
  ignoreLifecycleStatuses: string[]
  /** Ondata 7 · C-4: gli stati che contano come «ritirato» (fuori dal calcolo dei servizi). */
  retiredStatuses:      string[]
  /** Ondata 7 · C-4: gli stati che contano come «in manutenzione» (il monitoraggio non ne aggiorna la salute). */
  maintenanceStatuses:  string[]
  severityMap:          SeverityMap
}

/**
 * I tre campi che contengono valori di `ci_status`. La semantica del ciclo di
 * vita è dato del cliente (ondata 7 · C-4/A-14): prima quali stati contassero
 * come «ritirato» o «in manutenzione» era scritto nel codice dell'API, e un
 * valore rinominato nel Dizionario cambiava il comportamento in silenzio.
 */
const LIFECYCLE_FIELDS = ['ignoreLifecycleStatuses', 'retiredStatuses', 'maintenanceStatuses'] as const
type LifecycleField = (typeof LIFECYCLE_FIELDS)[number]

type NumberField = { [K in keyof FormState]: FormState[K] extends number ? K : never }[keyof FormState]

/** Minimo ammesso per ogni campo numerico (tutti interi; 0 dove "zero" ha un senso: nessun ritardo, nessun hop, tempeste spente). */
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
      ignoreLifecycleStatuses: [...p.ignoreLifecycleStatuses],
      retiredStatuses:     [...p.retiredStatuses],
      maintenanceStatuses: [...p.maintenanceStatuses],
      severityMap: map,
    },
    mapError: error,
  }
}

const HOW_IT_WORKS = ['threshold', 'grouping', 'autoResolve', 'changeWindow', 'lifecycle', 'flapping', 'storm'] as const

type GroupName = 'recognition' | 'incidents' | 'changeWindow' | 'lifecycle' | 'flapStorm' | 'retention'

/**
 * Riquadro titolato: un <fieldset> per gruppo. A livello di modulo (non
 * dentro la pagina) perché un componente ricreato a ogni render smonterebbe
 * gli input e farebbe perdere il focus a ogni tasto.
 */
function Group({ name, children }: { name: GroupName; children: React.ReactNode }) {
  const { t } = useTranslation()
  return (
    <fieldset style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '14px 18px 18px', margin: 0, background: colors.white }}>
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
  // Il vocabolario del ciclo di vita è quello del metamodello: se manca lo si dice (baseEnums.error), non si inventa una lista.
  const baseEnums = useCIBaseEnums()
  // EventPolicy non ha un id: senza `update` il risultato della mutation non
  // toccherebbe ROOT_QUERY.eventPolicy e le pagine cache-first resterebbero
  // sulla policy vecchia fino al ricaricamento (D·1.5).
  const [update, { loading: saving }] = useMutation<{ updateEventPolicy: EventPolicy }>(UPDATE_EVENT_POLICY, {
    update: (cache, { data: result }) => {
      if (result?.updateEventPolicy) cache.writeQuery({ query: GET_EVENT_POLICY, data: { eventPolicy: result.updateEventPolicy } })
    },
  })

  const [form, setForm] = useState<FormState | null>(null)
  const [mapError, setMapError] = useState<string | null>(null)

  // Il form parte dai dati del server; il salvataggio (via cache) riallinea.
  useEffect(() => {
    if (!data) return
    const { form: f, mapError: e } = toForm(data.eventPolicy)
    setForm(f); setMapError(e)
  }, [data])

  // Valori di riferimento per "modifiche non salvate" e "Ripristina".
  const baseline = useMemo(() => (data ? toForm(data.eventPolicy) : null), [data])

  if (error && !data) return <PageContainer><QueryError message={error.message} onRetry={() => void refetch()} /></PageContainer>
  if (loading && !form) return <PageLoader />
  if (!form || !baseline) return null

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => (f ? { ...f, [key]: value } : f))
  // Campo vuoto → NaN (non 0): la validazione lo segnala invece di salvare uno zero mai scritto.
  const setNum = (key: NumberField) => (e: React.ChangeEvent<HTMLInputElement>) => set(key, e.target.value.trim() === '' ? Number.NaN : Number(e.target.value))
  const setMap = (sev: EventSeverity, field: 'impact' | 'urgency', value: Level) =>
    setForm((f) => (f ? { ...f, severityMap: { ...f.severityMap, [sev]: { ...f.severityMap[sev], [field]: value } } } : f))

  const errors = validatePolicyForm(form)
  const invalid = Object.keys(errors).length > 0
  const dirty = JSON.stringify(form) !== JSON.stringify(baseline.form)
  // Una mappa non valida si salva anche senza altre modifiche: è il modo di correggerla.
  const canSave = !saving && !invalid && (dirty || mapError !== null)
  // Con «Mai» il monitoraggio non apre incident: raggruppamento, ritardo,
  // chiusura automatica e mappa severità non hanno effetto (D·2.5).
  const never = form.openIncidentFrom === 'never'

  const reset = () => { setForm(baseline.form); setMapError(baseline.mapError) }

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
        ignoreLifecycleStatuses: form.ignoreLifecycleStatuses,
        retiredStatuses:     form.retiredStatuses,
        maintenanceStatuses: form.maintenanceStatuses,
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
  const neverNoteId = fid('never-note')
  const Help = ({ field }: { field: keyof FormState }) => (
    <p id={helpId(field)} style={{ margin: '4px 0 0', fontSize: 'var(--font-size-label)', color: colors.slateLight, lineHeight: 1.5 }}>
      {t(`events.policy.help.${field}`)}
    </p>
  )

  /** `unusedWithNever`: il campo non ha effetto con «Mai» → disabilitato e descritto dalla nota. */
  const numberField = (key: NumberField, unusedWithNever = false) => {
    const err = errors[key]
    const off = unusedWithNever && never
    const describedBy = [err ? errorId(key) : null, helpId(key), off ? neverNoteId : null].filter(Boolean).join(' ')
    return (
      <div>
        <FieldLabel htmlFor={fid(key)}>{t(`events.policy.${key}`)}</FieldLabel>
        <Input
          id={fid(key)} type="number" min={MIN[key]} step={1}
          value={Number.isNaN(form[key]) ? '' : String(form[key])}
          onChange={setNum(key)} disabled={saving || off}
          aria-invalid={err ? true : undefined}
          aria-describedby={describedBy}
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

  /** Interruttore + testo: il nome accessibile è già sull'interruttore, il testo accanto è solo visivo (D·3.4). */
  const toggleRow = (key: 'autoResolve' | 'matchShortHostname', disabled: boolean) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <Toggle id={`policy-${key}`} checked={form[key]} onChange={(v) => set(key, v)} label={t(`events.policy.${key}`)} labelledBy={`policy-${key}-label`} disabled={disabled} />
      <label id={`policy-${key}-label`} htmlFor={`policy-${key}`} style={{ fontSize: 'var(--font-size-body)', color: disabled ? colors.slateLight : colors.slateDark, cursor: disabled ? 'default' : 'pointer' }}>{t(`events.policy.${key}`)}</label>
    </div>
  )

  /**
   * Opzioni della scelta multipla: il vocabolario del metamodello più gli
   * stati già salvati che il metamodello NON conosce — restano spuntati e
   * marcati «Sconosciuto: …», così nessun valore sparisce di nascosto.
   */
  const lifecycleOptions = [
    ...baseEnums.statuses,
    ...LIFECYCLE_FIELDS.flatMap((k) => form[k]).filter((s, i, all) => !baseEnums.statuses.includes(s) && all.indexOf(s) === i),
  ]
  const lifecycleLabel = (value: string) =>
    baseEnums.statuses.includes(value) ? enumLabel(value) : t('events.policy.lifecycleUnknown', { value })
  /** Spunta/despunta uno stato ricostruendo la lista nell'ordine delle opzioni: il confronto con i valori letti resta stabile. */
  const toggleLifecycle = (key: LifecycleField, value: string, on: boolean) =>
    set(key, lifecycleOptions.filter((s) => (s === value ? on : form[key].includes(s))))

  const grid = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 } as const

  return (
    <PageContainer>
      <div style={{ marginBottom: 24 }}>
        <PageTitle icon={<Radar size={22} color="var(--color-icon-accent)" />}>{t('events.policy.title')}</PageTitle>
        <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', marginTop: 4, marginBottom: 0 }}>{t('events.policy.subtitle')}</p>
      </div>

      {/* Come funziona: le sei regole della correlazione in parole. */}
      <section aria-labelledby={fid('how')} style={{ maxWidth: 760, marginBottom: 16, padding: '14px 18px', background: 'var(--color-brand-light)', border: `1px solid ${palette.info.border}`, borderRadius: 10 }}>
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
        <div role="alert" style={{ background: 'var(--color-warning-bg)', border: `1px solid ${palette.warning.border}`, borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 'var(--font-size-body)', color: palette.warning.strong }}>
          {t('events.policy.severityMapInvalid', { error: mapError })}
        </div>
      )}

      <div style={{ maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* 0. Riconoscimento del CI (A-2): nome corto ↔ FQDN */}
        <Group name="recognition">
          <div style={grid}>
            <div>
              {toggleRow('matchShortHostname', saving)}
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
              <Select id={fid('groupBy')} value={form.groupBy} onChange={(e) => set('groupBy', e.target.value)} disabled={saving || never} aria-describedby={never ? `${helpId('groupBy')} ${neverNoteId}` : helpId('groupBy')}>
                {GROUP_BY.map((v) => <option key={v} value={v}>{t(`events.policy.groupByOptions.${v}`)}</option>)}
              </Select>
              <Help field="groupBy" />
            </div>
            {numberField('openDelaySeconds', true)}
            <div style={{ paddingTop: 18 }}>
              {toggleRow('autoResolve', saving || never)}
              <Help field="autoResolve" />
            </div>
          </div>
          {never && (
            <p id={neverNoteId} role="note" style={{ margin: '12px 0 0', padding: '8px 12px', background: 'var(--color-slate-bg)', borderRadius: 8, fontSize: 'var(--font-size-body)', color: colors.slateDark }}>
              {t('events.policy.neverNote')}
            </p>
          )}

          <div style={{ marginTop: 16, opacity: never ? 0.6 : 1 }}>
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
                        <Select aria-label={`${t(`events.severity.${sev}`)} – ${t(`events.policy.map.${field}`)}`} value={form.severityMap[sev][field]} onChange={(e) => setMap(sev, field, e.target.value as Level)} disabled={saving || never} aria-describedby={never ? neverNoteId : undefined}>
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

        {/*
          2 bis. Ciclo di vita del CI: le tre liste che danno SIGNIFICATO ai
          valori di `ci_status`. Ondata 7 · C-4/A-14: «ritirato» e «in
          manutenzione» erano scritti nel codice dell'API, quindi un valore
          rinominato nel Dizionario cambiava in silenzio la salute dei servizi
          e l'apertura degli incident. Qui si vedono e si modificano, con i
          valori veri del vocabolario del cliente nelle spunte.
        */}
        <Group name="lifecycle">
          {LIFECYCLE_FIELDS.map((key) => (
            <div key={key} style={{ marginBottom: 16 }}>
              <FieldLabel><span id={fid(`${key}-label`)}>{t(`events.policy.${key}`)}</span></FieldLabel>
              <div
                role="group"
                aria-labelledby={fid(`${key}-label`)}
                aria-describedby={helpId(key)}
                style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 20px', marginTop: 4 }}
              >
                {lifecycleOptions.map((value) => (
                  <label key={value} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-body)', color: colors.slateDark, cursor: saving ? 'default' : 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={form[key].includes(value)}
                      disabled={saving}
                      onChange={(e) => toggleLifecycle(key, value, e.target.checked)}
                    />
                    {lifecycleLabel(value)}
                  </label>
                ))}
              </div>
              {/* Quanti stati sono spuntati: con nessuno si dice cosa comporta, non si lascia il vuoto. */}
              <p data-testid={`lifecycle-selected-${key}`} style={{ margin: '6px 0 0', fontSize: 'var(--font-size-label)', color: colors.slateLight }}>
                {form[key].length === 0
                  ? t(`events.policy.selectedNone.${key}`)
                  : t('events.policy.lifecycleSelected', { count: form[key].length })}
              </p>
              <Help field={key} />
            </div>
          ))}
          {/* Vocabolario assente: lo si dice, non si mostra un riquadro vuoto senza spiegazione. */}
          {baseEnums.error && (
            <p role="alert" style={{ margin: '6px 0 0', fontSize: 'var(--font-size-label)', color: colors.danger, fontWeight: 500 }}>
              {t('events.policy.lifecycleVocabularyUnavailable', { error: baseEnums.error })}
            </p>
          )}
          {!baseEnums.loading && !baseEnums.error && lifecycleOptions.length === 0 && (
            <p style={{ margin: '6px 0 0', fontSize: 'var(--font-size-label)', color: colors.slateLight }}>{t('events.policy.lifecycleEmptyVocabulary')}</p>
          )}
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
          {/* Stato del form annunciato (role="status"): modifiche non salvate / nulla da salvare / campi da correggere */}
          <span role="status" style={{ fontSize: 'var(--font-size-body)', color: invalid ? colors.danger : dirty ? palette.warning.text : colors.slateLight }}>
            {invalid ? t('events.policy.validation.blocked') : dirty ? t('events.policy.unsaved') : t('events.policy.noChanges')}
          </span>
          <Button variant="secondary" disabled={saving || !dirty} icon={<RotateCcw size={14} aria-hidden="true" />} onClick={reset}>
            {t('events.policy.reset')}
          </Button>
          <Button disabled={!canSave} icon={saving ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : undefined} onClick={() => void handleSave()}>
            {t('common.save')}
          </Button>
        </div>
      </div>
    </PageContainer>
  )
}
