const COLORS: Record<string, { bg: string; text: string; dot: string }> = {
  open:             { bg: '#eef2ff', text: '#4f46e5', dot: '#4f46e5' },
  resolved:         { bg: '#ecfdf5', text: '#059669', dot: '#059669' },
  completed:        { bg: '#ecfdf5', text: '#059669', dot: '#059669' },
  fulfilled:        { bg: '#ecfdf5', text: '#059669', dot: '#059669' },
  in_progress:      { bg: '#f5f3ff', text: '#7c3aed', dot: '#7c3aed' },
  pending_approval: { bg: '#fffbeb', text: '#d97706', dot: '#d97706' },
  known_error:      { bg: '#fffbeb', text: '#d97706', dot: '#d97706' },
  approved:         { bg: '#ecfdf5', text: '#059669', dot: '#059669' },
  deployed:         { bg: '#f5f3ff', text: '#7c3aed', dot: '#7c3aed' },
  rejected:         { bg: '#fef2f2', text: '#dc2626', dot: '#dc2626' },
  failed:           { bg: '#fef2f2', text: '#dc2626', dot: '#dc2626' },
  closed:           { bg: '#f1f3f9', text: '#8892a4', dot: '#8892a4' },
  cancelled:        { bg: '#f1f3f9', text: '#8892a4', dot: '#8892a4' },
}

export function StatusBadge({ value }: { value: string }) {
  const c = COLORS[value] ?? { bg: '#f1f3f9', text: '#8892a4', dot: '#8892a4' }
  const label = value.replace(/_/g, ' ')
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
      {label}
    </span>
  )
}
