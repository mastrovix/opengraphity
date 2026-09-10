/**
 * Procedura guidata "Aggiungi sorgente" (admin), 4 passi:
 *   1. Strumento  — Alertmanager / Grafana / Zabbix / Datadog / Dynatrace / Altro strumento
 *   2. Nome e regole (per "Altro strumento": Nome e mappatura) — nome; per
 *      generic il mappatore visuale con anteprima, per gli altri strumenti le
 *      regole facoltative (traduzione dei valori, risorsa e severità
 *      predefinite: PresetRules.tsx, A1)
 *   3. Collegamento — crea la sorgente e mostra UNA VOLTA URL, token e un
 *      frammento di configurazione pronto per lo strumento
 *   4. Prova — invia un evento di prova attraverso la pipeline reale e, dopo
 *      qualche secondo, interroga la sorgente per dire se è stato ricevuto o
 *      qual è l'ultimo errore (D·2.3)
 * Nessun JSON è visibile: i tre JSON li compongono buildSourceConfig /
 * buildPresetConfig (sourceConfig.ts).
 *
 * Revisione D: "Crea sorgente" resta bloccato finché, con un esempio
 * incollato, l'anteprima non è verde (D·1.10); dal passo Prova si torna al
 * Collegamento per rileggere il token (D·1.9); "Fine" o l'uscita chiedono
 * conferma se il token non è stato copiato e azzerano il token dallo stato (D·1.17).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useLazyQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ArrowLeft, Check, Loader2, Send, Radar, AlertTriangle, RefreshCw } from 'lucide-react'
import { PageContainer } from '@/components/PageContainer'
import { PageTitle } from '@/components/PageTitle'
import { Button } from '@/components/Button'
import { Input, FieldLabel } from '@/components/ui/FormControls'
import { useConfirm } from '@/hooks/useConfirm'
import { errorMessage } from '@/hooks/useMutationWithToast'
import { GET_MONITORING_SOURCES } from '@/graphql/queries'
import { CREATE_MONITORING_SOURCE, SEND_SAMPLE_EVENT } from '@/graphql/mutations'
import { formatDateTime } from '@/lib/datetime'
import { colors, palette } from '@/lib/tokens'
import { CONNECTOR_KINDS, type ConnectorKind, type MonitoringSource } from '@/types/events'
import { GenericMapper, type PreviewState } from './GenericMapper'
import { PresetRulesEditor } from './PresetRules'
import { DEFAULT_RATE_LIMIT_PER_MINUTE, EMPTY_MAPPING, EMPTY_PRESET_RULES, RATE_LIMIT_MAX, RATE_LIMIT_MIN, buildPresetConfig, buildSourceConfig, isMappingComplete, isPresetRulesComplete, parseRateLimit, type GenericMapping, type PresetRules } from './sourceConfig'
import { configSnippet, sourceEndpointUrl, ZABBIX_FIELDS } from './configSnippets'
import { TOOL_META, SecretBox, SnippetBox, hintStyle, sectionTitleStyle } from './monitoringShared'

const STEPS = ['tool', 'rules', 'connect', 'test'] as const
type Step = (typeof STEPS)[number]

/** Attesa prima di interrogare la sorgente dopo l'evento di prova: il job lo elabora in modo asincrono. */
export const SAMPLE_CHECK_DELAY_MS = 2500

interface CreatedSource { id: string; name: string; token: string }

/** Esito della verifica del passo Prova. */
type ReceptionCheck =
  | { status: 'idle' | 'checking' | 'pending' | 'notFound' }
  | { status: 'received'; when: string }
  | { status: 'error' | 'failed'; error: string }

interface Props {
  /** Solo per i test: attesa prima della verifica della ricezione. */
  sampleCheckDelayMs?: number
}

/** Etichetta del passo 2: "Nome e mappatura" per Altro strumento, "Nome e regole" per i preset (D·2.3). */
function stepLabelKey(step: Step, kind: ConnectorKind | null): string {
  return step === 'rules' && kind === 'generic' ? 'monitoring.wizard.steps.rulesGeneric' : `monitoring.wizard.steps.${step}`
}

export function NewSourceWizard({ sampleCheckDelayMs = SAMPLE_CHECK_DELAY_MS }: Props = {}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const confirm = useConfirm()
  const [stepIdx, setStepIdx] = useState(0)
  const [kind, setKind] = useState<ConnectorKind | null>(null)
  const [name, setName] = useState('')
  // Testo, non numero: un campo vuoto o "0" mentre si digita non deve diventare un limite.
  const [rateLimitText, setRateLimitText] = useState(String(DEFAULT_RATE_LIMIT_PER_MINUTE))
  const rateLimit = parseRateLimit(rateLimitText)
  const [mapping, setMapping] = useState<GenericMapping>(EMPTY_MAPPING)
  const [presetRules, setPresetRules] = useState<PresetRules>(EMPTY_PRESET_RULES)
  const [payload, setPayload] = useState('')
  const [previewState, setPreviewState] = useState<PreviewState>({ hasSample: false, ok: false, error: null })
  const [created, setCreated] = useState<CreatedSource | null>(null)
  const [tokenCopied, setTokenCopied] = useState(false)
  const [sampleCount, setSampleCount] = useState<number | null>(null)
  const [check, setCheck] = useState<ReceptionCheck>({ status: 'idle' })

  const [createSource, { loading: creating }] = useMutation<{ createInboundWebhook: CreatedSource }>(CREATE_MONITORING_SOURCE)
  const [sendSample, { loading: sending }] = useMutation<{ sendSampleEvent: number }>(SEND_SAMPLE_EVENT)
  const [loadSources] = useLazyQuery<{ monitoringSources: MonitoringSource[] }>(GET_MONITORING_SOURCES, { fetchPolicy: 'network-only' })

  const step: Step = STEPS[stepIdx]!
  const isGeneric = kind === 'generic'
  const toolName = kind ? t(`monitoring.tools.${kind}.name`) : ''

  /** Perché non si può andare avanti (null = si può). */
  const blocker: string | null =
    step === 'tool'  && !kind ? t('monitoring.wizard.toolRequired')
    : step === 'rules' && !name.trim() ? t('monitoring.wizard.nameRequired')
    : step === 'rules' && rateLimit === null ? t('monitoring.wizard.rateLimitInvalid', { min: RATE_LIMIT_MIN, max: RATE_LIMIT_MAX })
    : step === 'rules' && isGeneric && !isMappingComplete(mapping) ? t('monitoring.wizard.mappingIncomplete')
    : step === 'rules' && isGeneric && previewState.hasSample && !previewState.ok ? t('monitoring.wizard.previewNotGreen')
    : step === 'rules' && !isGeneric && !isPresetRulesComplete(presetRules) ? t('monitoring.wizard.presetRulesIncomplete')
    : null

  async function handleCreate() {
    if (!kind || rateLimit === null) return
    const config = kind === 'generic' ? buildSourceConfig(mapping) : buildPresetConfig(kind, presetRules)
    try {
      const res = await createSource({ variables: { input: { name: name.trim(), entityType: 'event', connectorKind: kind, rateLimitPerMinute: rateLimit, ...config } } })
      const src = res.data?.createInboundWebhook
      if (!src?.token) throw new Error(t('monitoring.errors.tokenMissing', { operation: 'createInboundWebhook' }))
      setCreated(src)
      setTokenCopied(false)
      toast.success(t('toast.monitoring.sourceCreated'))
      setStepIdx(2)
    } catch (e) {
      toast.error(t('monitoring.wizard.createFailed', { error: errorMessage(e) }))
    }
  }

  // ── Passo Prova: invio + verifica della ricezione dopo qualche secondo ──────
  const checkTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (checkTimer.current) clearTimeout(checkTimer.current) }, [])

  async function checkReception(sourceId: string) {
    setCheck({ status: 'checking' })
    try {
      const res = await loadSources()
      if (res.error) throw res.error
      if (!res.data) throw new Error(t('monitoring.errors.emptyResponse', { operation: 'monitoringSources' }))
      const src = res.data.monitoringSources.find((s) => s.id === sourceId)
      if (!src) { setCheck({ status: 'notFound' }); return }
      // lastError è il motivo dell'ULTIMO payload rifiutato e torna null al primo batch accettato.
      if (src.lastError) setCheck({ status: 'error', error: src.lastError })
      else if (src.lastReceivedAt) setCheck({ status: 'received', when: formatDateTime(src.lastReceivedAt) })
      else setCheck({ status: 'pending' })
    } catch (e) {
      setCheck({ status: 'failed', error: errorMessage(e) })
    }
  }

  async function handleSample() {
    if (!created) return
    try {
      const res = await sendSample({ variables: { sourceId: created.id } })
      const n = res.data?.sendSampleEvent
      if (typeof n !== 'number') throw new Error(t('monitoring.errors.emptyResponse', { operation: 'sendSampleEvent' }))
      setSampleCount(n)
      toast.success(t('toast.monitoring.sampleSent'))
      setCheck({ status: 'checking' })
      if (checkTimer.current) clearTimeout(checkTimer.current)
      const id = created.id
      checkTimer.current = setTimeout(() => { void checkReception(id) }, sampleCheckDelayMs)
    } catch (e) {
      toast.error(t('toast.monitoring.sampleFailed', { error: errorMessage(e) }))
    }
  }

  // ── Uscita: il token non copiato va confermato; poi non resta nello stato ───
  async function leave() {
    if (created && !tokenCopied) {
      const ok = await confirm({ title: t('monitoring.wizard.tokenNotCopiedTitle'), body: t('monitoring.wizard.tokenNotCopiedBody'), danger: true, confirmLabel: t('monitoring.wizard.leaveAnyway') })
      if (!ok) return
    }
    setCreated(null)
    navigate('/monitoring/sources')
  }

  const next = () => {
    if (step === 'rules') { void handleCreate(); return }
    setStepIdx((i) => Math.min(i + 1, STEPS.length - 1))
  }
  // Indietro: dal passo 2 al passo 1; dal passo Prova al Collegamento (la sorgente esiste già: mai al passo 2).
  const prev = () => setStepIdx((i) => Math.max(i - 1, 0))
  const canGoBack = step === 'rules' || step === 'test'

  return (
    <PageContainer>
      <Link to="/monitoring/sources" onClick={(e) => { if (created && !tokenCopied) { e.preventDefault(); void leave() } }} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 12, color: 'var(--text-muted)', textDecoration: 'none', fontSize: 'var(--font-size-card-title)' }}>
        <ArrowLeft size={14} aria-hidden="true" />{t('monitoring.wizard.back')}
      </Link>
      <PageTitle icon={<Radar size={22} color="var(--color-icon-accent)" />}>{t('monitoring.wizard.title')}</PageTitle>

      <WizardProgress current={stepIdx} kind={kind} />

      <section aria-labelledby="wizard-step-title" style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 10, padding: 20, marginTop: 16 }}>
        <h2 id="wizard-step-title" style={{ ...sectionTitleStyle, fontSize: 'var(--font-size-section-title)', marginBottom: 12 }}>
          {t('monitoring.wizard.stepOf', { step: stepIdx + 1, total: STEPS.length })} · {t(stepLabelKey(step, kind))}
        </h2>

        {step === 'tool' && (
          <>
            <p style={{ ...hintStyle, fontSize: 'var(--font-size-body)', marginBottom: 12 }}>{t('monitoring.wizard.toolIntro')}</p>
            <ToolPicker value={kind} onChange={(k) => { setKind(k); if (k !== 'generic') { setMapping(EMPTY_MAPPING); setPayload('') } else { setPresetRules(EMPTY_PRESET_RULES) } }} />
          </>
        )}

        {step === 'rules' && kind && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div style={{ maxWidth: 420 }}>
              <FieldLabel htmlFor="source-name">{t('monitoring.wizard.nameLabel')}</FieldLabel>
              <Input id="source-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('monitoring.wizard.namePlaceholder')} required />
              <p style={{ ...hintStyle, marginTop: 4 }}>{t('monitoring.wizard.nameHint')}</p>
            </div>
            <div style={{ maxWidth: 420 }}>
              <FieldLabel htmlFor="source-rate-limit">{t('monitoring.wizard.rateLimitLabel')}</FieldLabel>
              <Input id="source-rate-limit" type="number" inputMode="numeric" min={RATE_LIMIT_MIN} max={RATE_LIMIT_MAX} step={1} value={rateLimitText} onChange={(e) => setRateLimitText(e.target.value)} aria-invalid={rateLimit === null} required />
              <p style={{ ...hintStyle, marginTop: 4 }}>{t('monitoring.wizard.rateLimitHint', { min: RATE_LIMIT_MIN, max: RATE_LIMIT_MAX })}</p>
            </div>
            {kind === 'generic'
              ? <GenericMapper mapping={mapping} onChange={setMapping} payload={payload} onPayloadChange={setPayload} onPreviewState={setPreviewState} />
              : (
                <>
                  <p style={{ ...hintStyle, fontSize: 'var(--font-size-body)', padding: '10px 12px', background: 'var(--color-brand-light)', borderRadius: 8, color: palette.info.text }}>{t('monitoring.wizard.knownToolHint', { tool: toolName })}</p>
                  <PresetRulesEditor kind={kind} rules={presetRules} onChange={setPresetRules} />
                </>
              )}
          </div>
        )}

        {step === 'connect' && kind && created && (
          <ConnectStep kind={kind} created={created} payload={payload} onTokenCopied={() => setTokenCopied(true)} />
        )}

        {step === 'test' && created && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 640 }}>
            <p style={{ ...hintStyle, fontSize: 'var(--font-size-body)' }}>{t('monitoring.wizard.testIntro')}</p>
            <div>
              <Button icon={sending ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Send size={14} aria-hidden="true" />} disabled={sending} onClick={() => void handleSample()}>
                {t('monitoring.wizard.sendSample')}
              </Button>
            </div>
            {sampleCount !== null && (
              <p role="status" style={{ margin: 0, padding: '10px 12px', background: palette.success.tint, color: palette.success.text, borderRadius: 8, fontSize: 'var(--font-size-body)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Check size={14} aria-hidden="true" />
                {t('monitoring.wizard.sampleSent', { count: sampleCount })}
                <Link to={`/events?sourceId=${created.id}`} style={{ color: palette.success.text, fontWeight: 600 }}>{t('monitoring.wizard.openConsole')}</Link>
              </p>
            )}
            {check.status !== 'idle' && (
              <ReceptionStatus check={check} onCheckAgain={() => void checkReception(created.id)} />
            )}
          </div>
        )}

        {/* Navigazione */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 20, paddingTop: 16, borderTop: `1px solid ${colors.border}` }}>
          <div>
            {canGoBack && <Button variant="secondary" onClick={prev}>{t('common.prev')}</Button>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {/* role="status": il motivo del blocco è annunciato anche da tastiera (D·3.4) */}
            <span role="status" style={{ ...hintStyle, color: palette.warning.text }}>{blocker ?? ''}</span>
            {step === 'test'
              ? <Button onClick={() => void leave()}>{t('monitoring.wizard.finish')}</Button>
              : (
                <Button onClick={next} disabled={blocker !== null || creating} icon={creating ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : undefined}>
                  {step === 'rules' ? (creating ? t('monitoring.wizard.creating') : t('monitoring.wizard.create')) : t('common.next')}
                </Button>
              )}
          </div>
        </div>
      </section>
    </PageContainer>
  )
}

// ── Passo 4: esito della verifica ────────────────────────────────────────────

function ReceptionStatus({ check, onCheckAgain }: { check: ReceptionCheck; onCheckAgain: () => void }) {
  const { t } = useTranslation()
  const isError = check.status === 'error' || check.status === 'failed'
  const isOk = check.status === 'received'
  const text = (() => {
    switch (check.status) {
      case 'checking': return t('monitoring.wizard.checking')
      case 'received': return t('monitoring.wizard.checkReceived', { when: check.when })
      case 'error':    return t('monitoring.wizard.checkError', { error: check.error })
      case 'failed':   return t('monitoring.wizard.checkFailed', { error: check.error })
      case 'pending':  return t('monitoring.wizard.checkPending')
      case 'notFound': return t('monitoring.wizard.checkNotFound')
      default:         return ''
    }
  })()
  return (
    <div role="status" style={{ margin: 0, padding: '10px 12px', borderRadius: 8, fontSize: 'var(--font-size-body)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
      background: isError ? palette.danger.tint : isOk ? palette.success.tint : 'var(--color-slate-bg)', color: isError ? palette.danger.text : isOk ? palette.success.text : colors.slateDark }}>
      {check.status === 'checking' && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
      {isError && <AlertTriangle size={14} aria-hidden="true" />}
      {isOk && <Check size={14} aria-hidden="true" />}
      <span style={{ flex: 1, minWidth: 0, wordBreak: 'break-word' }}>{text}</span>
      {check.status !== 'checking' && (
        <Button variant="secondary" size="xs" icon={<RefreshCw size={12} aria-hidden="true" />} onClick={onCheckAgain}>{t('monitoring.wizard.checkNow')}</Button>
      )}
    </div>
  )
}

// ── Barra di avanzamento ─────────────────────────────────────────────────────

function WizardProgress({ current, kind }: { current: number; kind: ConnectorKind | null }) {
  const { t } = useTranslation()
  return (
    <ol aria-label={t('monitoring.wizard.progress')} style={{ display: 'flex', gap: 8, listStyle: 'none', margin: '16px 0 0', padding: 0 }}>
      {STEPS.map((s, i) => {
        const done = i < current
        const active = i === current
        return (
          <li key={s} aria-current={active ? 'step' : undefined} style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-size-body)', color: active ? colors.brand : done ? palette.success.text : colors.slateLight, fontWeight: active ? 600 : 400 }}>
            <span aria-hidden="true" style={{ width: 24, height: 24, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 'var(--font-size-table)', fontWeight: 700, background: active ? colors.brand : done ? palette.success.tint : 'var(--color-slate-bg)', color: active ? colors.white : done ? palette.success.text : colors.slate }}>
              {done ? <Check size={13} /> : i + 1}
            </span>
            <span style={{ whiteSpace: 'nowrap' }}>{t(stepLabelKey(s, kind))}</span>
            <span aria-hidden="true" style={{ flex: 1, height: 2, background: done ? palette.success.border : colors.border, borderRadius: 1 }} />
          </li>
        )
      })}
    </ol>
  )
}

// ── Passo 1: schede degli strumenti (scelta esclusiva: radiogroup, D·3.4) ────

function ToolPicker({ value, onChange }: { value: ConnectorKind | null; onChange: (k: ConnectorKind) => void }) {
  const { t } = useTranslation()
  return (
    <div role="radiogroup" aria-label={t('monitoring.wizard.toolGroup')} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
      {CONNECTOR_KINDS.map((k) => {
        const meta = TOOL_META[k]
        const Icon = meta.icon
        const selected = value === k
        return (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(k)}
            style={{
              textAlign: 'left', cursor: 'pointer', font: 'inherit', borderRadius: 10, padding: 14,
              border: selected ? `2px solid ${colors.brand}` : `1px solid ${colors.border}`,
              background: selected ? 'var(--color-brand-light)' : colors.white,
              display: 'flex', flexDirection: 'column', gap: 8,
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, color: colors.slateDark }}>
              <Icon size={18} color={meta.color} aria-hidden="true" />
              {t(`monitoring.tools.${k}.name`)}
            </span>
            <span style={{ ...hintStyle }}>{t(`monitoring.tools.${k}.description`)}</span>
          </button>
        )
      })}
    </div>
  )
}

// ── Passo 3: URL, token, frammento pronto ────────────────────────────────────

/** `onTokenCopied`: copia del token o del frammento (che lo contiene) riuscita. */
function ConnectStep({ kind, created, payload, onTokenCopied }: { kind: ConnectorKind; created: CreatedSource; payload: string; onTokenCopied: () => void }) {
  const { t } = useTranslation()
  const url = sourceEndpointUrl(created.id)
  const snippet = configSnippet(kind, url, created.token, payload)
  const toolName = t(`monitoring.tools.${kind}.name`)

  const instructions: ReactNode = (() => {
    switch (kind) {
      case 'alertmanager': return <p style={hintStyle}>{t('monitoring.snippets.alertmanager.intro')}</p>
      case 'grafana': return <Steps keys={['monitoring.snippets.grafana.step1', 'monitoring.snippets.grafana.step2', 'monitoring.snippets.grafana.step3', 'monitoring.snippets.grafana.step4']} />
      case 'zabbix': return (
        <>
          <Steps keys={['monitoring.snippets.zabbix.step1', 'monitoring.snippets.zabbix.step2', 'monitoring.snippets.zabbix.step3']} />
          <ul style={{ margin: '4px 0 8px', paddingLeft: 20, fontSize: 'var(--font-size-body)', color: colors.slateDark, columns: 2 }}>
            {ZABBIX_FIELDS.map(([f, m]) => <li key={f}><code>{f}</code> ← <code>{m}</code></li>)}
          </ul>
          <Steps keys={['monitoring.snippets.zabbix.step4']} start={4} />
        </>
      )
      case 'datadog': return <Steps keys={['monitoring.snippets.datadog.step1', 'monitoring.snippets.datadog.step2', 'monitoring.snippets.datadog.step3']} />
      case 'dynatrace': return <Steps keys={['monitoring.snippets.dynatrace.step1', 'monitoring.snippets.dynatrace.step2', 'monitoring.snippets.dynatrace.step3', 'monitoring.snippets.dynatrace.step4']} />
      case 'generic': return <p style={hintStyle}>{t('monitoring.snippets.generic.intro')}</p>
    }
  })()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 820 }}>
      <p style={{ ...hintStyle, fontSize: 'var(--font-size-body)' }}>{t('monitoring.wizard.connectIntro', { name: created.name, tool: toolName })}</p>
      <SecretBox label={t('monitoring.wizard.endpoint')} value={url} copyLabel={t('monitoring.wizard.copyEndpoint')} />
      <SecretBox label={t('monitoring.wizard.token')} value={created.token} copyLabel={t('monitoring.wizard.copyToken')} hint={t('monitoring.wizard.tokenOnce')} onCopied={onTokenCopied} />
      <div>
        <h3 style={sectionTitleStyle}>{t('monitoring.wizard.snippetTitle', { tool: toolName })}</h3>
        {instructions}
      </div>
      <SnippetBox title={toolName} text={snippet} copyLabel={t('monitoring.wizard.copySnippet')} onCopied={onTokenCopied} />
    </div>
  )
}

/** Elenco numerato di istruzioni; `keys` sono chiavi i18n complete (verificate da check-i18n tramite i letterali). */
function Steps({ keys, start = 1 }: { keys: string[]; start?: number }) {
  const { t } = useTranslation()
  return (
    <ol start={start} style={{ margin: '4px 0', paddingLeft: 20, fontSize: 'var(--font-size-body)', color: colors.slateDark, lineHeight: 1.6 }}>
      {keys.map((k) => <li key={k}>{t(k)}</li>)}
    </ol>
  )
}
