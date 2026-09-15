/**
 * La sezione commenti per i ticket che non hanno una query di dettaglio con i
 * commenti dentro (change, richieste) — revisione del 14 set 2026 · F13.
 *
 * Prima le change non avevano commenti (solo l'audit) e le richieste nessuno:
 * chi ci lavorava non poteva lasciare una nota, e l'utente non poteva ricevere
 * una risposta. Lo stesso modello e la stessa sezione degli incident e dei
 * problem (`CommentsSection`), letti e scritti con l'API generica dei commenti.
 */
import { useQuery, useMutation } from '@apollo/client/react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { GET_ENTITY_COMMENTS } from '@/graphql/queries'
import { ADD_ENTITY_COMMENT } from '@/graphql/mutations'
import { CommentsSection, type TicketComment } from './CommentsSection'

interface EntityCommentRow {
  id: string; body: string; isInternal: boolean
  authorId: string; authorName: string; authorEmail: string
  createdAt: string; updatedAt: string
  editedAt: string | null; editedByName: string | null; deletedAt: string | null; deletedByName: string | null
}

/** Chi scrive senza essere una persona: monitoraggio e automazioni hanno un attore riconoscibile. */
function toTicketComment(c: EntityCommentRow): TicketComment {
  const machine = c.authorId === 'monitoring' ? 'monitoring' : (c.authorId === 'automation' || c.authorId === 'system') ? 'automation' : null
  return {
    id: c.id, text: c.body, createdAt: c.createdAt, isInternal: c.isInternal,
    author: machine ? null : { id: c.authorId, name: c.authorName || c.authorEmail },
    authorKind: machine, authorLabel: machine === 'automation' ? c.authorName : null,
    editedAt: c.editedAt, editedByName: c.editedByName, deletedAt: c.deletedAt, deletedByName: c.deletedByName,
  }
}

export function EntityCommentsSection({ entityType, entityId }: { entityType: 'change' | 'service_request'; entityId: string }) {
  const { t } = useTranslation()
  const variables = { entityType, entityId }
  const { data, refetch } = useQuery<{ comments: EntityCommentRow[] }>(GET_ENTITY_COMMENTS, { variables })
  const [add, { loading }] = useMutation(ADD_ENTITY_COMMENT, {
    refetchQueries: [{ query: GET_ENTITY_COMMENTS, variables }],
    onError: (e) => toast.error(e.message),
    onCompleted: () => toast.success(t('toast.comment.added')),
  })
  return (
    <CommentsSection
      comments={(data?.comments ?? []).map(toTicketComment)}
      adding={loading}
      onChanged={() => void refetch()}
      onAdd={(text, isInternal) => add({ variables: { ...variables, body: text, isInternal } })}
    />
  )
}
