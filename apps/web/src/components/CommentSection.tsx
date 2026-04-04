import { useState } from 'react'
import { gql } from '@apollo/client'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { MessageSquare, Lock, Pencil, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

const GET_COMMENTS = gql`
  query GetComments($entityType: String!, $entityId: String!, $includeInternal: Boolean) {
    comments(entityType: $entityType, entityId: $entityId, includeInternal: $includeInternal) {
      id body isInternal authorId authorName authorEmail createdAt updatedAt
    }
  }
`

const ADD_COMMENT = gql`
  mutation AddComment($entityType: String!, $entityId: String!, $body: String!, $isInternal: Boolean) {
    addComment(entityType: $entityType, entityId: $entityId, body: $body, isInternal: $isInternal) {
      id body isInternal authorId authorName authorEmail createdAt updatedAt
    }
  }
`

const UPDATE_COMMENT = gql`
  mutation UpdateComment($id: ID!, $body: String!) {
    updateComment(id: $id, body: $body) {
      id body updatedAt
    }
  }
`

const DELETE_COMMENT = gql`
  mutation DeleteComment($id: ID!) {
    deleteComment(id: $id)
  }
`

interface Comment {
  id:          string
  body:        string
  isInternal:  boolean
  authorId:    string
  authorName:  string
  authorEmail: string
  createdAt:   string
  updatedAt:   string
}

interface CommentSectionProps {
  entityType:      string
  entityId:        string
  currentUserId?:  string
  currentUserRole?: string
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const min  = Math.floor(diff / 60_000)
  if (min < 1)   return 'proprio ora'
  if (min < 60)  return `${min} min fa`
  const h = Math.floor(min / 60)
  if (h < 24)    return `${h} ore fa`
  const d = Math.floor(h / 24)
  if (d < 7)     return `${d} giorni fa`
  return new Date(dateStr).toLocaleDateString()
}

function Avatar({ name }: { name: string }) {
  const initials = name.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((s) => s[0]?.toUpperCase() ?? '').join('')
  return (
    <div style={{
      width: 32, height: 32, borderRadius: '50%', background: 'var(--color-brand)',
      color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 12, fontWeight: 700, flexShrink: 0,
    }}>
      {initials || '?'}
    </div>
  )
}

export function CommentSection({ entityType, entityId, currentUserId, currentUserRole }: CommentSectionProps) {
  const { t } = useTranslation()
  const [body,       setBody]       = useState('')
  const [isInternal, setIsInternal] = useState(false)
  const [editId,     setEditId]     = useState<string | null>(null)
  const [editBody,   setEditBody]   = useState('')
  const [deleteId,   setDeleteId]   = useState<string | null>(null)
  const [collapsed,  setCollapsed]  = useState(false)

  const { data, loading, refetch } = useQuery<{ comments: Comment[] }>(
    GET_COMMENTS,
    { variables: { entityType, entityId, includeInternal: true }, fetchPolicy: 'cache-and-network' },
  )

  const [addComment, { loading: adding }] = useMutation(ADD_COMMENT, {
    onCompleted: () => { setBody(''); void refetch() },
    onError: (e: { message: string }) => toast.error(e.message),
  })

  const [updateComment] = useMutation(UPDATE_COMMENT, {
    onCompleted: () => { setEditId(null); setEditBody(''); void refetch() },
    onError: (e: { message: string }) => toast.error(e.message),
  })

  const [deleteComment] = useMutation(DELETE_COMMENT, {
    onCompleted: () => { setDeleteId(null); void refetch() },
    onError: (e: { message: string }) => toast.error(e.message),
  })

  const items = data?.comments ?? []

  function canEdit(c: Comment): boolean {
    if (c.authorId !== currentUserId) return false
    const ageMs = Date.now() - new Date(c.createdAt).getTime()
    return ageMs < 15 * 60 * 1000
  }

  function canDelete(c: Comment): boolean {
    return c.authorId === currentUserId || currentUserRole === 'admin'
  }

  function handleSubmit() {
    if (!body.trim()) return
    void addComment({ variables: { entityType, entityId, body, isInternal } })
  }

  return (
    <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, overflow: 'hidden', marginTop: 16 }}>
      {/* Header */}
      <div
        onClick={() => setCollapsed((c) => !c)}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', background: '#f8fafc', cursor: 'pointer', borderBottom: collapsed ? 'none' : '1px solid #e2e8f0' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <MessageSquare size={16} color="var(--color-brand)" />
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-slate-dark)' }}>
            {t('comments.title')} {items.length > 0 && `(${items.length})`}
          </span>
        </div>
        <span style={{ fontSize: 12, color: '#94a3b8' }}>{collapsed ? '▼' : '▲'}</span>
      </div>

      {!collapsed && (
        <div style={{ padding: 16 }}>
          {/* Comment list */}
          {loading ? (
            <div style={{ fontSize: 13, color: '#94a3b8', marginBottom: 16 }}>{t('common.loading')}</div>
          ) : items.length === 0 ? (
            <div style={{ fontSize: 13, color: '#94a3b8', textAlign: 'center', padding: '8px 0', marginBottom: 16 }}>
              {t('comments.noComments')}
            </div>
          ) : (
            <div style={{ marginBottom: 16 }}>
              {items.map((c) => (
                <div
                  key={c.id}
                  style={{
                    display: 'flex', gap: 12, padding: '10px 12px', borderRadius: 8, marginBottom: 8,
                    background: c.isInternal ? '#FEF9C3' : '#fff',
                    border: `1px solid ${c.isInternal ? '#FDE68A' : '#f1f5f9'}`,
                  }}
                >
                  <Avatar name={c.authorName || c.authorEmail} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: '#1a2332' }}>
                        {c.authorName || c.authorEmail}
                      </span>
                      <span style={{ fontSize: 11, color: '#94a3b8' }}>{timeAgo(c.createdAt)}</span>
                      {c.isInternal && (
                        <span style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10, fontWeight: 600, color: '#92400E', background: '#FDE68A', padding: '1px 6px', borderRadius: 8 }}>
                          <Lock size={9} /> {t('comments.internal')}
                        </span>
                      )}
                    </div>

                    {editId === c.id ? (
                      <div>
                        <textarea
                          value={editBody}
                          onChange={(e) => setEditBody(e.target.value)}
                          rows={3}
                          style={{ width: '100%', padding: 8, borderRadius: 4, border: '1px solid #e2e8f0', fontSize: 13, resize: 'vertical', boxSizing: 'border-box' }}
                        />
                        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                          <button
                            onClick={() => void updateComment({ variables: { id: c.id, body: editBody } })}
                            style={{ padding: '4px 12px', fontSize: 12, borderRadius: 4, border: 'none', background: 'var(--color-brand)', color: '#fff', cursor: 'pointer' }}
                          >
                            {t('common.save')}
                          </button>
                          <button
                            onClick={() => { setEditId(null); setEditBody('') }}
                            style={{ padding: '4px 10px', fontSize: 12, borderRadius: 4, border: '1px solid #e2e8f0', background: '#fff', cursor: 'pointer' }}
                          >
                            {t('common.cancel')}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <p style={{ margin: 0, fontSize: 13, color: '#334155', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{c.body}</p>
                    )}
                  </div>

                  {editId !== c.id && (
                    <div style={{ display: 'flex', gap: 6, flexShrink: 0, alignItems: 'flex-start' }}>
                      {canEdit(c) && (
                        <button
                          onClick={() => { setEditId(c.id); setEditBody(c.body) }}
                          style={{ color: '#94a3b8', background: 'none', border: 'none', cursor: 'pointer', padding: 2 }}
                          title={t('common.edit')}
                        >
                          <Pencil size={13} />
                        </button>
                      )}
                      {canDelete(c) && (
                        deleteId === c.id ? (
                          <div style={{ display: 'flex', gap: 4 }}>
                            <button
                              onClick={() => void deleteComment({ variables: { id: c.id } })}
                              style={{ padding: '2px 6px', fontSize: 11, borderRadius: 4, border: 'none', background: '#ef4444', color: '#fff', cursor: 'pointer' }}
                            >
                              {t('common.confirm')}
                            </button>
                            <button
                              onClick={() => setDeleteId(null)}
                              style={{ padding: '2px 6px', fontSize: 11, borderRadius: 4, border: '1px solid #e2e8f0', background: '#fff', cursor: 'pointer' }}
                            >
                              {t('common.cancel')}
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setDeleteId(c.id)}
                            style={{ color: '#94a3b8', background: 'none', border: 'none', cursor: 'pointer', padding: 2 }}
                            title={t('common.delete')}
                          >
                            <Trash2 size={13} />
                          </button>
                        )
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Input form */}
          <div style={{ borderTop: items.length > 0 ? '1px solid #f1f5f9' : 'none', paddingTop: items.length > 0 ? 12 : 0 }}>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={t('comments.placeholder')}
              rows={3}
              maxLength={10_000}
              style={{ width: '100%', padding: 10, borderRadius: 6, border: '1px solid #e2e8f0', fontSize: 13, resize: 'vertical', boxSizing: 'border-box', fontFamily: 'inherit' }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#475569', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={isInternal}
                  onChange={(e) => setIsInternal(e.target.checked)}
                  style={{ accentColor: 'var(--color-brand)' }}
                />
                <Lock size={12} />
                {t('comments.internalNote')}
              </label>
              <button
                onClick={handleSubmit}
                disabled={adding || !body.trim()}
                style={{
                  padding: '7px 16px', borderRadius: 6, border: 'none',
                  background: body.trim() ? 'var(--color-brand)' : '#e2e8f0',
                  color: body.trim() ? '#fff' : '#94a3b8',
                  cursor: body.trim() ? 'pointer' : 'not-allowed',
                  fontSize: 13, fontWeight: 500,
                }}
              >
                {adding ? t('common.loading') : t('comments.send')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
