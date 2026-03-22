// ── EmptyState — shared empty state component ─────────────────────────────────

interface EmptyStateProps {
  icon:         React.ReactNode
  title:        string
  description?: string
  action?:      React.ReactNode
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div style={{ textAlign: 'center', padding: '48px 24px' }}>
      <div style={{ color: 'var(--color-slate-light)', marginBottom: 12, display: 'flex', justifyContent: 'center', width: 48, height: 48, margin: '0 auto 12px' }}>
        {icon}
      </div>
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--color-slate)' }}>{title}</div>
      {description && (
        <div style={{ fontSize: 14, color: 'var(--color-slate-light)', marginTop: 4, maxWidth: 320, margin: '4px auto 0' }}>
          {description}
        </div>
      )}
      {action && <div style={{ marginTop: 16 }}>{action}</div>}
    </div>
  )
}
