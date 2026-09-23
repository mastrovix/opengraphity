/**
 * Sezione commenti di un ticket (incident, problem): elenco con avatar a
 * iniziali + editor con menzioni. Una sola implementazione al posto dei due
 * blocchi identici nelle pagine di dettaglio; lo stato del testo è interno.
 *
 * Revisione del 14 set 2026 · F1: i commenti sono gli stessi che l'utente
 * finale vede dal portale. Ogni commento dice se è una nota interna o una
 * risposta pubblica, e chi scrive sceglie; la scelta di partenza è la nota
 * interna, così un testo dello staff non arriva all'utente per distrazione.
 */
import { useState } from 'react'
import { useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Bot, Pencil, Trash2 } from 'lucide-react'
import { UPDATE_COMMENT, DELETE_COMMENT } from '@/graphql/mutations'
import { useMe } from '@/hooks/useMe'
import { useConfirm } from '@/hooks/useConfirm'
import { SectionCard } from '@/components/ui/SectionCard'
import { Label } from '@/components/ui/label'
import { MentionInput } from '@/components/MentionInput'
import { MentionText } from '@/components/MentionText'
import { formatDateTime, timeAgo } from '@/lib/datetime'
import { colors } from '@/lib/tokens'
import { srOnlyStyle } from '@/lib/a11y'

export interface TicketComment {
  id:        string
  text:      string
  createdAt: string
  author?:   { id: string; name: string } | null
  /** Chi l'ha scritto quando non è una persona: una regola ('automation') o il monitoraggio. */
  authorKind?:  string | null
  authorLabel?: string | null
  /** Nota di lavoro (solo staff) o risposta pubblica (visibile dal portale). */
  isInternal:   boolean
  /** Traccia di modifica e cancellazione (ondata 6 di «Nulla cablato»). */
  editedAt?:      string | null
  editedByName?:  string | null
  deletedAt?:     string | null
  deletedByName?: string | null
}

interface Props {
  comments:     TicketComment[]
  /**
   * Adds the comment. Whoever passes it says why when it fails (the pages'
   * mutation `onError`): a rejection only tells this section the comment was
   * not added, so the text stays in the box.
   */
  onAdd:        (text: string, isInternal: boolean) => Promise<unknown> | void
  adding:       boolean
  defaultOpen?: boolean
  /** Dopo una modifica o una cancellazione: la pagina ricarica i commenti. */
  onChanged?:   () => void
}

/**
 * Chi può toccare un commento: l'autore il proprio, l'admin qualunque (le
 * stesse regole dell'API). Un commento scritto da una regola o dal monitoraggio
 * non ha un autore persona: lo tocca solo l'admin.
 */
export function canChangeComment(c: TicketComment, me: { id: string } | null, moderates: boolean): boolean {
  if (c.deletedAt) return false
  return moderates || (!!me && c.author?.id === me.id)
}

export function CommentsSection({ comments, onAdd, adding, defaultOpen = false, onChanged }: Props) {
  const { t } = useTranslation()
  const { me, can } = useMe()
  const moderates = can('ticket.moderateComments')
  const confirm = useConfirm()
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const [updateComment, { loading: updating }] = useMutation(UPDATE_COMMENT, {
    onCompleted: () => { toast.success(t('detail.commentEdited')); setEditing(null); onChanged?.() },
  })
  const [deleteComment] = useMutation(DELETE_COMMENT, {
    onCompleted: () => { toast.success(t('detail.commentDeleted')); onChanged?.() },
  })
  const askDelete = async (id: string) => {
    if (await confirm({ title: t('detail.deleteComment'), body: t('detail.deleteCommentConfirm') })) void deleteComment({ variables: { id } })
  }
  const [text, setText] = useState('')
  const [isInternal, setIsInternal] = useState(true)
  const canSend = text.trim().length > 0 && !adding
  const initials = (name?: string) => name ? name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase() : '?'

  const submit = async () => {
    if (!canSend) return
    try {
      await onAdd(text.trim(), isInternal)
    } catch {
      // Refused: the mutation's `onError` has already said why, and Apollo 4
      // rejects its promise as well — left uncaught, every refused comment was
      // an «Uncaught (in promise)». Text and visibility stay, to be sent again.
      return
    }
    setText('')
    setIsInternal(true)
  }

  return (
    <SectionCard title={t('detail.sections.comments')} count={comments.length} collapsible defaultOpen={defaultOpen}>
      <div>
        {comments.length === 0 ? (
          <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--text-muted)', margin: '0 0 16px 0' }}>{t('detail.noCommentsYet')}</p>
        ) : (
          <div style={{ marginBottom: 16 }}>
            {comments.slice().reverse().map((c, i) => (
              <div key={c.id}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 0' }}>
                  <div style={{ width: 32, height: 32, borderRadius: '50%', backgroundColor: 'var(--color-brand-light)', color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'var(--font-size-body)', fontWeight: 700, flexShrink: 0 }}>
                    {/* U-8: chi non è una persona ha l'icona, non le iniziali (o «?») di un nome che non ha. */}
                    {!c.author?.name && c.authorKind
                      ? <Bot size={16} aria-hidden="true" data-testid="comment-bot-avatar" />
                      : initials(c.author?.name)}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', marginBottom: 4, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--text-primary)' }}>{c.author?.name
                        ?? (c.authorKind === 'monitoring' ? t('detail.commentByMonitoring')
                          // U-8: senza il nome della regola si legge «Automazione», non «Automazione:» vuoto.
                          : c.authorKind === 'automation' ? (c.authorLabel ? t('detail.commentByAutomation', { name: c.authorLabel }) : t('detail.commentByAutomationUnnamed'))
                          : t('detail.unknownUser'))}</span>
                      <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--text-muted)' }}>{timeAgo(c.createdAt)}</span>
                      <span
                        data-testid="comment-visibility"
                        style={{
                          fontSize: 'var(--font-size-table)', fontWeight: 600, padding: '1px 8px', borderRadius: 9999,
                          backgroundColor: c.isInternal ? 'var(--surface-2)' : 'var(--color-brand-light)',
                          color: c.isInternal ? 'var(--text-muted)' : 'var(--accent)',
                        }}
                      >
                        {c.isInternal ? t('detail.commentInternal') : t('detail.commentPublic')}
                      </span>
                      {canChangeComment(c, me, moderates) && editing?.id !== c.id && (
                        <span style={{ marginLeft: 'auto', display: 'flex', gap: 2 }}>
                          <button type="button" aria-label={t('detail.editComment')} title={t('detail.editComment')} onClick={() => setEditing({ id: c.id, text: c.text })}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4, display: 'flex' }}>
                            <Pencil size={13} aria-hidden="true" />
                          </button>
                          <button type="button" aria-label={t('detail.deleteComment')} title={t('detail.deleteComment')} onClick={() => void askDelete(c.id)}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4, display: 'flex' }}>
                            <Trash2 size={13} aria-hidden="true" />
                          </button>
                        </span>
                      )}
                    </div>
                    {c.deletedAt ? (
                      <p data-testid="comment-deleted" style={{ fontSize: 'var(--font-size-body)', color: 'var(--text-muted)', fontStyle: 'italic', lineHeight: 1.6, margin: 0 }}>
                        {t('detail.commentDeletedBy', { name: c.deletedByName ?? t('detail.unknownUser'), date: formatDateTime(c.deletedAt) })}
                      </p>
                    ) : editing?.id === c.id ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <MentionInput value={editing.text} onChange={(v) => setEditing({ id: c.id, text: v })} rows={3} placeholder={t('detail.commentPlaceholder')} />
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button type="button" disabled={updating || editing.text.trim() === ''}
                            onClick={() => void updateComment({ variables: { id: c.id, body: editing.text.trim() } })}
                            style={{ padding: '5px 12px', backgroundColor: 'var(--accent)', color: colors.white, border: 'none', borderRadius: 6, fontSize: 'var(--font-size-body)', cursor: 'pointer' }}>
                            {t('common.save')}
                          </button>
                          <button type="button" onClick={() => setEditing(null)}
                            style={{ padding: '5px 12px', background: 'none', border: '1px solid var(--border)', borderRadius: 6, fontSize: 'var(--font-size-body)', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                            {t('common.cancel')}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--text-secondary)', lineHeight: 1.6, margin: 0 }}><MentionText text={c.text} /></p>
                        {c.editedAt && (
                          <p data-testid="comment-edited" title={formatDateTime(c.editedAt)} style={{ fontSize: 'var(--font-size-label)', color: 'var(--text-muted)', margin: '2px 0 0' }}>
                            {t('detail.commentEditedBy', { name: c.editedByName ?? t('detail.unknownUser'), date: formatDateTime(c.editedAt) })}
                          </p>
                        )}
                      </>
                    )}
                  </div>
                </div>
                {i < comments.length - 1 && <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: 0 }} />}
              </div>
            ))}
          </div>
        )}
        <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '0 0 16px 0' }} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Label style={{ fontSize: 'var(--font-size-body)' }}>{t('detail.writeComment')}</Label>
          <MentionInput value={text} onChange={setText} placeholder={t('detail.commentPlaceholder')} rows={3} />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <fieldset style={{ display: 'flex', gap: 16, border: 'none', margin: 0, padding: 0 }}>
              <legend style={srOnlyStyle}>{t('detail.commentVisibility')}</legend>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-body)', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                <input type="radio" name="comment-visibility" checked={isInternal} onChange={() => setIsInternal(true)} />
                {t('detail.commentAsInternal')}
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-body)', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                <input type="radio" name="comment-visibility" checked={!isInternal} onChange={() => setIsInternal(false)} />
                {t('detail.commentAsPublic')}
              </label>
            </fieldset>
            <button type="button" disabled={!canSend} onClick={() => void submit()}
              style={{ padding: '7px 16px', backgroundColor: canSend ? 'var(--accent)' : 'var(--surface-2)', color: canSend ? colors.white : 'var(--text-muted)', border: 'none', borderRadius: 6, fontSize: 'var(--font-size-card-title)', fontWeight: 500, cursor: canSend ? 'pointer' : 'not-allowed' }}>
              {adding ? t('detail.sending') : isInternal ? t('detail.sendInternalNote') : t('detail.sendPublicReply')}
            </button>
          </div>
        </div>
      </div>
    </SectionCard>
  )
}
