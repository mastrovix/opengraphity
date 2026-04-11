// ── Shared sub-components and utilities for IncidentDetailPage ────────────────

// ── Utilities ─────────────────────────────────────────────────────────────────

export function formatDate(s: string): string {
  return new Date(s).toLocaleString('it-IT', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

export function timeAgo(s: string): string {
  const diff = Date.now() - new Date(s).getTime()
  const sec  = Math.floor(diff / 1000)
  if (sec < 60)             return 'adesso'
  const min = Math.floor(sec / 60)
  if (min < 60)             return `${min} min fa`
  const hrs = Math.floor(min / 60)
  if (hrs < 24)             return `${hrs} ore fa`
  const days = Math.floor(hrs / 24)
  if (days < 7)             return `${days} giorni fa`
  return formatDate(s)
}

// ── Card ──────────────────────────────────────────────────────────────────────

export function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      backgroundColor: '#fff',
      border:          '1px solid #e5e7eb',
      borderRadius:    10,
      boxShadow:       '0 1px 2px rgba(0,0,0,0.05)',
      padding:         '20px 24px',
      ...style,
    }}>
      {children}
    </div>
  )
}

// ── DetailRow ─────────────────────────────────────────────────────────────────

export function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </span>
      <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--text-primary)' }}>{children}</div>
    </div>
  )
}
