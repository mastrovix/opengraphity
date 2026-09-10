/**
 * Mappatore visuale del connettore `generic` (procedura guidata passo 2 e
 * pagina di modifica). L'amministratore incolla un allarme di esempio, sceglie
 * per titolo/severità/risorsa/… quale campo usare (dall'elenco dei campi
 * trovati o scrivendo il percorso a mano, così una sorgente esistente si
 * modifica anche senza un esempio sotto mano — D·2.2), traduce i valori
 * trovati, decide cosa usare quando un campo manca (default_values.severity /
 * status, D·1.2) e vede in tempo reale cosa diventa l'evento
 * (`previewInboundEvents`, "1 di N" se l'esempio contiene più allarmi).
 * Nessun JSON è mai visibile: lo costruisce `buildSourceConfig` da
 * `GenericMapping`.
 *
 * Lo stato (mapping + payload) è del genitore: la procedura guidata lo usa
 * anche per creare la sorgente e per il frammento curl. `onPreviewState`
 * riferisce al genitore se l'anteprima è "verde" (D·1.10): la procedura
 * guidata blocca "Crea sorgente" finché non lo è.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useLazyQuery, useMutation, useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Wand2, Plus, X, Loader2, AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/Button'
import { Input, Select, Textarea, FieldLabel } from '@/components/ui/FormControls'
import { errorMessage } from '@/hooks/useMutationWithToast'
import { GET_PAYLOAD_KEYS, GET_SAMPLE_INBOUND_PAYLOAD } from '@/graphql/queries'
import { PREVIEW_INBOUND_EVENTS } from '@/graphql/mutations'
import { colors, palette } from '@/lib/tokens'
import { EventSeverityBadge, EventStatusBadge } from '@/pages/events/eventShared'
import {
  EVENT_SEVERITIES, EVENT_INPUT_STATUSES, RESOURCE_KINDS,
  type PayloadKey, type NormalizedEventPreview, type EventSeverity, type EventInputStatus, type ResourceKind,
} from '@/types/events'
import {
  MAPPER_FIELDS, REQUIRED_MAPPER_FIELDS, buildSourceConfig, distinctValuesAtPath, isMappingComplete, readablePath,
  suggestSeverity, suggestStatus, syncValueTable, type GenericMapping, type MapperField,
} from './sourceConfig'
import { hintStyle, sectionTitleStyle } from './monitoringShared'

const DEBOUNCE_MS = 300

/** Stato dell'anteprima riferito al genitore (D·1.10). */
export interface PreviewState {
  /** C'è un esempio incollato (anche non ancora valido). */
  hasSample: boolean
  /** L'anteprima mostra almeno un evento senza errori. */
  ok:        boolean
  error:     string | null
}

interface Props {
  mapping:         GenericMapping
  onChange:        (m: GenericMapping) => void
  payload:         string
  onPayloadChange: (p: string) => void
  onPreviewState?: (s: PreviewState) => void
}

/** JSON incollato → oggetto o errore in chiaro (mai un payload "vuoto" silenzioso). */
function parsePayload(raw: string): { value: unknown; error: string | null } {
  if (!raw.trim()) return { value: undefined, error: null }
  try { return { value: JSON.parse(raw), error: null } }
  catch (e) { return { value: undefined, error: e instanceof Error ? e.message : String(e) } }
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const h = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(h)
  }, [value, ms])
  return debounced
}

export function GenericMapper({ mapping, onChange, payload, onPayloadChange, onPreviewState }: Props) {
  const { t } = useTranslation()
  const uid = useId()
  const fid = (name: string) => `${uid}-${name}`

  const debouncedPayload = useDebounced(payload, DEBOUNCE_MS)
  const parsed = useMemo(() => parsePayload(debouncedPayload), [debouncedPayload])

  // ── Chiavi del payload (API: percorso puntato + valore di esempio) ──────────
  const { data: keysData, loading: keysLoading, error: keysError } = useQuery<{ payloadKeys: PayloadKey[] }>(GET_PAYLOAD_KEYS, {
    variables: { payload: debouncedPayload },
    skip: !debouncedPayload.trim() || parsed.error !== null,
  })
  const keys = keysData?.payloadKeys ?? []
  const inWord = t('monitoring.mapper.inWord')
  const optionLabel = (k: PayloadKey) => `${readablePath(k.path, inWord)}${k.sample ? ` — ${k.sample}` : ''}`

  // Apollo 4: `execute` di useLazyQuery rigetta in caso di errore (errorPolicy
  // predefinito), quindi il ramo `res.error` da solo non basta: senza il
  // try/catch "Usa esempio" fallirebbe in silenzio (D·1.6).
  const [loadSample, { loading: sampleLoading }] = useLazyQuery<{ sampleInboundPayload: string }>(GET_SAMPLE_INBOUND_PAYLOAD, { fetchPolicy: 'network-only' })
  const applySample = async () => {
    try {
      const res = await loadSample({ variables: { connectorKind: 'generic' } })
      if (res.error) throw res.error
      if (!res.data) throw new Error(t('monitoring.errors.emptyResponse', { operation: 'sampleInboundPayload' }))
      onPayloadChange(res.data.sampleInboundPayload)
    } catch (e) {
      toast.error(t('monitoring.mapper.sampleFailed', { error: errorMessage(e) }))
    }
  }

  // ── Modifiche al mapping ────────────────────────────────────────────────────
  const setField = (field: MapperField, path: string) => {
    const next: GenericMapping = { ...mapping, fields: { ...mapping.fields, [field]: path } }
    if (field === 'severity') {
      const found = distinctValuesAtPath(parsed.value, path)
      const table = syncValueTable<EventSeverity>({}, found, path)
      for (const v of found) table[v] = suggestSeverity(v)
      next.severityValues = table
    }
    if (field === 'status') {
      const found = distinctValuesAtPath(parsed.value, path)
      const table = syncValueTable<EventInputStatus>({}, found, path)
      for (const v of found) table[v] = suggestStatus(v)
      next.statusValues = table
    }
    onChange(next)
  }

  // Un nuovo esempio incollato può contenere valori nuovi per i campi già scelti.
  useEffect(() => {
    if (parsed.value === undefined) return
    const sevFound = distinctValuesAtPath(parsed.value, mapping.fields.severity)
    const stFound  = distinctValuesAtPath(parsed.value, mapping.fields.status)
    const sev = syncValueTable<EventSeverity>(mapping.severityValues, sevFound, mapping.fields.severity)
    const st  = syncValueTable<EventInputStatus>(mapping.statusValues, stFound, mapping.fields.status)
    for (const v of sevFound) if (sev[v] === '') sev[v] = suggestSeverity(v)
    for (const v of stFound)  if (st[v]  === '') st[v]  = suggestStatus(v)
    const changed = JSON.stringify(sev) !== JSON.stringify(mapping.severityValues) || JSON.stringify(st) !== JSON.stringify(mapping.statusValues)
    if (changed) onChange({ ...mapping, severityValues: sev, statusValues: st })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo al cambio dell'esempio
  }, [parsed.value])

  // ── Anteprima in tempo reale ────────────────────────────────────────────────
  const complete = isMappingComplete(mapping)
  const config = useMemo(() => buildSourceConfig(mapping), [mapping])
  const previewKey = useDebounced(`${debouncedPayload} ${config.fieldMapping} ${config.defaultValues} ${config.valueMapping}`, DEBOUNCE_MS)
  const [runPreview, { data: previewData, loading: previewLoading, error: previewError }] = useMutation<{ previewInboundEvents: NormalizedEventPreview[] }>(PREVIEW_INBOUND_EVENTS)
  const canPreview = complete && parsed.error === null && parsed.value !== undefined
  useEffect(() => {
    if (!canPreview) return
    void runPreview({ variables: { input: { connectorKind: 'generic', payload: debouncedPayload, ...config } } }).catch(() => { /* l'errore è in previewError */ })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- previewKey riassume payload+config (debounced)
  }, [previewKey, canPreview])
  const previews = useMemo(() => (canPreview ? previewData?.previewInboundEvents ?? [] : []), [canPreview, previewData])
  // "1 di N" quando l'esempio contiene più allarmi (D·2.2); si riparte dal primo a ogni nuova anteprima.
  const [previewIdx, setPreviewIdx] = useState(0)
  useEffect(() => { setPreviewIdx(0) }, [previewData])
  const previewPos = Math.min(previewIdx, Math.max(previews.length - 1, 0))
  const preview = previews[previewPos] ?? null
  const previewOk = canPreview && !previewLoading && !previewError && previews.length > 0

  // Stato dell'anteprima al genitore, solo quando cambia davvero (un genitore
  // che passa una funzione inline non deve innescare un ciclo di render).
  const onPreviewStateRef = useRef(onPreviewState)
  useEffect(() => { onPreviewStateRef.current = onPreviewState })
  const lastReported = useRef<string>('')
  useEffect(() => {
    const state: PreviewState = { hasSample: payload.trim() !== '', ok: previewOk, error: previewError?.message ?? null }
    const key = JSON.stringify(state)
    if (key === lastReported.current) return
    lastReported.current = key
    onPreviewStateRef.current?.(state)
  }, [payload, previewOk, previewError])

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 3fr) minmax(260px, 2fr)', gap: 20, alignItems: 'start' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        {/* Payload di esempio */}
        <div>
          <p style={{ ...hintStyle, marginBottom: 8 }}>{t('monitoring.mapper.intro')}</p>
          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
            <FieldLabel htmlFor={fid('payload')} style={{ marginBottom: 0 }}>{t('monitoring.mapper.payloadLabel')}</FieldLabel>
            <Button variant="secondary" size="xs" disabled={sampleLoading} icon={sampleLoading ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Wand2 size={13} aria-hidden="true" />} onClick={() => void applySample()}>
              {t('monitoring.mapper.useSample')}
            </Button>
          </div>
          <Textarea
            id={fid('payload')}
            value={payload}
            onChange={(e) => onPayloadChange(e.target.value)}
            placeholder={t('monitoring.mapper.payloadPlaceholder')}
            rows={8}
            spellCheck={false}
            style={{ fontFamily: 'monospace', fontSize: 'var(--font-size-table)' }}
          />
          {parsed.error && <p role="alert" style={{ ...hintStyle, color: colors.danger, marginTop: 4 }}>{t('monitoring.mapper.payloadInvalid', { error: parsed.error })}</p>}
          {keysError && <p role="alert" style={{ ...hintStyle, color: colors.danger, marginTop: 4 }}>{t('monitoring.mapper.keysError', { error: keysError.message })}</p>}
          {keysLoading && !keysData && <p style={{ ...hintStyle, marginTop: 4 }}>{t('monitoring.mapper.keysLoading')}</p>}
        </div>

        {/* Campi normalizzati: percorso scelto dall'elenco (datalist) o scritto a mano */}
        <div>
          <h3 style={sectionTitleStyle}>{t('monitoring.mapper.fieldsTitle')}</h3>
          <p style={hintStyle}>{keys.length === 0 ? t('monitoring.mapper.noKeys') : t('monitoring.mapper.fieldsIntro')}</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 8 }}>
            {MAPPER_FIELDS.map((field) => {
              const required = REQUIRED_MAPPER_FIELDS.includes(field)
              const current = mapping.fields[field]
              const listId = fid(`${field}-list`)
              return (
                <div key={field} style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 1fr) minmax(0, 2fr)', gap: 12, alignItems: 'start' }}>
                  <div>
                    <FieldLabel htmlFor={fid(field)}>
                      {t(`monitoring.mapper.fields.${field}`)}{required && <span style={{ color: colors.danger }}> *</span>}
                    </FieldLabel>
                    <p style={hintStyle}>{t(`monitoring.mapper.fieldHints.${field}`)}</p>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <Input
                      id={fid(field)} list={listId} value={current} onChange={(e) => setField(field, e.target.value)}
                      placeholder={t('monitoring.mapper.pathPlaceholder')} required={required} autoComplete="off" spellCheck={false}
                      style={{ fontFamily: 'monospace' }}
                    />
                    <datalist id={listId}>
                      {keys.map((k) => <option key={k.path} value={k.path}>{optionLabel(k)}</option>)}
                    </datalist>
                    {field === 'resource' && (
                      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 8, alignItems: 'center' }}>
                        <FieldLabel htmlFor={fid('resourceKind')} style={{ marginBottom: 0 }}>{t('monitoring.mapper.resourceKind')}</FieldLabel>
                        <Select id={fid('resourceKind')} value={mapping.resourceKind} onChange={(e) => onChange({ ...mapping, resourceKind: e.target.value as ResourceKind })} title={t('monitoring.mapper.resourceKindHint')}>
                          {RESOURCE_KINDS.map((k) => <option key={k} value={k}>{t(`monitoring.mapper.resourceKinds.${k}`)}</option>)}
                        </Select>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Traduzione dei valori */}
        <div>
          <h3 style={sectionTitleStyle}>{t('monitoring.mapper.translateTitle')}</h3>
          <p style={hintStyle}>{t('monitoring.mapper.translateIntro')}</p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 10 }}>
            <ValueTable<EventSeverity>
              title={t('monitoring.mapper.severityValues')}
              fieldPath={mapping.fields.severity}
              table={mapping.severityValues}
              targets={EVENT_SEVERITIES}
              targetLabel={(v) => t(`events.severity.${v}`)}
              onChange={(severityValues) => onChange({ ...mapping, severityValues })}
              idPrefix={fid('sev')}
            />
            <ValueTable<EventInputStatus>
              title={t('monitoring.mapper.statusValues')}
              fieldPath={mapping.fields.status}
              table={mapping.statusValues}
              targets={EVENT_INPUT_STATUSES}
              targetLabel={(v) => t(`events.status.${v}`)}
              onChange={(statusValues) => onChange({ ...mapping, statusValues })}
              idPrefix={fid('st')}
            />
          </div>
        </div>

        {/* Quando il campo manca: default_values.severity / status (D·1.2, D·2.5) */}
        <div>
          <h3 style={sectionTitleStyle}>{t('monitoring.mapper.defaultsTitle')}</h3>
          <p style={hintStyle}>{t('monitoring.mapper.defaultsIntro')}</p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 10 }}>
            <div>
              <FieldLabel htmlFor={fid('defaultSeverity')}>{t('monitoring.mapper.defaultSeverity')}</FieldLabel>
              <Select id={fid('defaultSeverity')} value={mapping.defaultSeverity} onChange={(e) => onChange({ ...mapping, defaultSeverity: e.target.value as EventSeverity | '' })}>
                <option value="">{t('monitoring.mapper.defaultSeverityNone')}</option>
                {EVENT_SEVERITIES.map((s) => <option key={s} value={s}>{t(`events.severity.${s}`)}</option>)}
              </Select>
            </div>
            <div>
              <FieldLabel htmlFor={fid('defaultStatus')}>{t('monitoring.mapper.defaultStatus')}</FieldLabel>
              <Select id={fid('defaultStatus')} value={mapping.defaultStatus} onChange={(e) => onChange({ ...mapping, defaultStatus: e.target.value as EventInputStatus | '' })}>
                <option value="">{t('monitoring.mapper.defaultStatusNone')}</option>
                {EVENT_INPUT_STATUSES.map((s) => <option key={s} value={s}>{t(`events.status.${s}`)}</option>)}
              </Select>
            </div>
          </div>
        </div>
      </div>

      {/* Anteprima */}
      <aside aria-label={t('monitoring.mapper.preview.title')} style={{ position: 'sticky', top: 16, background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 10, padding: 16 }}>
        <h3 style={sectionTitleStyle}>{t('monitoring.mapper.preview.title')}</h3>
        <p style={hintStyle}>{t('monitoring.mapper.preview.intro')}</p>
        <div style={{ marginTop: 12 }}>
          {!canPreview && <p style={hintStyle}>{t('monitoring.mapper.preview.empty')}</p>}
          {canPreview && previewLoading && !preview && <p style={hintStyle}><Loader2 size={13} className="animate-spin" aria-hidden="true" /> {t('monitoring.mapper.preview.loading')}</p>}
          {canPreview && previewError && (
            <p role="alert" style={{ ...hintStyle, color: colors.danger, display: 'flex', gap: 6 }}>
              <AlertTriangle size={14} aria-hidden="true" style={{ flexShrink: 0 }} />
              <span>{t('monitoring.mapper.preview.error', { error: previewError.message })}</span>
            </p>
          )}
          {previewOk && previews.length > 1 && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Button variant="icon" size="xs" aria-label={t('monitoring.mapper.preview.prev')} disabled={previewPos === 0} onClick={() => setPreviewIdx(previewPos - 1)}><ChevronLeft size={14} aria-hidden="true" /></Button>
                <span style={{ fontSize: 'var(--font-size-body)', color: colors.slateDark, fontVariantNumeric: 'tabular-nums' }}>{t('monitoring.mapper.preview.ofMany', { index: previewPos + 1, total: previews.length })}</span>
                <Button variant="icon" size="xs" aria-label={t('monitoring.mapper.preview.next')} disabled={previewPos >= previews.length - 1} onClick={() => setPreviewIdx(previewPos + 1)}><ChevronRight size={14} aria-hidden="true" /></Button>
              </div>
              <p style={{ ...hintStyle, marginTop: 4 }}>{t('monitoring.mapper.preview.multi', { total: previews.length })}</p>
            </div>
          )}
          {previewOk && preview && (
            <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px 12px', fontSize: 'var(--font-size-body)' }}>
              <dt style={{ color: colors.slateLight }}>{t('monitoring.mapper.preview.eventTitle')}</dt>
              <dd style={{ margin: 0, fontWeight: 600, color: colors.slateDark, display: 'flex', alignItems: 'center', gap: 6 }}>
                <CheckCircle2 size={14} color={palette.success.text} aria-hidden="true" />{preview.title}
              </dd>
              <dt style={{ color: colors.slateLight }}>{t('monitoring.mapper.preview.severity')}</dt>
              <dd style={{ margin: 0 }}><EventSeverityBadge severity={preview.severity as EventSeverity} /></dd>
              <dt style={{ color: colors.slateLight }}>{t('monitoring.mapper.preview.resource')}</dt>
              <dd style={{ margin: 0, color: colors.slateDark }}>{preview.resource} <span style={{ color: colors.slateLight }}>({t(`monitoring.mapper.resourceKinds.${preview.resourceKind}`)})</span></dd>
              <dt style={{ color: colors.slateLight }}>{t('monitoring.mapper.preview.status')}</dt>
              <dd style={{ margin: 0 }}><EventStatusBadge status={preview.status as 'firing' | 'resolved'} severity={preview.severity as EventSeverity} /></dd>
              {preview.description && <>
                <dt style={{ color: colors.slateLight }}>{t('monitoring.mapper.fields.description')}</dt>
                <dd style={{ margin: 0, color: colors.slate, whiteSpace: 'pre-wrap' }}>{preview.description}</dd>
              </>}
              {preview.externalId && <>
                <dt style={{ color: colors.slateLight }}>{t('monitoring.mapper.fields.externalId')}</dt>
                <dd style={{ margin: 0, fontFamily: 'monospace', color: colors.slate }}>{preview.externalId}</dd>
              </>}
            </dl>
          )}
        </div>
      </aside>
    </div>
  )
}

// ── Tabella "valore sorgente → valore OpenGrafo" ─────────────────────────────

interface ValueTableProps<T extends string> {
  title:       string
  /** Percorso del campo mappato (generic): vuoto = "scegli prima il campo". Assente (connettori preset, PresetRules) = la tabella è sempre attiva. */
  fieldPath?:  string
  table:       Record<string, T | ''>
  targets:     readonly T[]
  targetLabel: (v: T) => string
  onChange:    (table: Record<string, T | ''>) => void
  idPrefix:    string
  /** Testo sotto il titolo (usato dai preset per dire cosa lo strumento manda). */
  hint?:       string
}

/**
 * Condivisa con PresetRules.tsx: riga per valore con destinazione obbligatoria,
 * aggiunta manuale, rimozione. Gli id sono per indice (un valore sorgente con
 * spazi o simboli non produce id non validi, D·1.16); un valore senza
 * traduzione ha `aria-invalid` e il testo "manca la traduzione" (D·3.3).
 */
export function ValueTable<T extends string>({ title, fieldPath, table, targets, targetLabel, onChange, idPrefix, hint }: ValueTableProps<T>) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState('')
  const entries = Object.entries(table)
  const addId = `${idPrefix}-add`

  const add = () => {
    const v = draft.trim()
    if (!v || v in table) { setDraft(''); return }
    onChange({ ...table, [v]: '' })
    setDraft('')
  }
  const remove = (key: string) => {
    const next = { ...table }
    delete next[key]
    onChange(next)
  }

  return (
    <fieldset style={{ border: `1px solid ${colors.border}`, borderRadius: 8, padding: '10px 12px', margin: 0, minWidth: 0 }}>
      <legend style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, color: colors.slate, textTransform: 'uppercase', letterSpacing: '0.04em', padding: '0 4px' }}>{title}</legend>
      {hint && <p style={{ ...hintStyle, marginBottom: 8 }}>{hint}</p>}
      {fieldPath !== undefined && !fieldPath.trim() ? (
        <p style={hintStyle}>{t('monitoring.mapper.pickFieldFirst')}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {entries.map(([source, target], i) => {
            const id = `${idPrefix}-${i}`
            const missingId = `${id}-missing`
            return (
              <div key={source} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(110px, 1fr) auto', gap: 6, alignItems: 'start' }}>
                <label htmlFor={id} style={{ fontSize: 'var(--font-size-body)', color: colors.slateDark, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingTop: 6 }} title={source}>
                  {t('monitoring.mapper.valueBecomes', { value: source })}
                </label>
                <div style={{ minWidth: 0 }}>
                  <Select id={id} value={target} onChange={(e) => onChange({ ...table, [source]: e.target.value as T | '' })} required aria-invalid={target ? undefined : true} aria-describedby={target ? undefined : missingId} style={{ borderColor: target ? undefined : palette.warning.base }}>
                    <option value="">{t('monitoring.mapper.chooseTarget')}</option>
                    {targets.map((tv) => <option key={tv} value={tv}>{targetLabel(tv)}</option>)}
                  </Select>
                  {!target && <p id={missingId} style={{ ...hintStyle, color: palette.warning.text, marginTop: 2 }}>{t('monitoring.mapper.missingTarget')}</p>}
                </div>
                <Button variant="icon" size="xs" aria-label={t('monitoring.mapper.remove', { value: source })} onClick={() => remove(source)}>
                  <X size={12} aria-hidden="true" />
                </Button>
              </div>
            )
          })}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <Input id={addId} aria-label={t('monitoring.mapper.addValue')} placeholder={t('monitoring.mapper.addValuePlaceholder')} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }} />
            <Button variant="secondary" size="xs" icon={<Plus size={12} aria-hidden="true" />} onClick={add} disabled={!draft.trim()}>{t('monitoring.mapper.add')}</Button>
          </div>
        </div>
      )}
    </fieldset>
  )
}
