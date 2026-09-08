// ── Shared sub-components and utilities for ProblemDetailPage ─────────────────

// ── Utilities ─────────────────────────────────────────────────────────────────
// Date: unica implementazione in lib/datetime.
export { formatDateTime as formatDate, timeAgo } from '@/lib/datetime'

// ── Constants ─────────────────────────────────────────────────────────────────

export const PRIORITY_COLOR: Record<string, string> = {
  critical: 'var(--color-trigger-sla-breach)', high: 'var(--color-brand)', medium: '#ca8a04', low: 'var(--color-success)',
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

