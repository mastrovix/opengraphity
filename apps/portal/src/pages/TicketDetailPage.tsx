import { useState, useEffect, useRef } from 'react'
import { useParams, useLocation, Link } from 'react-router-dom'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, Paperclip } from 'lucide-react'
import { GET_MY_TICKET, GET_ME } from '@/graphql/queries'
import { usePortalAccess } from '@/hooks/usePortalAccess'
import { useTicketCategories } from '@/hooks/useTicketCategories'
import { ADD_TICKET_COMMENT, REOPEN_TICKET, UPDATE_COMMENT, DELETE_COMMENT } from '@/graphql/mutations'
import { TicketStatusBadge } from '@/components/TicketStatusBadge'
import { CommentBubble } from '@/components/CommentBubble'
import { downloadAttachment } from '@/lib/attachments'
import { notifyError } from '@/lib/notify'
import { TICKET_POLL_INTERVAL_MS } from '@/lib/apollo'
import { fmtDateTimeLong, fmtRelative } from '@/lib/format'
import { colors, palette } from '@/lib/tokens'

interface EntityComment {
  id: string; body: string; isInternal: boolean
  authorId: string; authorName: string; authorEmail: string; createdAt: string
  editedAt: string | null; editedByName: string | null; deletedAt: string | null; deletedByName: string | null
}
interface Attachment { id: string; filename: string; mimeType: string; sizeBytes: number; downloadUrl: string }
interface HistoryEntry { fromStep: string | null; toStep: string; fromLabel: string | null; toLabel: string | null; label: string | null; triggeredAt: string; triggeredBy: string }
interface Ticket {
  id: string; number: string; title: string; description: string | null; status: string
  /** Categoria ed etichetta del passo nel workflow del cliente (ondata 7 · D-15). */
  statusCategory: string | null; statusLabel: string | null
  type: string
  priority: string; category: string | null; createdAt: string; updatedAt: string
  assignedTeam: string | null
  comments:    EntityComment[]
  attachments: Attachment[]
  history:     HistoryEntry[]
  /** I campi del cliente offerti nel portale (ondata 4). */
  customFields: { name: string; label: string; fieldType: string; value: string | null; valueLabel: string | null }[]
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`
  return `${(b / (1024 * 1024)).toFixed(1)} MB`
}

export function TicketDetailPage() {
  const { id }               = useParams<{ id: string }>()
  const { t, i18n }          = useTranslation()
  const location             = useLocation()
  const [reply, setReply]    = useState('')
  const [attachOpen, setAttachOpen] = useState(false)
  const bottomRef            = useRef<HTMLDivElement>(null)
  const showCreatedMsg       = !!(location.state as { created?: boolean } | null)?.created

  const { data: meData }     = useQuery<{ me: { id: string } | null }>(GET_ME)
  const { canSubmit }        = usePortalAccess()
  const { labelOf: categoryLabel } = useTicketCategories()
  // Detail page polls (comments/status from the IT team); nothing else does.
  const { data, loading, error, refetch } = useQuery<{ myTicket: Ticket }>(
    GET_MY_TICKET,
    { variables: { id, language: i18n.resolvedLanguage ?? i18n.language }, skip: !id, pollInterval: TICKET_POLL_INTERVAL_MS },
  )

  const ticket   = data?.myTicket
  const myUserId = meData?.me?.id ?? ''

  const ticketLoaded = !!ticket
  const commentCount = ticket?.comments?.length ?? 0
  useEffect(() => {
    if (ticketLoaded) bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [ticketLoaded, commentCount])

  const [updateComment] = useMutation(UPDATE_COMMENT, {
    onCompleted: () => void refetch(),
    onError: (e: { message: string }) => notifyError(e.message),
  })
  const [deleteComment] = useMutation(DELETE_COMMENT, {
    onCompleted: () => void refetch(),
    onError: (e: { message: string }) => notifyError(e.message),
  })
  const [addComment, { loading: commenting }] = useMutation(ADD_TICKET_COMMENT, {
    onCompleted: () => { setReply(''); void refetch() },
    onError: (e: { message: string }) => notifyError(e.message),
  })

  const [reopenTicket, { loading: reopening }] = useMutation(REOPEN_TICKET, {
    onCompleted: () => void refetch(),
    onError: (e: { message: string }) => notifyError(e.message),
  })

  // Error (e.g. ForbiddenError on someone else's ticket) must not look like an
  // endless "Loading…": show it, with a way back to the list.
  if (error) {
    return (
      <div style={{ maxWidth: 640, margin: '0 auto', padding: 24 }}>
        <div role="alert" style={{ background: palette.danger.bg, border: `1px solid ${palette.danger.border}`, color: palette.danger.strong, padding: '12px 16px', borderRadius: 8, fontSize: 14, marginBottom: 16 }}>
          {t('ticket.loadError', { message: error.message })}
        </div>
        <Link to="/tickets" style={{ color: colors.brand, fontSize: 14 }}>{t('common.back')}</Link>
      </div>
    )
  }
  if (loading && !ticket) return <div style={{ padding: 48, textAlign: 'center', color: colors.slateLight }}>{t('common.loading')}</div>
  if (!ticket) {
    return (
      <div style={{ maxWidth: 640, margin: '0 auto', padding: 24, textAlign: 'center', color: colors.slate }}>
        <p style={{ marginBottom: 16 }}>{t('ticket.notFound')}</p>
        <Link to="/tickets" style={{ color: colors.brand, fontSize: 14 }}>{t('common.back')}</Link>
      </div>
    )
  }

  // Chiuso / risolto si leggono dalla CATEGORIA del passo di workflow di questo
  // cliente (già esposta dall'API, ondata 7 · D-15) e non dai due nomi di
  // fabbrica (B-22): con un passo rinominato o aggiunto nel disegnatore il
  // portale continuava a offrire la risposta su un ticket chiuso e non mostrava
  // il riquadro «risolto» su uno risolto.
  const isClosed   = ticket.statusCategory === 'closed'
  const isResolved = ticket.statusCategory === 'resolved'
  // Rispondere e riaprire: il permesso `portal.submit` del ruolo (ondata 7).
  const canReply   = !isClosed && canSubmit

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
          backgroundColor: palette.success.bg,
          border:          `1px solid ${palette.success.border}`,
          borderRadius:    8,
          color:           palette.success.text,
          fontSize:        14,
          fontWeight:      500,
        }}>
          ✓ {t('ticket.created')}
        </div>
      )}

      {/* Header */}
      <div>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <h1 style={{ fontSize: 20, fontWeight: 600, color: colors.slateDark, flex: 1, minWidth: 0 }}>
            {ticket.title}
          </h1>
          <TicketStatusBadge status={ticket.status} statusCategory={ticket.statusCategory} statusLabel={ticket.statusLabel} size="md" />
        </div>

        {/* Info bar */}
        <div style={{ display: 'flex', gap: 16, marginTop: 10, fontSize: 10, color: colors.slateLight, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600 }}>{ticket.number}</span>
          <span>·</span>
          {ticket.category && <>
            <span>{categoryLabel(ticket.category)}</span>
            <span>·</span>
          </>}
          <span>{t('ticket.createdAt')}: {fmtDateTimeLong(ticket.createdAt)}</span>
          <span>·</span>
          <span>{t('ticket.updatedAt')}: {fmtRelative(ticket.updatedAt)}</span>
          {ticket.assignedTeam && (
            <>
              <span>·</span>
              <span>{t('ticket.assignedTo')}: <strong style={{ color: colors.slateDark }}>{ticket.assignedTeam}</strong></span>
            </>
          )}
        </div>
      </div>

      {/* Resolved banner */}
      {isResolved && canSubmit && (
        <div style={{
          display:         'flex',
          alignItems:      'center',
          justifyContent:  'space-between',
          padding:         '12px 16px',
          backgroundColor: palette.success.bg,
          border:          `1px solid ${palette.success.border}`,
          borderRadius:    8,
          flexWrap:        'wrap',
          gap:             12,
        }}>
          <span style={{ color: palette.success.text, fontWeight: 500, fontSize: 10 }}>
            ✓ {t('ticket.resolved')}
          </span>
          <button
            onClick={() => id && void reopenTicket({ variables: { ticketId: id } })}
            disabled={reopening}
            style={{
              padding:         '7px 16px',
              backgroundColor: colors.white,
              border:          `1px solid ${palette.success.border}`,
              borderRadius:    7,
              fontSize:        13,
              cursor:          'pointer',
              color:           palette.success.text,
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
          backgroundColor: palette.neutral.surface1,
          borderRadius:    8,
          fontSize:        14,
          color:           colors.slateDark,
          lineHeight:      1.7,
          whiteSpace:      'pre-wrap',
        }}>
          {ticket.description}
        </div>
      )}

      {/* Campi del cliente (ondata 4): quelli che l'amministratore offre nel portale */}
      {(ticket.customFields ?? []).length > 0 && (
        <dl style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '12px 20px', margin: 0, padding: 16, border: `1px solid ${colors.border}`, borderRadius: 8 }}>
          {ticket.customFields.map((f) => (
            <div key={f.name} style={{ minWidth: 0 }}>
              <dt style={{ fontSize: 10, fontWeight: 600, color: colors.slateLight, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{f.label}</dt>
              <dd style={{ margin: 0, fontSize: 13, color: f.value ? colors.slateDark : colors.slateLight, overflowWrap: 'anywhere' }}>
                {f.value == null ? '—' : f.fieldType === 'boolean' ? t(f.value === 'true' ? 'common.yes' : 'common.no') : (f.valueLabel ?? f.value)}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {/* Timeline */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minHeight: 80 }}>
        {timeline.length === 0 && (
          <p style={{ color: colors.slateLight, fontSize: 10, textAlign: 'center', padding: '24px 0' }}>
            {t('ticket.noMessages')}
          </p>
        )}

        {timeline.map((item, i) => {
          if (item.type === 'comment') {
            const c    = item.data
            const isOwn = c.authorId === myUserId
            return (
              <CommentBubble key={c.id} body={c.body} authorName={c.authorName} authorEmail={c.authorEmail} createdAt={c.createdAt} isOwn={isOwn}
                editedAt={c.editedAt} editedByName={c.editedByName} deletedAt={c.deletedAt} deletedByName={c.deletedByName}
                onEdit={(body) => updateComment({ variables: { id: c.id, body } })}
                onDelete={() => void deleteComment({ variables: { id: c.id } })} />
            )
          }
          const h = item.data
          return (
            <div key={i} style={{ textAlign: 'center', padding: '6px 0', fontSize: 10, color: colors.slateLight }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <ChevronRight size={12} />
                {/* H-49: la prima voce ha `fromStep: null`, non il nome «start». */}
                {h.fromStep !== null ? `${h.fromLabel ?? h.fromStep} → ${h.toLabel ?? h.toStep}` : (h.toLabel ?? h.toStep)}
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
        <div style={{ border: `1px solid ${colors.border}`, borderRadius: 8, overflow: 'hidden' }}>
          <button
            onClick={() => setAttachOpen(o => !o)}
            style={{
              width:           '100%',
              display:         'flex',
              alignItems:      'center',
              justifyContent:  'space-between',
              padding:         '12px 16px',
              background:      palette.neutral.surface1,
              border:          'none',
              cursor:          'pointer',
              fontSize:        13,
              fontWeight:      600,
              color:           colors.slateDark,
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Paperclip size={14} style={{ color: colors.slate }} />
              {t('ticket.attachments')} ({ticket.attachments.length})
            </span>
            {attachOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
          {attachOpen && (
            <div style={{ padding: '8px 16px 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {ticket.attachments.map(a => (
                <button
                  key={a.id}
                  onClick={() => downloadAttachment(a.downloadUrl, a.filename).catch(() => notifyError(t('ticket.downloadFailed')))}
                  style={{
                    display:         'flex',
                    alignItems:      'center',
                    justifyContent:  'space-between',
                    width:           '100%',
                    padding:         '8px 12px',
                    backgroundColor: palette.neutral.surface1,
                    border:          'none',
                    borderRadius:    6,
                    fontSize:        13,
                    color:           colors.brand,
                    cursor:          'pointer',
                    textAlign:       'left',
                  }}
                >
                  <span>{a.filename}</span>
                  <span style={{ color: colors.slateLight, fontSize: 10 }}>{formatBytes(a.sizeBytes)}</span>
                </button>
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
          backgroundColor: colors.white,
          borderTop:       `1px solid ${colors.border}`,
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
                border:       `1.5px solid ${colors.border}`,
                borderRadius: 8,
                fontSize:     14,
                resize:       'none',
                outline:      'none',
                lineHeight:   1.5,
              }}
              onFocus={e => { e.currentTarget.style.borderColor = colors.brand }}
              onBlur={e  => { e.currentTarget.style.borderColor = colors.border }}
              onKeyDown={e => { if (e.key === 'Enter' && e.ctrlKey) sendReply() }}
            />
            <button
              onClick={sendReply}
              disabled={!reply.trim() || commenting}
              style={{
                padding:         '10px 20px',
                backgroundColor: reply.trim() ? colors.brand : colors.border,
                color:           reply.trim() ? colors.white : colors.slateLight,
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
