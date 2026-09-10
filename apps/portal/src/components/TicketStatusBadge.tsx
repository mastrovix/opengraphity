import { useTranslation } from 'react-i18next'
import { colors, palette } from '@/lib/tokens'

const STATUS_COLORS: Record<string, { bg: string; color: string }> = {
  new:         { bg: palette.info.bg, color: palette.info.text },
  open:        { bg: palette.info.bg, color: palette.info.text },
  assigned:    { bg: colors.brandLight, color: colors.brand },
  in_progress: { bg: palette.orange.bg, color: palette.orange.text },
  escalated:   { bg: palette.danger.bg, color: palette.danger.dark },
  pending:     { bg: palette.warning.bg, color: palette.warning.dark },
  resolved:    { bg: palette.success.bg, color: palette.success.text },
  closed:      { bg: colors.slateBg, color: colors.slate },
}

interface Props {
  status: string
  size?: 'sm' | 'md'
}

export function TicketStatusBadge({ status, size = 'sm' }: Props) {
  const { t } = useTranslation()
  const style = STATUS_COLORS[status] ?? { bg: colors.slateBg, color: colors.slate }
  const label = t(`ticket.status.${status}`, { defaultValue: status })

  return (
    <span style={{
      display:         'inline-flex',
      alignItems:      'center',
      padding:         size === 'md' ? '4px 12px' : '2px 8px',
      borderRadius:    100,
      fontSize:        size === 'md' ? 13 : 11,
      fontWeight:      600,
      backgroundColor: style.bg,
      color:           style.color,
      whiteSpace:      'nowrap',
    }}>
      {label}
    </span>
  )
}
