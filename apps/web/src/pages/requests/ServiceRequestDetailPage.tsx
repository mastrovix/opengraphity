import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation } from '@apollo/client/react'
import { toast } from 'sonner'
import { PageContainer } from '@/components/PageContainer'
import { QueryError } from '@/components/QueryError'
import { SectionCard } from '@/components/ui/SectionCard'
import { DetailField } from '@/components/ui/DetailField'
import { Pill } from '@/components/ui/Pill'
import { Skeleton } from '@/components/ui/skeleton'
import { WatcherBar } from '@/components/WatcherBar'
import { AttachmentsSection } from '@/components/AttachmentsSection'
import { InternalChatPanel } from '@/components/InternalChatPanel'
import { Modal } from '@/components/Modal'
import { Button } from '@/components/Button'
import { Input, Textarea, Select, FieldLabel } from '@/components/ui/FormControls'
import { Pencil } from 'lucide-react'
import { keycloak } from '@/lib/keycloak'
import { lookupOrError } from '@/lib/tokens'
import { GET_SERVICE_REQUEST } from '@/graphql/queries'
import { EXECUTE_WORKFLOW_TRANSITION, UPDATE_SERVICE_REQUEST } from '@/graphql/mutations'

interface WorkflowTransition { toStep: string; label: string; requiresInput: boolean; inputField: string | null }
interface ServiceRequest {
  id: string; title: string; description: string | null
  status: string; priority: string; dueDate: string | null
  createdAt: string; updatedAt: string; completedAt: string | null
  requestedBy: { id: string; name: string; email: string } | null
  assignee: { id: string; name: string; email: string } | null
  workflowInstance: { id: string; currentStep: string; status: string } | null
  availableTransitions: WorkflowTransition[]
}

const PRIORITY_COLOR: Record<string, string> = { critical: 'var(--color-danger)', high: '#f97316', medium: '#eab308', low: '#22c55e' }
const STATUS_COLOR: Record<string, { bg: string; fg: string }> = {
  open:        { bg: '#dbeafe', fg: '#1d4ed8' },
  in_progress: { bg: '#fef3c7', fg: '#92400e' },
  completed:   { bg: '#d1fae5', fg: '#065f46' },
  cancelled:   { bg: 'var(--color-border-light)', fg: '#6b7280' },
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
  const { t } = useTranslation()
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { data, loading, error, refetch } = useQuery<{ serviceRequest: ServiceRequest | null }>(GET_SERVICE_REQUEST, { variables: { id }, skip: !id, fetchPolicy: 'cache-and-network' })
  const sr = data?.serviceRequest

  const [transitionModal, setTransitionModal] = useState<{ toStep: string; label: string; inputField: string | null } | null>(null)
  const [transitionNotes, setTransitionNotes] = useState('')
  const [executeTransition, { loading: transitioning }] = useMutation<{ executeWorkflowTransition?: { success: boolean; error: string | null } }>(EXECUTE_WORKFLOW_TRANSITION, {
    onCompleted: async (res) => {
      const r = res.executeWorkflowTransition
      if (r && !r.success) { toast.error(r.error ?? 'Transizione non riuscita'); return }
      setTransitionModal(null); setTransitionNotes('')
      await refetch()
    },
    onError: (e) => toast.error(e.message),
  })

  const [editOpen, setEditOpen] = useState(false)
  const [editForm, setEditForm] = useState({ title: '', description: '', priority: 'medium', dueDate: '' })
  const [updateRequest, { loading: savingEdit }] = useMutation(UPDATE_SERVICE_REQUEST, {
    onCompleted: async () => { setEditOpen(false); await refetch(); toast.success('Richiesta aggiornata') },
    onError: (e) => toast.error(e.message),
  })
  const openEdit = () => {
    if (!sr) return
    setEditForm({
      title: sr.title, description: sr.description ?? '', priority: sr.priority,
      dueDate: sr.dueDate ? sr.dueDate.slice(0, 10) : '',
    })
    setEditOpen(true)
  }
  const submitEdit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!sr) return
    void updateRequest({ variables: { id: sr.id, input: {
      title: editForm.title.trim(),
      description: editForm.description.trim() || null,
      priority: editForm.priority,
      dueDate: editForm.dueDate || null,
    } } })
  }

  const runTransition = (instanceId: string, toStep: string, label: string, notes?: string) => {
    void executeTransition({ variables: { instanceId, toStep, notes: notes?.trim() || null } })
      .then(() => toast.success(label))
      .catch(() => { /* onError handles toast */ })
  }

  if (loading && !data) return <PageContainer><Skeleton style={{ height: 300 }} /></PageContainer>
  if (error && !data) return <PageContainer><QueryError message={error.message} onRetry={() => void refetch()} /></PageContainer>
  if (!sr) return (
    <PageContainer>
      <p style={{ color: 'var(--color-slate)', fontSize: 'var(--font-size-body)' }}>{t('pages.requests.notFound')}</p>
      <button onClick={() => navigate('/requests')} style={{ color: 'var(--color-brand)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--font-size-body)' }}>{t('detail.backToList')}</button>
    </PageContainer>
  )

  const stColor = lookupOrError(STATUS_COLOR, sr.status, 'STATUS_COLOR', { bg: 'var(--color-border-light)', fg: '#6b7280' })

  return (
    <PageContainer>
      {/* Back */}
      <button
        onClick={() => navigate('/requests')}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', marginBottom: 16, padding: 0 }}
      >
        ← {t('pages.requests.title')}
      </button>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
        <div>
          <h1 style={{ fontSize: 'var(--font-size-page-title)', fontWeight: 700, color: 'var(--color-slate-dark)', margin: '0 0 6px' }}>{sr.title}</h1>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Pill bg={stColor.bg} color={stColor.fg}>{sr.status}</Pill>
            <Pill bg="transparent" color={lookupOrError(PRIORITY_COLOR, sr.priority, 'PRIORITY_COLOR', '#9ca3af')} style={{ border: `1.5px solid ${lookupOrError(PRIORITY_COLOR, sr.priority, 'PRIORITY_COLOR', '#9ca3af')}` }}>{sr.priority}</Pill>
            <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>{timeAgo(sr.createdAt)}</span>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Button variant="secondary" onClick={openEdit}><Pencil size={13} style={{ marginRight: 6 }} />Modifica</Button>
          <WatcherBar entityType="service_request" entityId={sr.id} />
        </div>
      </div>

      {/* Body */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: 24 }}>
        <div>
          {/* Description */}
          <div style={{ marginBottom: 16 }}>
            <SectionCard collapsible={false} defaultOpen title={t('detail.sections.description')}>
              <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', lineHeight: 1.6, margin: 0 }}>{sr.description || t('detail.noDescription')}</p>
            </SectionCard>
          </div>

          {/* Allegati */}
          <AttachmentsSection entityType="service_request" entityId={sr.id} />

          {/* Internal Chat */}
          <InternalChatPanel entityType="service_request" entityId={sr.id} currentUserId={keycloak.subject ?? ''} />
        </div>

        {/* Sidebar */}
        <div>
          {/* Workflow transitions */}
          <div style={{ marginBottom: 16 }}>
            <SectionCard collapsible={false} defaultOpen title="Azioni">
              {!sr.workflowInstance ? (
                <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', margin: 0 }}>
                  Nessun workflow associato a questa richiesta.
                </p>
              ) : sr.availableTransitions.length === 0 ? (
                <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', margin: 0 }}>
                  Nessuna azione disponibile nello stato attuale ({sr.workflowInstance.currentStep}).
                </p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {sr.availableTransitions.map((tr) => (
                    <button
                      key={tr.toStep}
                      disabled={transitioning}
                      onClick={() => {
                        if (tr.requiresInput) {
                          setTransitionNotes('')
                          setTransitionModal({ toStep: tr.toStep, label: tr.label, inputField: tr.inputField })
                        } else {
                          runTransition(sr.workflowInstance!.id, tr.toStep, tr.label)
                        }
                      }}
                      style={{ padding: '9px 12px', borderRadius: 8, border: '1px solid var(--color-brand)', background: 'var(--color-brand)', color: '#fff', cursor: transitioning ? 'default' : 'pointer', fontSize: 'var(--font-size-body)', fontWeight: 600, opacity: transitioning ? 0.6 : 1, textAlign: 'left' }}
                    >
                      {tr.label}
                    </button>
                  ))}
                </div>
              )}
            </SectionCard>
          </div>

          <SectionCard collapsible={false} defaultOpen title={t('detail.sections.details')}>
            <DetailField label={t('detail.requester')} value={sr.requestedBy?.name ?? null} />
            <DetailField label={t('detail.assignee')} value={sr.assignee?.name ?? null} />
            <DetailField label={t('detail.dueDate')} value={sr.dueDate ? new Date(sr.dueDate).toLocaleDateString('it-IT') : null} />
            <DetailField label={t('detail.createdAt')} value={new Date(sr.createdAt).toLocaleDateString('it-IT')} />
            {sr.completedAt && <DetailField label={t('detail.completedAt')} value={new Date(sr.completedAt).toLocaleDateString('it-IT')} />}
          </SectionCard>
        </div>
      </div>

      {/* Edit fields modal */}
      <Modal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title="Modifica richiesta"
        as="form"
        onSubmit={submitEdit}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setEditOpen(false)}>Annulla</Button>
            <Button type="submit" disabled={savingEdit || editForm.title.trim().length === 0}>{savingEdit ? 'Salvataggio…' : 'Salva'}</Button>
          </>
        }
      >
        <div style={{ marginBottom: 14 }}>
          <FieldLabel>Titolo *</FieldLabel>
          <Input value={editForm.title} onChange={(e) => setEditForm({ ...editForm, title: e.target.value })} required autoFocus />
        </div>
        <div style={{ marginBottom: 14 }}>
          <FieldLabel>Descrizione</FieldLabel>
          <Textarea value={editForm.description} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })} rows={3} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <FieldLabel>Priorità</FieldLabel>
            <Select value={editForm.priority} onChange={(e) => setEditForm({ ...editForm, priority: e.target.value })}>
              <option value="critical">critical</option>
              <option value="high">high</option>
              <option value="medium">medium</option>
              <option value="low">low</option>
            </Select>
          </div>
          <div>
            <FieldLabel>Scadenza</FieldLabel>
            <Input type="date" value={editForm.dueDate} onChange={(e) => setEditForm({ ...editForm, dueDate: e.target.value })} />
          </div>
        </div>
      </Modal>

      {/* Transition notes modal (for transitions requiring input, e.g. rejection reason) */}
      {transitionModal && sr.workflowInstance && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}
          onClick={() => setTransitionModal(null)}
        >
          <div style={{ background: '#fff', borderRadius: 12, padding: 24, width: 460, maxWidth: '90vw' }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ fontSize: 17, fontWeight: 600, color: 'var(--color-slate-dark)', margin: '0 0 12px' }}>{transitionModal.label}</h3>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-slate)', display: 'block', marginBottom: 6 }}>
              {transitionModal.inputField === 'rejection_reason' ? 'Motivo del rifiuto' : 'Note'}
            </label>
            <textarea
              value={transitionNotes}
              onChange={(e) => setTransitionNotes(e.target.value)}
              rows={4}
              autoFocus
              style={{ width: '100%', border: '1px solid var(--color-border-light)', borderRadius: 8, padding: 10, fontSize: 13, resize: 'vertical', boxSizing: 'border-box' }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <button onClick={() => setTransitionModal(null)} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--color-border-light)', background: '#fff', cursor: 'pointer', fontSize: 13 }}>Annulla</button>
              <button
                disabled={transitioning || transitionNotes.trim().length === 0}
                onClick={() => runTransition(sr.workflowInstance!.id, transitionModal.toStep, transitionModal.label, transitionNotes)}
                style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: 'var(--color-brand)', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600, opacity: (transitioning || transitionNotes.trim().length === 0) ? 0.6 : 1 }}
              >
                Conferma
              </button>
            </div>
          </div>
        </div>
      )}
    </PageContainer>
  )
}
