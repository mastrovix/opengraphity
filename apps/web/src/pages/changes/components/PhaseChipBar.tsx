/**
 * Pure stepper-dots visualisation of the workflow progress.
 */
export function PhaseChipBar({ current, steps }: {
  current: string
  steps: Array<{ name: string; label: string; isTerminal: boolean }>
}) {
  if (steps.length === 0) return null
  const curIdx = steps.findIndex((s) => s.name === current)
  const terminal = steps.find((s) => s.name === current)?.isTerminal ?? false
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 0, width: '60%', margin: '20px auto 24px' }}>
      {steps.map((p, i) => {
        const isCur = !terminal && i === curIdx
        const isPast = terminal || i < curIdx
        const isLast = i === steps.length - 1
        const labelColor = isCur ? 'var(--color-brand)' : isPast ? 'var(--color-slate-dark)' : 'var(--color-slate-light)'
        const lineColor = isPast ? 'var(--color-brand)' : '#e5e7eb'
        const statusText = isPast ? 'completato' : isCur ? 'corrente' : 'in sospeso'
        return (
          <div key={p.name} title={`${p.label} — ${statusText}`} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', position: 'relative' }}>
            {!isLast && (
              <div style={{ position: 'absolute', top: 4, left: '50%', right: '-50%', height: 2, background: lineColor, zIndex: 0 }} />
            )}
            <div style={{
              width: 10, height: 10, borderRadius: '50%', zIndex: 1,
              backgroundColor: (isPast || isCur) ? 'var(--color-brand)' : '#e5e7eb',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: isCur ? '0 0 0 4px rgba(2,132,199,0.2)' : 'none',
            }}>
              {isPast && (
                <svg width={8} height={8} viewBox="0 0 8 8"><path d="M1 4L3 6L7 2" fill="none" stroke="#fff" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" /></svg>
              )}
            </div>
            <span style={{ marginTop: 6, fontSize: 11, fontWeight: 500, color: labelColor, textAlign: 'center', whiteSpace: 'nowrap' }}>
              {p.label}
            </span>
          </div>
        )
      })}
    </div>
  )
}
