import { RefreshCw, CheckCircle, XCircle, Clock, AlertTriangle, Database, Cloud } from 'lucide-react'
import type { SyncStats } from './useSyncPage'

// ── Helpers ───────────────────────────────────────────────────────────────────

export function formatMs(ms: number | null): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

export function formatDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString()
}

export function StatusBadge({ status }: { status: string }) {
  const cfg: Record<string, { color: string; icon: React.ReactNode }> = {
    completed: { color: '#16a34a', icon: <CheckCircle size={12} /> },
    running:   { color: '#2563eb', icon: <RefreshCw size={12} style={{ animation: 'spin 1s linear infinite' }} /> },
    failed:    { color: '#dc2626', icon: <XCircle size={12} /> },
    queued:    { color: '#ca8a04', icon: <Clock size={12} /> },
    open:      { color: '#ca8a04', icon: <AlertTriangle size={12} /> },
    resolved:  { color: '#16a34a', icon: <CheckCircle size={12} /> },
  }
  const c = cfg[status] ?? { color: '#6b7280', icon: null }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: c.color, fontSize: 'var(--font-size-body)', fontWeight: 500 }}>
      {c.icon}{status}
    </span>
  )
}

// ── StatsBar ──────────────────────────────────────────────────────────────────

export function StatsBar({ stats }: { stats: SyncStats }) {
  const cards = [
    { label: 'Sources',        value: `${stats.enabledSources}/${stats.totalSources}`, icon: <Database size={16} /> },
    { label: 'CIs managed',   value: stats.ciManaged,    icon: <Cloud size={16} /> },
    { label: 'Open conflicts', value: stats.openConflicts, icon: <AlertTriangle size={16} /> },
    { label: 'Success rate',   value: `${Math.round(stats.successRate * 100)}%`, icon: <CheckCircle size={16} /> },
  ]
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
      {cards.map(c => (
        <div key={c.label} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: '12px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#6b7280', fontSize: 'var(--font-size-body)', marginBottom: 4 }}>
            {c.icon}{c.label}
          </div>
          <div style={{ fontSize: 'var(--font-size-page-title)', fontWeight: 700, color: '#111827' }}>{c.value}</div>
        </div>
      ))}
    </div>
  )
}

// ── Shared styles ─────────────────────────────────────────────────────────────

export const inputStyle: React.CSSProperties = {
  display: 'block', width: '100%', border: '1px solid #d1d5db',
  borderRadius: 6, padding: '6px 10px', fontSize: 'var(--font-size-body)', boxSizing: 'border-box',
  marginBottom: 8, outline: 'none',
}

export const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 'var(--font-size-body)', fontWeight: 500, color: '#374151', marginBottom: 4,
}

export function btnStyle(bg: string, color: string): React.CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    background: bg, color, border: `1px solid ${color === '#fff' ? bg : '#e5e7eb'}`,
    borderRadius: 6, padding: '6px 12px', fontSize: 'var(--font-size-body)', cursor: 'pointer', fontWeight: 500,
  }
}
