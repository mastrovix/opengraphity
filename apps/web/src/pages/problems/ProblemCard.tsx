// ── Shared sub-components and utilities for ProblemDetailPage ─────────────────

// ── Utilities ─────────────────────────────────────────────────────────────────

export function formatDate(s: string): string {
  return new Date(s).toLocaleString('it-IT', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function timeAgo(s: string): string {
  const diff = Date.now() - new Date(s).getTime()
  const sec  = Math.floor(diff / 1000)
  if (sec < 60)          return 'adesso'
  const min = Math.floor(sec / 60)
  if (min < 60)          return `${min} min fa`
  const hrs = Math.floor(min / 60)
  if (hrs < 24)          return `${hrs} ore fa`
  const days = Math.floor(hrs / 24)
  if (days < 7)          return `${days} giorni fa`
  return formatDate(s)
}

// ── Constants ─────────────────────────────────────────────────────────────────

export const PRIORITY_COLOR: Record<string, string> = {
  critical: 'var(--color-trigger-sla-breach)', high: 'var(--color-brand)', medium: '#ca8a04', low: '#16a34a',
}

export const STATUS_BG: Record<string, string> = {
  new: 'var(--color-brand-light)', under_investigation: 'var(--color-brand-light)', change_requested: 'var(--color-brand-light)',
  change_in_progress: 'var(--color-brand-light)', resolved: 'var(--color-brand-light)', closed: 'var(--color-brand-light)',
  rejected: 'var(--color-brand-light)', deferred: 'var(--color-brand-light)',
}

export const STATUS_FG: Record<string, string> = {
  new: 'var(--color-brand)', under_investigation: 'var(--color-brand)', change_requested: 'var(--color-brand)',
  change_in_progress: 'var(--color-brand)', resolved: 'var(--color-brand)', closed: 'var(--color-brand)',
  rejected: 'var(--color-brand)', deferred: 'var(--color-brand)',
}

// ── Card ──────────────────────────────────────────────────────────────────────

export function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '20px 24px', ...style }}>
      {children}
    </div>
  )
}

// ── DetailRow ─────────────────────────────────────────────────────────────────

export function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</span>
      <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--text-primary)' }}>{children}</div>
    </div>
  )
}
