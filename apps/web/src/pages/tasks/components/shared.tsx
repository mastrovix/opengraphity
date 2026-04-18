/**
 * Presentational + styling helpers shared by the TaskViewPage form modules.
 */

export const inputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 6,
  fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', boxSizing: 'border-box',
}

export const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 'var(--font-size-label)', fontWeight: 600,
  color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6,
}

export const KIND_TITLE: Record<string, string> = {
  assessment: 'Assessment', 'deploy-plan': 'Piano di Deploy',
  validation: 'Validation', deployment: 'Deployment', review: 'Review',
}

export function toLocal(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function fromLocal(v: string): string { return v ? new Date(v).toISOString() : '' }

export function StickyAction({ label, disabled, blockReason, onClick }: {
  label: string; disabled: boolean; blockReason?: string; onClick: () => void
}) {
  return (
    <div style={{ position: 'sticky', bottom: 0, background: '#fff', borderTop: '1px solid #e5e7eb', padding: '12px 0', marginTop: 20 }}>
      <button type="button" disabled={disabled} onClick={onClick} style={{
        width: '100%', padding: '12px 24px', borderRadius: 8, border: 'none',
        backgroundColor: 'var(--color-brand)', color: '#fff', fontSize: 'var(--font-size-card-title)',
        fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
      }}>
        {label}
      </button>
      {blockReason && <p style={{ margin: '6px 0 0', fontSize: 'var(--font-size-label)', color: 'var(--color-trigger-sla-breach)', textAlign: 'center' }}>{blockReason}</p>}
    </div>
  )
}
