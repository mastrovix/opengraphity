interface DetailFieldProps {
  label: string
  value?: string | null
  mono?: boolean
}

export function DetailField({ label, value, mono }: DetailFieldProps) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{
        fontSize: 11, fontWeight: 600,
        color: '#8892a4', textTransform: 'uppercase',
        letterSpacing: '0.04em', marginBottom: 4
      }}>
        {label}
      </div>
      <div style={{
        fontSize: 13,
        color: value ? '#111827' : '#c4c9d4',
        fontFamily: mono ? 'monospace' : 'inherit'
      }}>
        {value || '—'}
      </div>
    </div>
  )
}
