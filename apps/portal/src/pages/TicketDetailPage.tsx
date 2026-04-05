import { useState, useEffect, useRef } from 'react'
import { useParams, useLocation } from 'react-router-dom'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, Paperclip } from 'lucide-react'
import { GET_MY_TICKET, GET_ME } from '@/graphql/queries'
import { ADD_TICKET_COMMENT, REOPEN_TICKET } from '@/graphql/mutations'
import { TicketStatusBadge } from '@/components/TicketStatusBadge'
import { CommentBubble } from '@/components/CommentBubble'

interface EntityComment {
  id: string; body: string; isInternal: boolean
  authorId: string; authorName: string; authorEmail: string; createdAt: string
}
interface Attachment { id: string; filename: string; mimeType: string; sizeBytes: number; downloadUrl: string }
interface HistoryEntry { fromStep: string; toStep: string; label: string | null; triggeredAt: string; triggeredBy: string }
interface Ticket {
  id: string; title: string; description: string | null; status: string
  priority: string; category: string; createdAt: string; updatedAt: string
  assignedTeam: string | null
  comments:    EntityComment[]
  attachments: Attachment[]
  history:     HistoryEntry[]
}

function fmtDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat('it-IT', {
      day: '2-digit', month: 'long', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    }).format(new Date(iso))
  } catch { return iso }
}

function fmtRelative(iso: string): string {
  try {
    const diff = Math.round((new Date(iso).getTime() - Date.now()) / 3_600_000)
    return new Intl.RelativeTimeFormat('it', { numeric: 'auto' }).format(diff, 'hour')
  } catch { return iso }
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`
  return `${(b / (1024 * 1024)).toFixed(1)} MB`
}

export function TicketDetailPage() {
  const { id }               = useParams<{ id: string }>()
  const { t }                = useTranslation()
  const location             = useLocation()
  const [reply, setReply]    = useState('')
  const [attachOpen, setAttachOpen] = useState(false)
  const bottomRef            = useRef<HTMLDivElement>(null)
  const showCreatedMsg       = !!(location.state as { created?: boolean } | null)?.created

  const { data: meData }     = useQuery<{ me: { id: string } | null }>(GET_ME)
  const { data, refetch }    = useQuery<{ myTicket: Ticket }>(GET_MY_TICKET, { variables: { id }, skip: !id })

  const ticket   = data?.myTicket
  const myUserId = meData?.me?.id ?? ''

  useEffect(() => {
    if (ticket) bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [ticket?.comments?.length])

  const [addComment, { loading: commenting }] = useMutation(ADD_TICKET_COMMENT, {
    onCompleted: () => { setReply(''); void refetch() },
    onError: (e: { message: string }) => alert(e.message),
  })

  const [reopenTicket, { loading: reopening }] = useMutation(REOPEN_TICKET, {
    onCompleted: () => void refetch(),
    onError: (e: { message: string }) => alert(e.message),
  })

  if (!ticket) return <div style={{ padding: 48, textAlign: 'center', color: '#94A3B8' }}>{t('common.loading')}</div>

  const isClosed   = ticket.status === 'closed'
  const isResolved = ticket.status === 'resolved'
  const canReply   = !isClosed

  // Build timeline: merge comments + history entries, sorted by date
  type TimelineItem =
    | { type: 'comment';  data: EntityComment }
    | { type: 'history';  data: HistoryEntry }

  const timeline: TimelineItem[] = [
    ...ticket.comments.map(c  => ({ type: 'comment' as const, data: c  })),
    ...ticket.history.map(h   => ({ type: 'history' as const, data: h  })),
  ].sort((a, b) => {
    const dateA = a.type === 'comment' ? a.data.createdAt  : a.data.triggeredAt
    const dateB = b.type === 'comment' ? b.data.createdAt  : b.data.triggeredAt
    return dateA.localeCompare(dateB)
  })

  function sendReply() {
    if (!reply.trim() || !id) return
    void addComment({ variables: { ticketId: id, body: reply.trim() } })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Created toast */}
      {showCreatedMsg && (
        <div style={{
          padding:         '12px 16px',
          backgroundColor: '#F0FDF4',
          border:          '1px solid #BBF7D0',
          borderRadius:    8,
          color:           '#15803D',
          fontSize:        14,
          fontWeight:      500,
        }}>
          ✓ {t('ticket.created')}
        </div>
      )}

      {/* Header */}
      <div>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <h1 style={{ fontSize: 22, fontWeight: 600, color: '#0F172A', flex: 1, minWidth: 0 }}>
            {ticket.title}
          </h1>
          <TicketStatusBadge status={ticket.status} size="md" />
        </div>

        {/* Info bar */}
        <div style={{ display: 'flex', gap: 16, marginTop: 10, fontSize: 13, color: '#94A3B8', flexWrap: 'wrap' }}>
          <span>{t(`ticket.category.${ticket.category}`, { defaultValue: ticket.category })}</span>
          <span>·</span>
          <span>{t('ticket.createdAt')}: {fmtDate(ticket.createdAt)}</span>
          <span>·</span>
          <span>{t('ticket.updatedAt')}: {fmtRelative(ticket.updatedAt)}</span>
          {ticket.assignedTeam && (
            <>
              <span>·</span>
              <span>{t('ticket.assignedTo')}: <strong style={{ color: '#0F172A' }}>{ticket.assignedTeam}</strong></span>
            </>
          )}
        </div>
      </div>

      {/* Resolved banner */}
      {isResolved && (
        <div style={{
          display:         'flex',
          alignItems:      'center',
          justifyContent:  'space-between',
          padding:         '12px 16px',
          backgroundColor: '#F0FDF4',
          border:          '1px solid #BBF7D0',
          borderRadius:    8,
          flexWrap:        'wrap',
          gap:             12,
        }}>
          <span style={{ color: '#15803D', fontWeight: 500, fontSize: 14 }}>
            ✓ {t('ticket.resolved')}
          </span>
          <button
            onClick={() => id && void reopenTicket({ variables: { ticketId: id } })}
            disabled={reopening}
            style={{
              padding:         '7px 16px',
              backgroundColor: '#fff',
              border:          '1px solid #BBF7D0',
              borderRadius:    7,
              fontSize:        13,
              cursor:          'pointer',
              color:           '#15803D',
              fontWeight:      500,
            }}
          >
            {t('ticket.reopen')}
          </button>
        </div>
      )}

      {/* Description */}
      {ticket.description && (
        <div style={{
          padding:         16,
          backgroundColor: '#F8FAFC',
          borderRadius:    8,
          fontSize:        14,
          color:           '#0F172A',
          lineHeight:      1.7,
          whiteSpace:      'pre-wrap',
        }}>
          {ticket.description}
        </div>
      )}

      {/* Timeline */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minHeight: 80 }}>
        {timeline.length === 0 && (
          <p style={{ color: '#94A3B8', fontSize: 13, textAlign: 'center', padding: '24px 0' }}>
            Nessun messaggio ancora.
          </p>
        )}

        {timeline.map((item, i) => {
          if (item.type === 'comment') {
            const c    = item.data
            const isOwn = c.authorId === myUserId
            return <CommentBubble key={c.id} body={c.body} authorName={c.authorName} authorEmail={c.authorEmail} createdAt={c.createdAt} isOwn={isOwn} />
          }
          const h = item.data
          return (
            <div key={i} style={{ textAlign: 'center', padding: '6px 0', fontSize: 12, color: '#94A3B8' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <ChevronRight size={12} />
                {h.fromStep} → {h.toStep}
                {' · '}
                {fmtRelative(h.triggeredAt)}
              </span>
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>

      {/* Attachments */}
      {ticket.attachments.length > 0 && (
        <div style={{ border: '1px solid #E2E8F0', borderRadius: 8, overflow: 'hidden' }}>
          <button
            onClick={() => setAttachOpen(o => !o)}
            style={{
              width:           '100%',
              display:         'flex',
              alignItems:      'center',
              justifyContent:  'space-between',
              padding:         '12px 16px',
              background:      '#F8FAFC',
              border:          'none',
              cursor:          'pointer',
              fontSize:        13,
              fontWeight:      600,
              color:           '#0F172A',
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Paperclip size={14} style={{ color: '#64748B' }} />
              {t('ticket.attachments')} ({ticket.attachments.length})
            </span>
            {attachOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
          {attachOpen && (
            <div style={{ padding: '8px 16px 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {ticket.attachments.map(a => (
                <a
                  key={a.id}
                  href={a.downloadUrl}
                  download={a.filename}
                  style={{
                    display:         'flex',
                    alignItems:      'center',
                    justifyContent:  'space-between',
                    padding:         '8px 12px',
                    backgroundColor: '#F8FAFC',
                    borderRadius:    6,
                    fontSize:        13,
                    color:           '#0EA5E9',
                    textDecoration:  'none',
                  }}
                >
                  <span>{a.filename}</span>
                  <span style={{ color: '#94A3B8', fontSize: 12 }}>{formatBytes(a.sizeBytes)}</span>
                </a>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Reply form (sticky at bottom when visible) */}
      {canReply && (
        <div style={{
          position:        'sticky',
          bottom:          0,
          backgroundColor: '#fff',
          borderTop:       '1px solid #E2E8F0',
          paddingTop:      16,
          paddingBottom:   8,
        }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
            <textarea
              value={reply}
              onChange={e => setReply(e.target.value)}
              placeholder={t('ticket.replyPlaceholder')}
              rows={3}
              style={{
                flex:         1,
                padding:      '10px 12px',
                border:       '1.5px solid #E2E8F0',
                borderRadius: 8,
                fontSize:     14,
                resize:       'none',
                outline:      'none',
                lineHeight:   1.5,
              }}
              onFocus={e => { e.currentTarget.style.borderColor = '#0EA5E9' }}
              onBlur={e  => { e.currentTarget.style.borderColor = '#E2E8F0' }}
              onKeyDown={e => { if (e.key === 'Enter' && e.ctrlKey) sendReply() }}
            />
            <button
              onClick={sendReply}
              disabled={!reply.trim() || commenting}
              style={{
                padding:         '10px 20px',
                backgroundColor: reply.trim() ? '#0EA5E9' : '#E2E8F0',
                color:           reply.trim() ? '#fff' : '#94A3B8',
                border:          'none',
                borderRadius:    8,
                fontSize:        14,
                fontWeight:      600,
                cursor:          reply.trim() ? 'pointer' : 'not-allowed',
                alignSelf:       'stretch',
              }}
            >
              {commenting ? '…' : t('ticket.reply')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
