import { useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router-dom'
import { PlusCircle, Search } from 'lucide-react'
import { GET_MY_TICKETS, GET_MY_TICKET_STATS, GET_ME } from '@/graphql/queries'
import { TicketStatusBadge } from '@/components/TicketStatusBadge'
import { KBSearchBar } from '@/components/KBSearchBar'

interface Ticket {
  id: string; title: string; status: string; priority: string
  category: string; createdAt: string; updatedAt: string
}
interface Stats { open: number; inProgress: number; resolved: number; total: number }

function fmtDate(iso: string): string {
  try {
    return new Intl.RelativeTimeFormat('it', { numeric: 'auto' }).format(
      Math.round((new Date(iso).getTime() - Date.now()) / 86_400_000),
      'day',
    )
  } catch { return iso }
}

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
              backgroundColor: '#F8FAFC',
              border:          '1px solid #E2E8F0',
              borderRadius:    8,
              textAlign:       'center',
              minWidth:        64,
            }}>
              <div style={{ fontSize: 20, fontWeight: 700, color: '#0EA5E9' }}>{value}</div>
              <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 2 }}>{label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Hero */}
      <div style={{ textAlign: 'center', padding: '8px 0 8px' }}>
        <h1 style={{ fontSize: 28, fontWeight: 600, color: '#0F172A', marginBottom: 24 }}>
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
            backgroundColor: '#F0F9FF',
            border:          '1.5px solid #BAE6FD',
            borderRadius:    12,
            cursor:          'pointer',
            transition:      'box-shadow 0.15s',
          }}
          onMouseEnter={e => { e.currentTarget.style.boxShadow = '0 4px 12px rgba(14,165,233,0.15)' }}
          onMouseLeave={e => { e.currentTarget.style.boxShadow = 'none' }}
        >
          <PlusCircle size={32} style={{ color: '#0EA5E9' }} />
          <div>
            <div style={{ fontSize: 16, fontWeight: 600, color: '#0F172A' }}>{t('home.newTicket')}</div>
            <div style={{ fontSize: 13, color: '#64748B', marginTop: 4 }}>{t('home.newTicketDesc')}</div>
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
            backgroundColor: '#F8FAFC',
            border:          '1.5px solid #E2E8F0',
            borderRadius:    12,
            cursor:          'pointer',
            transition:      'box-shadow 0.15s',
          }}
          onMouseEnter={e => { e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.08)' }}
          onMouseLeave={e => { e.currentTarget.style.boxShadow = 'none' }}
        >
          <Search size={32} style={{ color: '#64748B' }} />
          <div>
            <div style={{ fontSize: 16, fontWeight: 600, color: '#0F172A' }}>{t('home.searchKB')}</div>
            <div style={{ fontSize: 13, color: '#64748B', marginTop: 4 }}>{t('home.searchKBDesc')}</div>
          </div>
        </button>
      </div>

      {/* Recent tickets */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, color: '#0F172A' }}>{t('home.recentTickets')}</h2>
          <Link to="/tickets" style={{ fontSize: 13, color: '#0EA5E9' }}>Tutti →</Link>
        </div>

        {tickets.length === 0 ? (
          <div style={{ padding: '32px 0', textAlign: 'center', color: '#94A3B8' }}>
            <p style={{ marginBottom: 8 }}>{t('home.noTickets')}</p>
            <Link to="/tickets/new" style={{ color: '#0EA5E9', fontWeight: 500 }}>
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
                  backgroundColor: '#FAFAFA',
                  border:          '1px solid #E2E8F0',
                  borderRadius:    8,
                  gap:             12,
                  transition:      'background 0.15s',
                }}
                onMouseEnter={e => { e.currentTarget.style.backgroundColor = '#F0F9FF' }}
                onMouseLeave={e => { e.currentTarget.style.backgroundColor = '#FAFAFA' }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 500, color: '#0F172A', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {ticket.title}
                  </div>
                  <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 2 }}>
                    {fmtDate(ticket.updatedAt)}
                  </div>
                </div>
                <TicketStatusBadge status={ticket.status} />
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
