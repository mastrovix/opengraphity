/**
 * Pezzi condivisi delle pagine di Monitoraggio (sorgenti, procedura guidata,
 * modifica): metadati degli strumenti (icona + chiavi i18n), badge dello
 * strumento, pulsante "copia", riquadro per URL/token con copia.
 */
import type { ComponentType, CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { BellRing, ChartLine, ServerCog, Dog, Gauge, Webhook, Copy } from 'lucide-react'
import { Pill } from '@/components/ui/Pill'
import { Button } from '@/components/Button'
import { lookupOrError } from '@/lib/tokens'
import { colors } from '@/lib/tokens'
import type { ConnectorKind } from '@/types/events'

interface ToolMeta {
  icon:  ComponentType<{ size?: number; color?: string; 'aria-hidden'?: boolean | 'true' }>
  color: string
}

/** Icona e colore per strumento; nome e descrizione stanno in i18n (`monitoring.tools.<kind>`). */
export const TOOL_META: Record<ConnectorKind, ToolMeta> = {
  alertmanager: { icon: BellRing,  color: '#e6522c' },
  grafana:      { icon: ChartLine, color: '#f46800' },
  zabbix:       { icon: ServerCog, color: '#d40000' },
  datadog:      { icon: Dog,       color: '#632ca6' },
  dynatrace:    { icon: Gauge,     color: '#1496ff' },
  generic:      { icon: Webhook,   color: '#0284c7' },
}

const BROKEN: ToolMeta = { icon: Webhook, color: 'var(--color-danger)' }

export function toolMeta(kind: string | null): ToolMeta {
  return lookupOrError(TOOL_META, kind ?? '', 'TOOL_META', BROKEN)
}

/** "Alertmanager" con icona; un connectorKind fuori vocabolario è rosso e loggato (lookupOrError). */
export function ToolBadge({ kind }: { kind: ConnectorKind | null }) {
  const { t } = useTranslation()
  const meta = toolMeta(kind)
  const Icon = meta.icon
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: colors.slateDark, fontSize: 'var(--font-size-body)' }}>
      <Icon size={14} color={meta.color} aria-hidden="true" />
      {kind ? t(`monitoring.tools.${kind}.name`) : '—'}
    </span>
  )
}

export function EnabledPill({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation()
  return enabled
    ? <Pill bg="#dcfce7" color="#15803d" style={{ fontSize: 'var(--font-size-label)' }}>{t('monitoring.sources.active')}</Pill>
    : <Pill bg="var(--color-slate-bg)" color="var(--color-slate)" style={{ fontSize: 'var(--font-size-label)' }}>{t('monitoring.sources.inactive')}</Pill>
}

/** Copia negli appunti con toast; l'errore (clipboard negata) è mostrato, non ingoiato. Torna true solo se la copia è riuscita. */
export async function copyToClipboard(text: string, successMessage: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(successMessage)
    return true
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e))
    return false
  }
}

/** `onCopied` scatta solo a copia riuscita: la procedura guidata lo usa per sapere se il token è stato messo al sicuro (D·1.9). */
export function CopyButton({ text, label, size = 'xs', onCopied }: { text: string; label: string; size?: 'xs' | 'sm'; onCopied?: () => void }) {
  const { t } = useTranslation()
  const copy = async () => {
    if (await copyToClipboard(text, t('toast.monitoring.copied'))) onCopied?.()
  }
  return (
    <Button variant="secondary" size={size} icon={<Copy size={13} aria-hidden="true" />} onClick={() => void copy()}>
      {label}
    </Button>
  )
}

const monoBox: CSSProperties = {
  fontFamily: 'monospace', fontSize: 'var(--font-size-body)', color: colors.slateDark,
  background: 'var(--color-slate-bg)', border: `1px solid ${colors.border}`, borderRadius: 6,
  padding: '8px 10px', wordBreak: 'break-all', flex: 1, minWidth: 0, margin: 0,
}

/** Etichetta + valore monospazio + copia (URL dell'endpoint, token). */
export function SecretBox({ label, value, copyLabel, hint, onCopied }: { label: string; value: string; copyLabel: string; hint?: string; onCopied?: () => void }) {
  return (
    <div>
      <div style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, color: colors.slateLight, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>{label}</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
        <output style={monoBox} aria-label={label}>{value}</output>
        <CopyButton text={value} label={copyLabel} onCopied={onCopied} />
      </div>
      {hint && <p style={{ margin: '6px 0 0', fontSize: 'var(--font-size-table)', color: '#b45309' }}>{hint}</p>}
    </div>
  )
}

/** Blocco di configurazione pronto (YAML/JSON/curl) con pulsante copia. */
export function SnippetBox({ title, text, copyLabel, onCopied }: { title: string; text: string; copyLabel: string; onCopied?: () => void }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: colors.slateDark }}>{title}</span>
        <CopyButton text={text} label={copyLabel} onCopied={onCopied} />
      </div>
      <pre style={{ ...monoBox, whiteSpace: 'pre-wrap', overflowX: 'auto', fontSize: 'var(--font-size-table)', lineHeight: 1.5 }}>{text}</pre>
    </div>
  )
}

export const hintStyle: CSSProperties = { margin: 0, fontSize: 'var(--font-size-table)', color: colors.slateLight, lineHeight: 1.5 }
export const sectionTitleStyle: CSSProperties = { margin: '0 0 4px', fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: colors.slateDark }
