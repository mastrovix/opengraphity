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
import { useTranslation } from 'react-i18next'
import { SectionCard } from '@/components/ui/SectionCard'
import { Label } from '@/components/ui/label'
import { MentionInput } from '@/components/MentionInput'
import { MentionText } from '@/components/MentionText'
import { timeAgo } from '@/lib/datetime'
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
}

interface Props {
  comments:     TicketComment[]
  onAdd:        (text: string, isInternal: boolean) => Promise<unknown> | void
  adding:       boolean
  defaultOpen?: boolean
}

export function CommentsSection({ comments, onAdd, adding, defaultOpen = false }: Props) {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const [isInternal, setIsInternal] = useState(true)
  const canSend = text.trim().length > 0 && !adding
  const initials = (name?: string) => name ? name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase() : '?'

  const submit = async () => {
    if (!canSend) return
    await onAdd(text.trim(), isInternal)
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
                    {initials(c.author?.name ?? (c.authorKind === 'monitoring' ? t('detail.commentByMonitoring') : c.authorLabel ?? undefined))}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', marginBottom: 4 }}>
                      <span style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--text-primary)' }}>{c.author?.name
                        ?? (c.authorKind === 'monitoring' ? t('detail.commentByMonitoring')
                          : c.authorKind === 'automation' ? t('detail.commentByAutomation', { name: c.authorLabel ?? '' })
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
                    </div>
                    <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--text-secondary)', lineHeight: 1.6, margin: 0 }}><MentionText text={c.text} /></p>
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
