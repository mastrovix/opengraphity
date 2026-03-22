export function StatusBadge({ value }: { value: string }) {
  return <span style={{ color: '#64748b' }}>{value.replace(/_/g, ' ')}</span>
}
