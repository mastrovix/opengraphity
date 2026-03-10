const COLORS: Record<string, { bg: string; text: string; dot: string }> = {
  critical: { bg: '#fef2f2', text: '#dc2626', dot: '#dc2626' },
  high:     { bg: '#fffbeb', text: '#d97706', dot: '#d97706' },
  medium:   { bg: '#f0f9ff', text: '#0284c7', dot: '#0284c7' },
  low:      { bg: '#f1f3f9', text: '#8892a4', dot: '#8892a4' },
}

export function SeverityBadge({ value }: { value: string }) {
  const c = COLORS[value] ?? { bg: '#f1f3f9', text: '#8892a4', dot: '#8892a4' }
  return (
    <span
      style={{
        display:         'inline-flex',
        alignItems:      'center',
        gap:             5,
        padding:         '2px 8px',
        borderRadius:    100,
        backgroundColor: c.bg,
        fontSize:        12,
        fontWeight:      500,
        color:           c.text,
        textTransform:   'capitalize',
        whiteSpace:      'nowrap',
      }}
    >
      <span style={{ width: 5, height: 5, borderRadius: '50%', backgroundColor: c.dot, flexShrink: 0 }} />
      {value}
    </span>
  )
}
