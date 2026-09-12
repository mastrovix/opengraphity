import { useState } from 'react'
import { useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { PlusCircle } from 'lucide-react'
import { GET_MY_TICKETS } from '@/graphql/queries'
import { TicketStatusBadge } from '@/components/TicketStatusBadge'
import { TICKET_POLL_INTERVAL_MS } from '@/lib/apollo'
import { fmtDate } from '@/lib/format'
import { colors, palette, alpha } from '@/lib/tokens'

const PAGE_SIZE = 15

/**
 * Le schede mandano una CLASSE di stato, non il nome di un passo: l'API la
 * traduce nei passi del workflow del tenant (`is_open`, `is_initial`,
 * `is_terminal`, `category`). Prima qui c'era `open: 'open'`, confrontato per
 * uguaglianza con `Incident.status`: nessun workflow definisce un passo
 * chiamato `open`, quindi la scheda «Aperti» era vuota per costruzione — e non
 * coincideva col contatore della home. Ora la sorgente è una sola.
 */
type FilterKey = 'all' | 'open' | 'inProgress' | 'resolved' | 'closed'
const FILTER_CLASS: Record<FilterKey, string | null> = {
  all:        null,
  open:       'open',
  inProgress: 'in_progress',
  resolved:   'resolved',
  closed:     'closed',
}

const PRIORITY_COLORS: Record<string, string> = {
  high:   colors.danger,
  medium: colors.warning,
  low:    colors.success,
}

interface Ticket {
  id: string; title: string; status: string; priority: string
  /** Categoria ed etichetta del passo nel workflow del cliente (ondata 7 · D-15). */
  statusCategory: string | null; statusLabel: string | null
  category: string; createdAt: string; updatedAt: string; assignedTeam: string | null
}

export function TicketListPage() {
  const { t }                     = useTranslation()
  const [filter, setFilter]       = useState<FilterKey>('all')
  const [page, setPage]           = useState(1)

  // The list polls for status changes made by the IT team; nothing else does.
  const { data, loading, error } = useQuery<{ myTickets: { items: Ticket[]; total: number } }>(
    GET_MY_TICKETS,
    { variables: { status: FILTER_CLASS[filter], page, pageSize: PAGE_SIZE }, pollInterval: TICKET_POLL_INTERVAL_MS },
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
        <h1 style={{ fontSize: 20, fontWeight: 600, color: colors.slateDark }}>{t('nav.tickets')}</h1>
        <Link
          to="/tickets/new"
          style={{
            display:         'inline-flex',
            alignItems:      'center',
            gap:             6,
            padding:         '9px 18px',
            backgroundColor: colors.brand,
            color:           colors.white,
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
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: `1px solid ${colors.border}`, paddingBottom: 0 }}>
        {FILTERS.map(f => (
          <button
            key={f.key}
            onClick={() => changeFilter(f.key)}
            style={{
              padding:         '8px 16px',
              background:      'none',
              border:          'none',
              borderBottom:    filter === f.key ? `2px solid ${colors.brand}` : '2px solid transparent',
              cursor:          'pointer',
              fontSize:        14,
              fontWeight:      filter === f.key ? 600 : 400,
              color:           filter === f.key ? colors.brand : colors.slate,
              marginBottom:    -1,
            }}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Tickets list */}
      {loading ? (
        <div style={{ padding: 32, textAlign: 'center', color: colors.slateLight }}>{t('common.loading')}</div>
      ) : error ? (
        /* Fail-loud: se il workflow del tenant non dichiara nessun passo per la
           classe scelta, l'API lo dice — e va detto in pagina, invece di
           mostrare una lista vuota che si legge come «non hai ticket». */
        <div role="alert" style={{ padding: '32px 24px', textAlign: 'center', color: palette.danger.text, backgroundColor: palette.danger.bg, border: `1px solid ${palette.danger.border}`, borderRadius: 10 }}>
          <p style={{ fontWeight: 600, marginBottom: 8 }}>{t('ticket.filterError')}</p>
          <p style={{ fontSize: 12 }}>{error.message}</p>
        </div>
      ) : tickets.length === 0 ? (
        <div style={{ padding: '48px 0', textAlign: 'center', color: colors.slateLight }}>
          <p style={{ marginBottom: 16 }}>{t(`ticket.empty.${filter}`)}</p>
          <Link
            to="/tickets/new"
            style={{ color: colors.brand, fontWeight: 500, fontSize: 10 }}
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
                backgroundColor: colors.white,
                border:          `1px solid ${colors.border}`,
                borderRadius:    10,
                textDecoration:  'none',
                transition:      'box-shadow 0.15s, border-color 0.15s',
              }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = palette.info.border; e.currentTarget.style.boxShadow = `0 2px 8px ${alpha.brand08}` }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = colors.border; e.currentTarget.style.boxShadow = 'none' }}
            >
              {/* Priority indicator */}
              <div style={{
                width:           4,
                height:          40,
                borderRadius:    4,
                backgroundColor: PRIORITY_COLORS[ticket.priority] ?? colors.slateLight,
                flexShrink:      0,
              }} />

              {/* Main info */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 10, fontWeight: 500, color: colors.slateDark, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 4 }}>
                  {ticket.title}
                </div>
                <div style={{ display: 'flex', gap: 12, fontSize: 10, color: colors.slateLight, flexWrap: 'wrap' }}>
                  <span>{t(`ticket.category.${ticket.category}`, { defaultValue: ticket.category })}</span>
                  <span>{t('ticket.openedOn', { date: fmtDate(ticket.createdAt) })}</span>
                  <span>{t('ticket.updatedOn', { date: fmtDate(ticket.updatedAt) })}</span>
                  {ticket.assignedTeam && <span>→ {ticket.assignedTeam}</span>}
                </div>
              </div>

              {/* Status + priority pill */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, flexShrink: 0 }}>
                <TicketStatusBadge status={ticket.status} statusCategory={ticket.statusCategory} statusLabel={ticket.statusLabel} />
                <span style={{
                  fontSize:        11,
                  padding:         '1px 8px',
                  borderRadius:    100,
                  backgroundColor: colors.slateBg,
                  color:           PRIORITY_COLORS[ticket.priority] ?? colors.slateLight,
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
              border:       `1px solid ${colors.border}`,
              borderRadius: 7,
              background:   colors.white,
              cursor:       page === 1 ? 'not-allowed' : 'pointer',
              color:        page === 1 ? palette.neutral.textDisabled : colors.slate,
              fontSize:     13,
            }}
          >
            {t('ticket.prev')}
          </button>
          <span style={{ padding: '8px 0', fontSize: 10, color: colors.slateLight }}>
            {page} / {totalPages}
          </span>
          <button
            disabled={page >= totalPages}
            onClick={() => setPage(p => p + 1)}
            style={{
              padding:      '8px 18px',
              border:       `1px solid ${colors.border}`,
              borderRadius: 7,
              background:   colors.white,
              cursor:       page >= totalPages ? 'not-allowed' : 'pointer',
              color:        page >= totalPages ? palette.neutral.textDisabled : colors.slate,
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
