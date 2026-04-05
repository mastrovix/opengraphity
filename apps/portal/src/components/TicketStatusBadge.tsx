import { useTranslation } from 'react-i18next'

const STATUS_COLORS: Record<string, { bg: string; color: string }> = {
  new:         { bg: '#EFF6FF', color: '#2563EB' },
  open:        { bg: '#EFF6FF', color: '#2563EB' },
  assigned:    { bg: '#F0F9FF', color: '#0EA5E9' },
  in_progress: { bg: '#FFF7ED', color: '#C2410C' },
  escalated:   { bg: '#FEF2F2', color: '#DC2626' },
  pending:     { bg: '#FFFBEB', color: '#D97706' },
  resolved:    { bg: '#F0FDF4', color: '#16A34A' },
  closed:      { bg: '#F1F5F9', color: '#64748B' },
}

interface Props {
  status: string
  size?: 'sm' | 'md'
}

export function TicketStatusBadge({ status, size = 'sm' }: Props) {
  const { t } = useTranslation()
  const colors = STATUS_COLORS[status] ?? { bg: '#F1F5F9', color: '#64748B' }
  const label  = t(`ticket.status.${status}`, { defaultValue: status })

  return (
    <span style={{
      display:         'inline-flex',
      alignItems:      'center',
      padding:         size === 'md' ? '4px 12px' : '2px 8px',
      borderRadius:    100,
      fontSize:        size === 'md' ? 13 : 11,
      fontWeight:      600,
      backgroundColor: colors.bg,
      color:           colors.color,
      whiteSpace:      'nowrap',
    }}>
      {label}
    </span>
  )
}
