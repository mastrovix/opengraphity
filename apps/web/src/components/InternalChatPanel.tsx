import { useState, useRef, useEffect } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { Lock, SendHorizontal, Pencil, Trash2 } from 'lucide-react'
import { MentionInput } from '@/components/MentionInput'
import { MentionText } from '@/components/MentionText'
import { GET_INTERNAL_MESSAGES } from '@/graphql/queries'
import { SEND_INTERNAL_MESSAGE, EDIT_INTERNAL_MESSAGE, DELETE_INTERNAL_MESSAGE } from '@/graphql/mutations'
import { useConfirm } from '@/hooks/useConfirm'
import { timeAgo } from '@/lib/datetime'
import { colors, palette } from '@/lib/tokens'
import { showError } from '@/lib/showError'
import { useMe } from '@/hooks/useMe'
import { sendShortcutLabel } from '@/lib/platform'

interface Message {
  id: string
  authorId: string
  authorName: string
  body: string
  mentions?: string[]
  createdAt: string
  editedAt?: string | null
}

interface Props {
  entityType: string
  entityId: string
  currentUserId: string
}

function initials(name: string): string {
  return name.split(' ').map(w => w[0] ?? '').join('').toUpperCase().slice(0, 2)
}

/**
 * SENT MEANS SHOWN (D13, tour of 23 Sep 2026).
 *
 * After «send» the message appeared only at the next reading of the list, a
 * few seconds later, and the text stayed in the box meanwhile — it looked
 * like nothing had happened, and a second «send» was the natural reaction.
 * Now the box empties at once and the message is in the list at once
 * (`optimisticResponse`); the server's answer replaces it in the cache
 * (`update`). On an error the message leaves the list and its text comes
 * back in the box, so it can be sent again: it is never lost.
 */
function useSendMessage(entityType: string, entityId: string, currentUserId: string, setBody: (update: (current: string) => string) => void) {
  const { t } = useTranslation()
  const { me } = useMe()
  const listVariables = { entityType, entityId, limit: 50 }
  const [sendMessage, { loading }] = useMutation<{ sendInternalMessage: Message }>(SEND_INTERNAL_MESSAGE, {
    update: (cache, { data }) => {
      const sent = data?.sendInternalMessage
      if (!sent) return
      cache.updateQuery<{ internalMessages: Message[] }>({ query: GET_INTERNAL_MESSAGES, variables: listVariables }, (prev) =>
        prev ? { internalMessages: [...prev.internalMessages.filter((m) => m.id !== sent.id), sent] } : prev)
    },
  })
  const send = (text: string) => {
    setBody(() => '')
    void sendMessage({
      variables: { entityType, entityId, body: text },
      optimisticResponse: { sendInternalMessage: {
        __typename: 'InternalMessage', id: `optimistic-${String(Date.now())}`, authorId: currentUserId,
        authorName: me?.name ?? '', body: text, mentions: [], createdAt: new Date().toISOString(), editedAt: null,
      } as Message },
      // Il testo NON si perde su errore: torna nella casella, e l'utente può ritentare l'invio.
      onError: (e) => {
        setBody((current) => (current === '' ? text : current))
        showError(e, t('toast.internalChat.sendFailed', { error: e.message }))
      },
    })
  }
  return { send, sending: loading }
}

export function InternalChatPanel({ entityType, entityId, currentUserId }: Props) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const [body, setBody] = useState('')
  const listRef = useRef<HTMLDivElement>(null)

  const { data, refetch } = useQuery<{ internalMessages: Message[] }>(GET_INTERNAL_MESSAGES, {
    variables: { entityType, entityId, limit: 50 },
  })

  const { send, sending } = useSendMessage(entityType, entityId, currentUserId, setBody)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editBody, setEditBody]   = useState('')
  const [editMessage, { loading: editing }] = useMutation(EDIT_INTERNAL_MESSAGE, {
    onCompleted: () => { setEditingId(null); setEditBody(''); void refetch() },
    onError: (e) => showError(e, t('toast.internalChat.editFailed', { error: e.message })),
  })
  const [deleteMessage] = useMutation(DELETE_INTERNAL_MESSAGE, {
    onCompleted: () => void refetch(),
    onError: (e) => showError(e, t('toast.internalChat.deleteFailed', { error: e.message })),
  })

  const messages: Message[] = data?.internalMessages ?? []

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [messages.length])

  const handleSend = () => {
    const trimmed = body.trim()
    if (!trimmed || sending) return
    send(trimmed)
  }

  const handleDelete = async (msg: Message) => {
    const ok = await confirm({ title: t('internalChat.confirmDelete'), danger: true })
    if (ok) void deleteMessage({ variables: { messageId: msg.id } })
  }

  const isOwn = (msg: Message) => msg.authorId === currentUserId

  return (
    <div style={{ background: palette.orange.bg, border: `1px solid ${palette.orange.border}`, borderRadius: 10, overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: `1px solid ${palette.orange.border}` }}>
        <Lock size={15} color={palette.warning.strong} aria-hidden="true" />
        <span style={{ fontWeight: 700, fontSize: 'var(--font-size-body)', color: palette.warning.strong }}>{t('internalChat.title')}</span>
        <span style={{
          marginLeft: 'auto', fontSize: 'var(--font-size-table)', fontWeight: 600, color: palette.warning.strong,
          background: palette.warning.tint, padding: '2px 8px', borderRadius: 9999,
        }}>
          {t('internalChat.agentsOnly')}
        </span>
      </div>

      {/* Messages */}
      <div ref={listRef} style={{ maxHeight: 400, overflowY: 'auto', padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {messages.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)', padding: 20 }}>
            {t('internalChat.empty')}
          </div>
        )}
        {messages.map(msg => {
          const own = isOwn(msg)
          return (
            <div key={msg.id} style={{ display: 'flex', justifyContent: own ? 'flex-end' : 'flex-start' }}>
              <div style={{ display: 'flex', gap: 8, maxWidth: '80%', flexDirection: own ? 'row-reverse' : 'row' }}>
                {/* Avatar */}
                <div aria-hidden="true" style={{
                  width: 30, height: 30, borderRadius: '50%', flexShrink: 0,
                  background: own ? 'var(--accent-hover)' : 'var(--color-slate)', color: colors.white,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 'var(--font-size-table)', fontWeight: 700,
                }}>
                  {initials(msg.authorName)}
                </div>
                {/* Bubble */}
                <div style={{
                  background: own ? palette.info.tint : 'var(--color-slate-bg)', borderRadius: 8,
                  padding: '6px 10px', fontSize: 'var(--font-size-body)',
                }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 2 }}>
                    <span style={{ fontWeight: 700, fontSize: 'var(--font-size-body)' }}>{msg.authorName}</span>
                    <span style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>{timeAgo(msg.createdAt)}</span>
                    {msg.editedAt && <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)', fontStyle: 'italic' }}>({t('internalChat.edited')})</span>}
                    {own && editingId !== msg.id && (
                      <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
                        <button type="button" title={t('common.edit')} aria-label={t('common.edit')} onClick={() => { setEditingId(msg.id); setEditBody(msg.body) }}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-slate)', padding: 0, display: 'inline-flex' }}>
                          <Pencil size={12} aria-hidden="true" />
                        </button>
                        <button type="button" title={t('common.delete')} aria-label={t('common.delete')} onClick={() => void handleDelete(msg)}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-danger)', padding: 0, display: 'inline-flex' }}>
                          <Trash2 size={12} aria-hidden="true" />
                        </button>
                      </span>
                    )}
                  </div>
                  {editingId === msg.id ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <textarea value={editBody} onChange={(e) => setEditBody(e.target.value)} rows={2} aria-label={t('common.edit')}
                        style={{ width: '100%', border: '1px solid var(--border-strong)', borderRadius: 6, padding: 6, fontSize: 'var(--font-size-body)', resize: 'vertical', boxSizing: 'border-box' }} />
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                        <button type="button" onClick={() => { setEditingId(null); setEditBody('') }}
                          style={{ background: colors.white, border: '1px solid var(--border)', borderRadius: 6, padding: '3px 10px', cursor: 'pointer', fontSize: 'var(--font-size-table)' }}>{t('common.cancel')}</button>
                        <button type="button" disabled={editing || !editBody.trim()} onClick={() => void editMessage({ variables: { messageId: msg.id, body: editBody.trim() } })}
                          style={{ background: 'var(--accent-hover)', color: colors.white, border: 'none', borderRadius: 6, padding: '3px 10px', cursor: 'pointer', fontSize: 'var(--font-size-table)', fontWeight: 600, opacity: (editing || !editBody.trim()) ? 0.6 : 1 }}>{t('common.save')}</button>
                      </div>
                    </div>
                  ) : (
                    <MentionText text={msg.body} />
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Input */}
      <div style={{ padding: '8px 14px', borderTop: `1px solid ${palette.orange.border}`, display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <MentionInput
          value={body}
          onChange={setBody}
          placeholder={t('internalChat.placeholder', { shortcut: sendShortcutLabel() })}
          label={t('internalChat.title')}
          onSubmit={handleSend}
          rows={2}
          style={{ flex: 1 }}
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={sending || !body.trim()}
          aria-label={t('internalChat.send')}
          title={t('internalChat.send')}
          style={{
            background: body.trim() ? 'var(--accent-hover)' : palette.neutral.borderStrong, color: colors.white,
            border: 'none', borderRadius: 8, padding: '8px 12px', cursor: body.trim() ? 'pointer' : 'default',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}
        >
          <SendHorizontal size={18} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
