import { useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router-dom'
import { PlusCircle, Search } from 'lucide-react'
import { GET_MY_TICKETS, GET_MY_TICKET_STATS, GET_ME } from '@/graphql/queries'
import { TicketStatusBadge } from '@/components/TicketStatusBadge'
import { KBSearchBar } from '@/components/KBSearchBar'
import { fmtRelative } from '@/lib/format'
import { colors, palette, alpha } from '@/lib/tokens'

interface Ticket {
  id: string; title: string; status: string; priority: string
  /** Categoria ed etichetta del passo nel workflow del cliente (ondata 7 · D-15). */
  statusCategory: string | null; statusLabel: string | null
  category: string; createdAt: string; updatedAt: string
}
interface Stats { open: number; inProgress: number; resolved: number; total: number }

export function HomePage() {
  const { t }     = useTranslation()
  const navigate  = useNavigate()

  const { data: meData }     = useQuery<{ me: { name: string; email: string } | null }>(GET_ME)
  const { data: statsData }  = useQuery<{ myTicketStats: Stats }>(GET_MY_TICKET_STATS)
  const { data: ticketData } = useQuery<{ myTickets: { items: Ticket[]; total: number } }>(
    GET_MY_TICKETS, { variables: { pageSize: 5 } },
  )

  const name    = meData?.me?.name ?? meData?.me?.email ?? '…'
  const stats   = statsData?.myTicketStats
  const tickets = ticketData?.myTickets?.items ?? []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
      {/* Stats mini cards */}
      {stats && (
        <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
          {[
            { label: t('home.open'),      value: stats.open      },
            { label: t('home.inProgress'), value: stats.inProgress },
            { label: t('home.total'),     value: stats.total     },
          ].map(({ label, value }) => (
            <div key={label} style={{
              padding:         '8px 16px',
              backgroundColor: palette.neutral.surface1,
              border:          `1px solid ${colors.border}`,
              borderRadius:    8,
              textAlign:       'center',
              minWidth:        64,
            }}>
              <div style={{ fontSize: 20, fontWeight: 700, color: colors.brand }}>{value}</div>
              <div style={{ fontSize: 10, color: colors.slateLight, marginTop: 2 }}>{label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Hero */}
      <div style={{ textAlign: 'center', padding: '8px 0 8px' }}>
        <h1 style={{ fontSize: 28, fontWeight: 600, color: colors.slateDark, marginBottom: 24 }}>
          {t('home.greeting', { name })}
        </h1>
        <div style={{ maxWidth: 560, margin: '0 auto' }}>
          <KBSearchBar large />
        </div>
      </div>

      {/* Quick action cards */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <button
          onClick={() => navigate('/tickets/new')}
          style={{
            display:         'flex',
            flexDirection:   'column',
            alignItems:      'center',
            gap:             12,
            padding:         24,
            backgroundColor: colors.brandLight,
            border:          `1.5px solid ${palette.info.border}`,
            borderRadius:    12,
            cursor:          'pointer',
            transition:      'box-shadow 0.15s',
          }}
          onMouseEnter={e => { e.currentTarget.style.boxShadow = `0 4px 12px ${alpha.brand13}` }}
          onMouseLeave={e => { e.currentTarget.style.boxShadow = 'none' }}
        >
          <PlusCircle size={32} style={{ color: colors.brand }} />
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, color: colors.slateDark }}>{t('home.newTicket')}</div>
            <div style={{ fontSize: 10, color: colors.slate, marginTop: 4 }}>{t('home.newTicketDesc')}</div>
          </div>
        </button>

        <button
          onClick={() => navigate('/kb')}
          style={{
            display:         'flex',
            flexDirection:   'column',
            alignItems:      'center',
            gap:             12,
            padding:         24,
            backgroundColor: palette.neutral.surface1,
            border:          `1.5px solid ${colors.border}`,
            borderRadius:    12,
            cursor:          'pointer',
            transition:      'box-shadow 0.15s',
          }}
          onMouseEnter={e => { e.currentTarget.style.boxShadow = `0 4px 12px ${alpha.black08}` }}
          onMouseLeave={e => { e.currentTarget.style.boxShadow = 'none' }}
        >
          <Search size={32} style={{ color: colors.slate }} />
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, color: colors.slateDark }}>{t('home.searchKB')}</div>
            <div style={{ fontSize: 10, color: colors.slate, marginTop: 4 }}>{t('home.searchKBDesc')}</div>
          </div>
        </button>
      </div>

      {/* Recent tickets */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h2 style={{ fontSize: 10, fontWeight: 600, color: colors.slateDark }}>{t('home.recentTickets')}</h2>
          <Link to="/tickets" style={{ fontSize: 10, color: colors.brand }}>Tutti →</Link>
        </div>

        {tickets.length === 0 ? (
          <div style={{ padding: '32px 0', textAlign: 'center', color: colors.slateLight }}>
            <p style={{ marginBottom: 8 }}>{t('home.noTickets')}</p>
            <Link to="/tickets/new" style={{ color: colors.brand, fontWeight: 500 }}>
              {t('home.needHelp')}
            </Link>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {tickets.map(ticket => (
              <Link
                key={ticket.id}
                to={`/tickets/${ticket.id}`}
                style={{
                  display:         'flex',
                  alignItems:      'center',
                  justifyContent:  'space-between',
                  padding:         '12px 16px',
                  backgroundColor: palette.neutral.surface1,
                  border:          `1px solid ${colors.border}`,
                  borderRadius:    8,
                  gap:             12,
                  transition:      'background 0.15s',
                }}
                onMouseEnter={e => { e.currentTarget.style.backgroundColor = colors.brandLight }}
                onMouseLeave={e => { e.currentTarget.style.backgroundColor = palette.neutral.surface1 }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 10, fontWeight: 500, color: colors.slateDark, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {ticket.title}
                  </div>
                  <div style={{ fontSize: 10, color: colors.slateLight, marginTop: 2 }}>
                    {fmtRelative(ticket.updatedAt, 'day')}
                  </div>
                </div>
                <TicketStatusBadge status={ticket.status} statusCategory={ticket.statusCategory} statusLabel={ticket.statusLabel} />
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
