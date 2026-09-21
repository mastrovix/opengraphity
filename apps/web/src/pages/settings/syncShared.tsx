import { useTranslation } from 'react-i18next'
import { RefreshCw, CheckCircle, XCircle, Clock, AlertTriangle, Database, Cloud } from 'lucide-react'
import type { SyncStats } from './useSyncPage'
import { lookupOrError, colors, palette } from '@/lib/tokens'
import { StatTile, StatTileGrid } from '@/components/ui/StatTile'

// ── Helpers ───────────────────────────────────────────────────────────────────

export function formatMs(ms: number | null): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

export function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation()
  const cfg: Record<string, { color: string; icon: React.ReactNode }> = {
    completed: { color: 'var(--color-success)', icon: <CheckCircle size={12} /> },
    running:   { color: colors.brand, icon: <RefreshCw size={12} style={{ animation: 'spin 1s linear infinite' }} /> },
    failed:    { color: 'var(--color-trigger-sla-breach)', icon: <XCircle size={12} /> },
    queued:    { color: palette.warning.text, icon: <Clock size={12} /> },
    open:      { color: palette.warning.text, icon: <AlertTriangle size={12} /> },
    resolved:  { color: 'var(--color-success)', icon: <CheckCircle size={12} /> },
  }
  const c = lookupOrError(cfg, status, 'StatusBadge:cfg', { color: colors.slate, icon: null as React.ReactNode })
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: c.color, fontSize: 'var(--font-size-body)', fontWeight: 500 }}>
      {c.icon}{status in cfg ? t(`pages.sync.status.${status as 'completed'}`) : status}
    </span>
  )
}

// ── StatsBar ──────────────────────────────────────────────────────────────────

export function StatsBar({ stats }: { stats: SyncStats }) {
  const { t } = useTranslation()
  // Il box numerico comune (components/ui/StatTile): qui c'era una versione
  // sua, con raggio 8 e l'icona accanto all'etichetta — e le etichette erano
  // parole inglesi scritte nel codice.
  const cards = [
    { labelKey: 'sync.stats.sources',       value: `${stats.enabledSources}/${stats.totalSources}`, icon: <Database size={18} /> },
    { labelKey: 'sync.stats.ciManaged',     value: stats.ciManaged,    icon: <Cloud size={18} /> },
    { labelKey: 'sync.stats.openConflicts', value: stats.openConflicts, icon: <AlertTriangle size={18} /> },
    { labelKey: 'sync.stats.successRate',   value: `${Math.round(stats.successRate * 100)}%`, icon: <CheckCircle size={18} /> },
  ]
  return (
    <StatTileGrid>
      {cards.map(c => <StatTile key={c.labelKey} label={t(c.labelKey)} value={c.value} icon={c.icon} />)}
    </StatTileGrid>
  )
}

// ── Shared styles ─────────────────────────────────────────────────────────────

// Overrides on top of the shared FormControls base style (see ui/FormControls).
// `background: transparent` preserves the original look (no background was set).
export const inputStyle: React.CSSProperties = {
  display: 'block', marginBottom: 8, background: 'transparent',
}

export const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 'var(--font-size-body)', fontWeight: 500, color: palette.neutral.textMuted, marginBottom: 4,
}

export function btnStyle(bg: string, color: string): React.CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    background: bg, color, border: `1px solid ${color === colors.white ? bg : 'var(--border)'}`,
    borderRadius: 6, padding: '6px 12px', fontSize: 'var(--font-size-body)', cursor: 'pointer', fontWeight: 500,
  }
}
