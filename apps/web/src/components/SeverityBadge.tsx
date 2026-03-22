import { colors } from '@/lib/tokens'

export function SeverityBadge({ value }: { value: string }) {
  return <span style={{ color: colors.slate, fontSize: 14 }}>{value}</span>
}
