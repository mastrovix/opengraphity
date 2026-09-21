import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pencil, Trash2 } from 'lucide-react'
import { fmtDateTime } from '@/lib/format'
import { colors } from '@/lib/tokens'

interface Props {
  body:        string
  authorName:  string
  authorEmail: string
  createdAt:   string
  isOwn:       boolean   // true = utente corrente (destra), false = agente IT (sinistra)
  /** Traccia di modifica e cancellazione (verifica «Cosa resta cablato», ondata 6). */
  editedAt?:      string | null
  editedByName?:  string | null
  deletedAt?:     string | null
  deletedByName?: string | null
  /** Solo sulle proprie risposte: modificare e cancellare. */
  onEdit?:   (body: string) => Promise<unknown> | void
  onDelete?: () => void
}

export function CommentBubble({ body, authorName, createdAt, isOwn, editedAt, editedByName, deletedAt, deletedByName, onEdit, onDelete }: Props) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const canChange = isOwn && !deletedAt && !!onEdit && !!onDelete

  return (
    <div style={{
      display:       'flex',
      flexDirection: 'column',
      alignItems:    isOwn ? 'flex-end' : 'flex-start',
      marginBottom:  12,
    }}>
      <div style={{
        fontSize:  11,
        color:     colors.slateLight,
        marginBottom: 4,
        textAlign: isOwn ? 'right' : 'left',
        display: 'flex', alignItems: 'center', gap: 6,
      }}>
        <span>{authorName || t('ticket.itAgent')} · {fmtDateTime(createdAt)}</span>
        {canChange && editing === null && !confirming && (
          <>
            <button type="button" aria-label={t('ticket.editReply')} title={t('ticket.editReply')} onClick={() => setEditing(body)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.slateLight, padding: 2, display: 'flex' }}>
              <Pencil size={12} aria-hidden="true" />
            </button>
            <button type="button" aria-label={t('ticket.deleteReply')} title={t('ticket.deleteReply')} onClick={() => setConfirming(true)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.slateLight, padding: 2, display: 'flex' }}>
              <Trash2 size={12} aria-hidden="true" />
            </button>
          </>
        )}
      </div>
      {confirming && (
        <div role="alertdialog" aria-label={t('ticket.deleteReply')} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, fontSize: 12, color: colors.slateDark }}>
          <span>{t('ticket.deleteReplyConfirm')}</span>
          <button type="button" onClick={() => setConfirming(false)}
            style={{ padding: '3px 10px', background: 'none', border: `1px solid ${colors.border}`, borderRadius: 6, fontSize: 12, cursor: 'pointer', color: colors.slate }}>
            {t('ticket.cancel')}
          </button>
          <button type="button" onClick={() => { setConfirming(false); onDelete?.() }}
            style={{ padding: '3px 10px', background: colors.danger, color: colors.white, border: 'none', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}>
            {t('ticket.deleteReply')}
          </button>
        </div>
      )}
      {deletedAt ? (
        <div style={{ maxWidth: '75%', padding: '8px 14px', borderRadius: 12, border: `1px dashed ${colors.border}`, color: colors.slateLight, fontSize: 13, fontStyle: 'italic' }}>
          {t('ticket.replyDeleted', { name: deletedByName ?? '', date: fmtDateTime(deletedAt) })}
        </div>
      ) : editing !== null ? (
        <div style={{ width: '75%', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <textarea value={editing} onChange={(e) => setEditing(e.target.value)} rows={3} aria-label={t('ticket.editReply')}
            style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8, border: `1px solid ${colors.border}`, fontSize: 14, fontFamily: 'inherit' }} />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" onClick={() => setEditing(null)}
              style={{ padding: '5px 12px', background: 'none', border: `1px solid ${colors.border}`, borderRadius: 6, fontSize: 13, cursor: 'pointer', color: colors.slate }}>
              {t('ticket.cancel')}
            </button>
            <button type="button" disabled={editing.trim() === ''}
              onClick={() => { void Promise.resolve(onEdit?.(editing.trim())).then(() => setEditing(null)) }}
              style={{ padding: '5px 12px', background: colors.brand, color: colors.white, border: 'none', borderRadius: 6, fontSize: 13, cursor: 'pointer' }}>
              {t('ticket.save')}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div style={{
            maxWidth:        '75%',
            padding:         '10px 14px',
            borderRadius:    isOwn ? '12px 4px 12px 12px' : '4px 12px 12px 12px',
            backgroundColor: isOwn ? colors.brandLight : colors.slateBg,
            color:           colors.slateDark,
            fontSize:        14,
            lineHeight:      1.6,
            whiteSpace:      'pre-wrap',
            wordBreak:       'break-word',
          }}>
            {body}
          </div>
          {editedAt && (
            <div style={{ fontSize: 11, color: colors.slateLight, marginTop: 2 }}>
              {t('ticket.replyEdited', { name: editedByName ?? '', date: fmtDateTime(editedAt) })}
            </div>
          )}
        </>
      )}
    </div>
  )
}
