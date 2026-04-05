import { useState } from 'react'
import { useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { PlusCircle } from 'lucide-react'
import { GET_MY_TICKETS } from '@/graphql/queries'
import { TicketStatusBadge } from '@/components/TicketStatusBadge'

const PAGE_SIZE = 15

type FilterKey = 'all' | 'open' | 'inProgress' | 'resolved' | 'closed'
const FILTER_STATUS: Record<FilterKey, string | null> = {
  all:        null,
  open:       'open',
  inProgress: 'in_progress',
  resolved:   'resolved',
  closed:     'closed',
}

const PRIORITY_COLORS: Record<string, string> = {
  high:   '#EF4444',
  medium: '#F59E0B',
  low:    '#22C55E',
}

function fmtDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(iso))
  } catch { return iso }
}

interface Ticket {
  id: string; title: string; status: string; priority: string
  category: string; createdAt: string; updatedAt: string; assignedTeam: string | null
}

export function TicketListPage() {
  const { t }                     = useTranslation()
  const [filter, setFilter]       = useState<FilterKey>('all')
  const [page, setPage]           = useState(1)

  const { data, loading } = useQuery<{ myTickets: { items: Ticket[]; total: number } }>(
    GET_MY_TICKETS,
    { variables: { status: FILTER_STATUS[filter], page, pageSize: PAGE_SIZE } },
  )

  const tickets   = data?.myTickets?.items ?? []
  const total     = data?.myTickets?.total ?? 0
  const totalPages = Math.ceil(total / PAGE_SIZE)

  const FILTERS: { key: FilterKey; label: string }[] = [
    { key: 'all',        label: t('ticket.filters.all') },
    { key: 'open',       label: t('ticket.filters.open') },
    { key: 'inProgress', label: t('ticket.filters.inProgress') },
    { key: 'resolved',   label: t('ticket.filters.resolved') },
    { key: 'closed',     label: t('ticket.filters.closed') },
  ]

  function changeFilter(k: FilterKey) {
    setFilter(k)
    setPage(1)
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, color: '#0F172A' }}>{t('nav.tickets')}</h1>
        <Link
          to="/tickets/new"
          style={{
            display:         'inline-flex',
            alignItems:      'center',
            gap:             6,
            padding:         '9px 18px',
            backgroundColor: '#0EA5E9',
            color:           '#fff',
            borderRadius:    8,
            fontSize:        14,
            fontWeight:      600,
            textDecoration:  'none',
          }}
        >
          <PlusCircle size={15} />
          {t('ticket.new')}
        </Link>
      </div>

      {/* Filter tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid #E2E8F0', paddingBottom: 0 }}>
        {FILTERS.map(f => (
          <button
            key={f.key}
            onClick={() => changeFilter(f.key)}
            style={{
              padding:         '8px 16px',
              background:      'none',
              border:          'none',
              borderBottom:    filter === f.key ? '2px solid #0EA5E9' : '2px solid transparent',
              cursor:          'pointer',
              fontSize:        14,
              fontWeight:      filter === f.key ? 600 : 400,
              color:           filter === f.key ? '#0EA5E9' : '#64748B',
              marginBottom:    -1,
            }}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Tickets list */}
      {loading ? (
        <div style={{ padding: 32, textAlign: 'center', color: '#94A3B8' }}>{t('common.loading')}</div>
      ) : tickets.length === 0 ? (
        <div style={{ padding: '48px 0', textAlign: 'center', color: '#94A3B8' }}>
          <p style={{ marginBottom: 16 }}>{t(`ticket.empty.${filter}`)}</p>
          <Link
            to="/tickets/new"
            style={{ color: '#0EA5E9', fontWeight: 500, fontSize: 14 }}
          >
            + {t('ticket.new')}
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
                gap:             16,
                padding:         '14px 18px',
                backgroundColor: '#fff',
                border:          '1px solid #E2E8F0',
                borderRadius:    10,
                textDecoration:  'none',
                transition:      'box-shadow 0.15s, border-color 0.15s',
              }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = '#BAE6FD'; e.currentTarget.style.boxShadow = '0 2px 8px rgba(14,165,233,0.08)' }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = '#E2E8F0'; e.currentTarget.style.boxShadow = 'none' }}
            >
              {/* Priority indicator */}
              <div style={{
                width:           4,
                height:          40,
                borderRadius:    4,
                backgroundColor: PRIORITY_COLORS[ticket.priority] ?? '#94A3B8',
                flexShrink:      0,
              }} />

              {/* Main info */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 500, color: '#0F172A', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 4 }}>
                  {ticket.title}
                </div>
                <div style={{ display: 'flex', gap: 12, fontSize: 12, color: '#94A3B8', flexWrap: 'wrap' }}>
                  <span>{t(`ticket.category.${ticket.category}`, { defaultValue: ticket.category })}</span>
                  <span>Aperto {fmtDate(ticket.createdAt)}</span>
                  <span>Aggiornato {fmtDate(ticket.updatedAt)}</span>
                  {ticket.assignedTeam && <span>→ {ticket.assignedTeam}</span>}
                </div>
              </div>

              {/* Status + priority pill */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, flexShrink: 0 }}>
                <TicketStatusBadge status={ticket.status} />
                <span style={{
                  fontSize:        11,
                  padding:         '1px 8px',
                  borderRadius:    100,
                  backgroundColor: '#F1F5F9',
                  color:           PRIORITY_COLORS[ticket.priority] ?? '#94A3B8',
                  fontWeight:      600,
                }}>
                  {t(`ticket.priority.${ticket.priority}`, { defaultValue: ticket.priority })}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: 12, marginTop: 24 }}>
          <button
            disabled={page === 1}
            onClick={() => setPage(p => p - 1)}
            style={{
              padding:      '8px 18px',
              border:       '1px solid #E2E8F0',
              borderRadius: 7,
              background:   '#fff',
              cursor:       page === 1 ? 'not-allowed' : 'pointer',
              color:        page === 1 ? '#CBD5E1' : '#64748B',
              fontSize:     13,
            }}
          >
            {t('ticket.prev')}
          </button>
          <span style={{ padding: '8px 0', fontSize: 13, color: '#94A3B8' }}>
            {page} / {totalPages}
          </span>
          <button
            disabled={page >= totalPages}
            onClick={() => setPage(p => p + 1)}
            style={{
              padding:      '8px 18px',
              border:       '1px solid #E2E8F0',
              borderRadius: 7,
              background:   '#fff',
              cursor:       page >= totalPages ? 'not-allowed' : 'pointer',
              color:        page >= totalPages ? '#CBD5E1' : '#64748B',
              fontSize:     13,
            }}
          >
            {t('ticket.next')}
          </button>
        </div>
      )}
    </div>
  )
}
