import { Pill } from '@/components/ui/Pill'
import { palette } from '@/lib/tokens'

interface CountBadgeProps {
  count: number
}

export function CountBadge({ count }: CountBadgeProps) {
  return (
    <Pill bg={palette.neutral.surface2} color="var(--color-slate-light)" radius={100} style={{ justifyContent:  'center', fontSize:        11, fontWeight:      600, marginLeft:      6, verticalAlign:   'middle' }}>
      {count}
    </Pill>
  )
}
