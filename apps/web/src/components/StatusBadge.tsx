import { colors } from '@/lib/tokens'

export function StatusBadge({ value }: { value: string }) {
  return <span style={{ color: colors.slate }}>{value.replace(/_/g, ' ')}</span>
}
