import { useState, useRef, useEffect } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { gql } from '@apollo/client'
import { Lock, SendHorizontal } from 'lucide-react'
import { MentionInput } from '@/components/MentionInput'
import { MentionText } from '@/components/MentionText'

const GET_MESSAGES = gql`
  query InternalMessages($entityType: String!, $entityId: ID!, $limit: Int) {
    internalMessages(entityType: $entityType, entityId: $entityId, limit: $limit) {
      id authorId authorName body mentions createdAt editedAt
    }
  }
`

const SEND_MESSAGE = gql`
  mutation SendInternalMessage($entityType: String!, $entityId: ID!, $body: String!) {
    sendInternalMessage(entityType: $entityType, entityId: $entityId, body: $body) {
      id authorId authorName body createdAt
    }
  }
`

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

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'ora'
  if (mins < 60) return `${mins}m fa`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h fa`
  const days = Math.floor(hrs / 24)
  return `${days}g fa`
}

function initials(name: string): string {
  return name.split(' ').map(w => w[0] ?? '').join('').toUpperCase().slice(0, 2)
}

export function InternalChatPanel({ entityType, entityId, currentUserId }: Props) {
  const [body, setBody] = useState('')
  const listRef = useRef<HTMLDivElement>(null)

  const { data, refetch } = useQuery(GET_MESSAGES, {
    variables: { entityType, entityId, limit: 50 },
  })

  const [sendMessage, { loading: sending }] = useMutation(SEND_MESSAGE, {
    onCompleted: () => { setBody(''); refetch() },
  })

  const messages: Message[] = (data as { internalMessages?: Message[] } | undefined)?.internalMessages ?? []

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [messages.length])

  const handleSend = () => {
    const trimmed = body.trim()
    if (!trimmed || sending) return
    sendMessage({ variables: { entityType, entityId, body: trimmed } })
  }

  const isOwn = (msg: Message) => msg.authorId === currentUserId

  return (
    <div style={{ background: '#FFF7ED', border: '1px solid #fed7aa', borderRadius: 10, overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid #fed7aa' }}>
        <Lock size={15} color="#92400e" />
        <span style={{ fontWeight: 700, fontSize: 'var(--font-size-body)', color: '#92400e' }}>Chat interna</span>
        <span style={{
          marginLeft: 'auto', fontSize: 'var(--font-size-table)', fontWeight: 600, color: '#92400e',
          background: '#fde68a', padding: '2px 8px', borderRadius: 9999,
        }}>
          Solo agenti
        </span>
      </div>

      {/* Messages */}
      <div ref={listRef} style={{ maxHeight: 400, overflowY: 'auto', padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {messages.length === 0 && (
          <div style={{ textAlign: 'center', color: '#9ca3af', fontSize: 'var(--font-size-body)', padding: 20 }}>
            Nessun messaggio
          </div>
        )}
        {messages.map(msg => {
          const own = isOwn(msg)
          return (
            <div key={msg.id} style={{ display: 'flex', justifyContent: own ? 'flex-end' : 'flex-start' }}>
              <div style={{ display: 'flex', gap: 8, maxWidth: '80%', flexDirection: own ? 'row-reverse' : 'row' }}>
                {/* Avatar */}
                <div style={{
                  width: 30, height: 30, borderRadius: '50%', flexShrink: 0,
                  background: own ? '#0369a1' : '#6b7280', color: '#fff',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 'var(--font-size-table)', fontWeight: 700,
                }}>
                  {initials(msg.authorName)}
                </div>
                {/* Bubble */}
                <div style={{
                  background: own ? '#e0f2fe' : '#f8fafc', borderRadius: 8,
                  padding: '6px 10px', fontSize: 'var(--font-size-body)',
                }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 2 }}>
                    <span style={{ fontWeight: 700, fontSize: 'var(--font-size-body)' }}>{msg.authorName}</span>
                    <span style={{ fontSize: 'var(--font-size-table)', color: '#9ca3af' }}>{relativeTime(msg.createdAt)}</span>
                    {msg.editedAt && <span style={{ fontSize: 'var(--font-size-label)', color: '#9ca3af', fontStyle: 'italic' }}>(modificato)</span>}
                  </div>
                  <MentionText text={msg.body} />
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Input */}
      <div style={{ padding: '8px 14px', borderTop: '1px solid #fed7aa', display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <MentionInput
          value={body}
          onChange={setBody}
          placeholder="Scrivi un messaggio... (Ctrl+Enter per inviare)"
          onSubmit={handleSend}
          rows={2}
          style={{ flex: 1 }}
        />
        <button
          onClick={handleSend}
          disabled={sending || !body.trim()}
          style={{
            background: body.trim() ? '#0369a1' : '#d1d5db', color: '#fff',
            border: 'none', borderRadius: 8, padding: '8px 12px', cursor: body.trim() ? 'pointer' : 'default',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}
        >
          <SendHorizontal size={18} />
        </button>
      </div>
    </div>
  )
}
