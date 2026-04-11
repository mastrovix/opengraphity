import { useParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@apollo/client/react'
import { PageContainer } from '@/components/PageContainer'
import { DetailCard } from '@/components/ui/DetailCard'
import { DetailField } from '@/components/ui/DetailField'
import { Skeleton } from '@/components/ui/skeleton'
import { WatcherBar } from '@/components/WatcherBar'
import { InternalChatPanel } from '@/components/InternalChatPanel'
import { keycloak } from '@/lib/keycloak'
import { GET_SERVICE_REQUEST } from '@/graphql/queries'

interface ServiceRequest {
  id: string; title: string; description: string | null
  status: string; priority: string; dueDate: string | null
  createdAt: string; updatedAt: string; completedAt: string | null
  requestedBy: { id: string; name: string; email: string } | null
  assignee: { id: string; name: string; email: string } | null
}

const PRIORITY_COLOR: Record<string, string> = { critical: '#ef4444', high: '#f97316', medium: '#eab308', low: '#22c55e' }
const STATUS_COLOR: Record<string, { bg: string; fg: string }> = {
  open:        { bg: '#dbeafe', fg: '#1d4ed8' },
  in_progress: { bg: '#fef3c7', fg: '#92400e' },
  completed:   { bg: '#d1fae5', fg: '#065f46' },
  cancelled:   { bg: '#f3f4f6', fg: '#6b7280' },
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'ora'
  if (mins < 60) return `${mins}min fa`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h fa`
  return `${Math.floor(hrs / 24)}gg fa`
}

export function ServiceRequestDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { data, loading } = useQuery<{ serviceRequest: ServiceRequest | null }>(GET_SERVICE_REQUEST, { variables: { id }, skip: !id })
  const sr = data?.serviceRequest

  if (loading) return <PageContainer><Skeleton style={{ height: 300 }} /></PageContainer>
  if (!sr) return (
    <PageContainer>
      <p style={{ color: 'var(--color-slate)', fontSize: 'var(--font-size-body)' }}>Service request non trovata.</p>
      <button onClick={() => navigate('/requests')} style={{ color: 'var(--color-brand)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--font-size-body)' }}>Torna alla lista</button>
    </PageContainer>
  )

  const stColor = STATUS_COLOR[sr.status] ?? { bg: '#f3f4f6', fg: '#6b7280' }

  return (
    <PageContainer>
      {/* Back */}
      <button
        onClick={() => navigate('/requests')}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', marginBottom: 16, padding: 0 }}
      >
        ← Service Requests
      </button>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
        <div>
          <h1 style={{ fontSize: 'var(--font-size-page-title)', fontWeight: 700, color: 'var(--color-slate-dark)', margin: '0 0 6px' }}>{sr.title}</h1>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ padding: '2px 8px', borderRadius: 6, fontSize: 'var(--font-size-table)', fontWeight: 600, background: stColor.bg, color: stColor.fg }}>{sr.status}</span>
            <span style={{ padding: '2px 8px', borderRadius: 6, fontSize: 'var(--font-size-table)', fontWeight: 600, border: `1.5px solid ${PRIORITY_COLOR[sr.priority] ?? '#9ca3af'}`, color: PRIORITY_COLOR[sr.priority] ?? '#9ca3af' }}>{sr.priority}</span>
            <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>{timeAgo(sr.createdAt)}</span>
          </div>
        </div>
        <WatcherBar entityType="service_request" entityId={sr.id} />
      </div>

      {/* Body */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: 24 }}>
        <div>
          {/* Description */}
          <div style={{ marginBottom: 16 }}>
            <DetailCard title="Descrizione">
              <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', lineHeight: 1.6, margin: 0 }}>{sr.description || 'Nessuna descrizione.'}</p>
            </DetailCard>
          </div>

          {/* Internal Chat */}
          <InternalChatPanel entityType="service_request" entityId={sr.id} currentUserId={keycloak.subject ?? ''} />
        </div>

        {/* Sidebar */}
        <DetailCard title="Dettagli">
          <DetailField label="Richiedente" value={sr.requestedBy?.name ?? null} />
          <DetailField label="Assegnatario" value={sr.assignee?.name ?? null} />
          <DetailField label="Scadenza" value={sr.dueDate ? new Date(sr.dueDate).toLocaleDateString('it-IT') : null} />
          <DetailField label="Creato il" value={new Date(sr.createdAt).toLocaleDateString('it-IT')} />
          {sr.completedAt && <DetailField label="Completato" value={new Date(sr.completedAt).toLocaleDateString('it-IT')} />}
        </DetailCard>
      </div>
    </PageContainer>
  )
}
