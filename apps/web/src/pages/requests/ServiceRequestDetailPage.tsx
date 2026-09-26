import { useId, useState } from 'react'
import { TicketOLACard } from '@/components/ticket/ola/TicketOLACard'
import { CustomFieldsCard } from '@/components/ticket/customFields/CustomFieldsCard'
import { FormAnswersCard, type FormAnswer } from '@/components/ticket/FormAnswersCard'
import type { CustomFieldValueView } from '@/components/ticket/customFields/customFields'
import { useMe } from '@/hooks/useMe'
import { useTicketRights } from '@/hooks/useTicketRights'
import { useParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation } from '@apollo/client/react'
import { toast } from 'sonner'
import { PageContainer } from '@/components/PageContainer'
import { QueryError } from '@/components/QueryError'
import { SectionCard } from '@/components/ui/SectionCard'
import { DetailField } from '@/components/ui/DetailField'
import { DetailLayout } from '@/components/ui/DetailLayout'
import { Tabs, TabPanel } from '@/components/ui/Tabs'
import { useTabParam } from '@/hooks/useTabParam'
import { Pill } from '@/components/ui/Pill'
import { Skeleton } from '@/components/ui/skeleton'
import { WatcherBar } from '@/components/WatcherBar'
import { EntityCommentsSection } from '@/components/ticket/EntityCommentsSection'
import { timeAgo, formatDate } from '@/lib/datetime'
import { AttachmentsSection } from '@/components/AttachmentsSection'
import { TicketTasksSection } from '@/components/ticket/TicketTasksSection'
import { InternalChatPanel } from '@/components/InternalChatPanel'
import { Modal } from '@/components/Modal'
import { Button } from '@/components/Button'
import { Input, Textarea, Select, FieldLabel } from '@/components/ui/FormControls'
import { Pencil } from 'lucide-react'
import { keycloak } from '@/lib/keycloak'
import { colors } from '@/lib/tokens'
import { GET_SERVICE_REQUEST, GET_ALL_CIS } from '@/graphql/queries'
import { EXECUTE_WORKFLOW_TRANSITION, UPDATE_SERVICE_REQUEST, ADD_CI_TO_SERVICE_REQUEST, REMOVE_CI_FROM_SERVICE_REQUEST } from '@/graphql/mutations'
import { AffectedCIList, type AffectedCIRef } from '@/components/ticket/AffectedCIList'
import { useTicketCIExclusions } from '@/hooks/useTicketCIExclusions'
import { SlaBadge, type SlaStatusInfo } from '@/components/SlaBadge'
import { useSlaSettling } from '@/hooks/useSlaSettling'
import { useWorkflowSteps } from '@/hooks/useWorkflowSteps'
import { useDomainVocabularies } from '@/contexts/DomainVocabularyContext'
import { useEnumValues } from '@/hooks/useEnumValues'
import { styleForCategory, transitionButtonColors } from '@/lib/workflowStepStyle'
import { transitionErrorText, type TransitionFailure } from '@/lib/transitionError'
import { useValueStyle } from '@/hooks/useValueStyle'
import { withLocalizedLabel } from '@/lib/localizedLabel'
import { showError } from '@/lib/showError'
import { RequestAssignment } from './RequestAssignment'
import { reloadQueries } from '@/lib/reloadQueries'

interface WorkflowTransition { toStep: string; label: string; requiresInput: boolean; inputField: string | null }
interface ServiceRequest {
  customFields: CustomFieldValueView[]
  id: string; number: string; title: string; description: string | null
  status: string; priority: string; dueDate: string | null
  createdAt: string; updatedAt: string; completedAt: string | null
  requestedBy: { id: string; name: string; email: string } | null
  assignee: { id: string; name: string; email: string } | null
  /** The team of the request (D56): at creation the fulfilment group of its catalog item. */
  team: { id: string; name: string } | null
  workflowInstance: { id: string; currentStep: string; status: string } | null
  availableTransitions: WorkflowTransition[]
  slaStatus: SlaStatusInfo | null
  /** I CI che la richiesta riguarda (revisione del 15 set 2026 · CM-8). */
  affectedCIs: AffectedCIRef[]
  /** La revisione del modulo con cui e stata compilata (moduli del catalogo, ondata 1). */
  formRevision: number | null
  /** Le risposte al modulo, nell'ordine di QUELLA revisione. */
  formAnswers: FormAnswer[]
}

/**
 * THE REQUEST IN TWO TABS (26 Sep 2026, review of the pages), as the other
 * tickets: what it asks and the conversation, then its tasks and attachments.
 * The actions and the details stay on the right.
 */
const REQUEST_TABS = ['overview', 'work'] as const

export function ServiceRequestDetailPage() {
  const { t } = useTranslation()
  // F9: il colore della priorità dal Dizionario del cliente.
  const styleOf = useValueStyle()
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const ids = { title: useId(), description: useId(), priority: useId(), dueDate: useId(), notes: useId() }
  const { can } = useMe()
  // Il permesso, non il NOME del ruolo (revisione totale · F-2): dall'ondata
  // «Nulla cablato» i ruoli sono del cliente, e l'API concede
  // `setTicketCustomFields` a `ticket.work`. Col confronto sul nome un ruolo
  // «tecnico L2» con quel permesso vedeva i campi in sola lettura, e un ruolo
  // chiamato «operator» SENZA il permesso vedeva il form e prendeva un 403.
  const canEditCustomFields = can('ticket.work')
  // Review of 23 Sep 2026: edit, transitions, assignment and CIs ask request.write, as the API does.
  const { canWrite } = useTicketRights('service_request')
  const { data, loading, error, refetch, startPolling, stopPolling } = useQuery<{ serviceRequest: ServiceRequest | null }>(GET_SERVICE_REQUEST, { variables: { id }, skip: !id, fetchPolicy: 'cache-and-network' })
  const sr = data?.serviceRequest
  const srTransitions = (sr?.availableTransitions ?? []).map(withLocalizedLabel)
  useSlaSettling(sr?.slaStatus, !!sr?.completedAt, { startPolling, stopPolling })
  // Stato e priorità come li chiama il cliente: etichetta e colore del passo
  // vengono dal workflow (categoria), la priorità dal vocabolario. Prima la
  // pagina mostrava «submitted», «approval», «high» e cercava il colore in una
  // tabella di nomi che nessun passo del workflow aveva.
  const { labelFor: stepLabel, categoryOf: stepCategory } = useWorkflowSteps('service_request')
  const { labelOf } = useDomainVocabularies()
  const { values: priorityValues } = useEnumValues('service_request', 'priority')

  const [transitionModal, setTransitionModal] = useState<{ toStep: string; label: string; inputField: string | null } | null>(null)
  const [transitionNotes, setTransitionNotes] = useState('')
  const [executeTransition, { loading: transitioning }] = useMutation<{ executeWorkflowTransition?: TransitionFailure & { success: boolean } }>(EXECUTE_WORKFLOW_TRANSITION, {
    onCompleted: (res) => {
      const r = res.executeWorkflowTransition
      if (r && !r.success) { toast.error(transitionErrorText(r, t('toast.request.transitionFailed'))); return }
      setTransitionModal(null); setTransitionNotes('')
      reloadQueries(refetch)
    },
    onError: (e) => showError(e),
  })

  // CM-8 (revisione del 15 set 2026): i CI della richiesta. Prima una richiesta
  // non poteva dire di quale CI parlava; i tipi esclusi per le richieste non si
  // propongono (e l'API li rifiuta comunque).
  const [ciSearch, setCiSearch] = useState('')
  const [tab, setTab] = useTabParam(REQUEST_TABS, 'overview')
  const tabsId = useId()
  const { excluded: excludedCITypes } = useTicketCIExclusions('service_request')
  const { data: ciSearchData } = useQuery<{ allCIs: { items: AffectedCIRef[] } }>(GET_ALL_CIS, {
    variables: { search: ciSearch, limit: 20, excludeCiTypes: excludedCITypes },
    skip: ciSearch.length < 2 || excludedCITypes === undefined,
  })
  const [addCI] = useMutation(ADD_CI_TO_SERVICE_REQUEST, {
    onCompleted: () => { toast.success(t('toast.request.ciAdded')); setCiSearch(''); void refetch() },
    onError: (e) => showError(e),
  })
  const [removeCI] = useMutation(REMOVE_CI_FROM_SERVICE_REQUEST, {
    onCompleted: () => { toast.success(t('toast.request.ciRemoved')); void refetch() },
    onError: (e) => showError(e),
  })

  const [editOpen, setEditOpen] = useState(false)
  const [editForm, setEditForm] = useState({ title: '', description: '', priority: 'medium', dueDate: '' })
  const [updateRequest, { loading: savingEdit }] = useMutation(UPDATE_SERVICE_REQUEST, {
    onCompleted: () => { setEditOpen(false); toast.success(t('toast.request.updated')); reloadQueries(refetch) },
    onError: (e) => showError(e),
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

  const runTransition = (instanceId: string, toStep: string, notes?: string) => {
    /**
     * Il toast di successo arriva SOLO se la transizione è avvenuta
     * (revisione totale · F-3): era agganciato alla promise della mutation,
     * che si risolve anche quando il motore rifiuta (`success: false`) —
     * quindi una transizione bloccata da una guardia mostrava insieme
     * l'errore e «spostato in …». L'esito lo dice `onCompleted`, che è il
     * solo che lo conosce.
     */
    void executeTransition({ variables: { instanceId, toStep, notes: notes?.trim() || null } })
      .then((res) => {
        if (res.data?.executeWorkflowTransition?.success === false) return
        // Giro del 14 set 2026 (#42): il toast dice l'esito, non il pulsante.
        toast.success(t('toast.transition.movedTo', { step: stepLabel(toStep) }))
      })
      .catch(() => { /* onError handles toast */ })
  }

  if (loading && !data) return <PageContainer><Skeleton style={{ height: 300 }} /></PageContainer>
  if (error && !data) return <PageContainer><QueryError message={error.message} onRetry={() => void refetch()} /></PageContainer>
  if (!sr) return (
    <PageContainer>
      <p style={{ color: 'var(--color-slate)', fontSize: 'var(--font-size-body)' }}>{t('pages.requests.notFound')}</p>
      <button type="button" onClick={() => navigate('/requests')} style={{ color: 'var(--color-brand)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--font-size-body)' }}>{t('detail.backToList')}</button>
    </PageContainer>
  )

  const stColor = styleForCategory(stepCategory(sr.status))

  return (
    <PageContainer>
      {/* Back */}
      <button
        type="button"
        onClick={() => navigate('/requests')}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', marginBottom: 16, padding: 0 }}
      >
        ← {t('pages.requests.title')}
      </button>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
        <div>
          {/* Giro UI del 15 set 2026 · U-12: il numero non compariva da nessuna parte (incident, problem e change lo mostrano). */}
          <div data-testid="request-number" style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', marginBottom: 2 }}>{sr.number}</div>
          <h1 style={{ fontSize: 'var(--font-size-page-title)', fontWeight: 700, color: 'var(--color-slate-dark)', margin: '0 0 6px' }}>{sr.title}</h1>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Pill bg={stColor.bg} color={stColor.color}>{stepLabel(sr.status)}</Pill>
            <Pill bg="transparent" color={styleOf('priority', sr.priority).color} style={{ border: `1.5px solid ${styleOf('priority', sr.priority).accent}` }}>{labelOf('priority', sr.priority) ?? sr.priority}</Pill>
            <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>{timeAgo(sr.createdAt)}</span>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {canWrite && <Button variant="secondary" onClick={openEdit}><Pencil size={13} style={{ marginRight: 6 }} />{t('common.edit')}</Button>}
          <WatcherBar entityType="service_request" entityId={sr.id} />
        </div>
      </div>

      {/* Body: the main column shrinks, the side one keeps its width (D9) */}
      {/* The tabs head the main column only: both columns start level (26 Sep 2026). */}
      <DetailLayout
        sideWidth={300}
        head={
          <Tabs
            idPrefix={tabsId}
            ariaLabel={t('detail.tabs.label')}
            value={tab}
            onChange={setTab}
            items={[
              { key: 'overview', label: t('detail.tabs.overview') },
              { key: 'work', label: t('detail.tabs.work') },
            ]}
          />
        }
      >
        <div>
          {/* The open tab (in the address, ?tab=) */}
          <TabPanel idPrefix={tabsId} tabKey={tab}>
            {tab === 'overview' && (
              <>
                  {/* Description */}
                  <div style={{ marginBottom: 16 }}>
                    <SectionCard collapsible={false} defaultOpen title={t('detail.sections.description')}>
                      <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', lineHeight: 1.6, margin: 0 }}>{sr.description || t('detail.noDescription')}</p>
                    </SectionCard>
                  </div>

                  {/* Campi del cliente (verifica «Cosa resta cablato», ondata 4) */}
                  <div style={{ marginBottom: 16 }}>
                    <TicketOLACard entityType="service_request" entityId={sr.id} />
                    <CustomFieldsCard entityType="service_request" ticketId={sr.id} fields={sr.customFields ?? []} canEdit={canEditCustomFields} onSaved={() => void refetch()} />
                    {/* Le risposte al modulo della voce di catalogo (moduli del catalogo, ondata 1) */}
                    <FormAnswersCard answers={sr.formAnswers ?? []} revision={sr.formRevision ?? null} requestId={sr.id} />
                  </div>

                  {/* CI della richiesta (CM-8) */}
                  <div style={{ marginBottom: 16 }}>
                    <AffectedCIList
                      affectedCIs={sr.affectedCIs ?? []}
                      ciResults={ciSearchData?.allCIs?.items ?? []}
                      excludedTypes={excludedCITypes ?? []}
                      onSearchChange={setCiSearch}
                      onAddCI={(ciId) => void addCI({ variables: { requestId: sr.id, ciId } })}
                      onRemoveCI={(ciId) => void removeCI({ variables: { requestId: sr.id, ciId } })}
                      canEdit={canWrite}
                    />
                  </div>

                  {/* F13: le richieste non avevano commenti. */}
                  <EntityCommentsSection entityType="service_request" entityId={sr.id} />

              </>
            )}
            {tab === 'work' && (
              <>
                  {/* Allegati */}
                  <TicketTasksSection entityId={sr.id} />
                  <AttachmentsSection entityType="service_request" entityId={sr.id} />

                  {/* Internal Chat */}
                  <InternalChatPanel entityType="service_request" entityId={sr.id} currentUserId={keycloak.subject ?? ''} />
              </>
            )}
          </TabPanel>
        </div>

        {/* Sidebar */}
        <div>
          {/* Workflow transitions: only for who may move the request */}
          {canWrite && <div style={{ marginBottom: 16 }}>
            <SectionCard collapsible={false} defaultOpen title={t('common.actions')}>
              {!sr.workflowInstance ? (
                <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', margin: 0 }}>
                  {t('pages.serviceRequestDetail.noWorkflow')}
                </p>
              ) : srTransitions.length === 0 ? (
                <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', margin: 0 }}>
                  {t('pages.serviceRequestDetail.noActionInStep', { step: stepLabel(sr.workflowInstance.currentStep) })}
                </p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {srTransitions.map((tr) => (
                    <button
                      type="button"
                      key={tr.toStep}
                      disabled={transitioning}
                      onClick={() => {
                        if (tr.requiresInput) {
                          setTransitionNotes('')
                          setTransitionModal({ toStep: tr.toStep, label: tr.label, inputField: tr.inputField })
                        } else {
                          runTransition(sr.workflowInstance!.id, tr.toStep)
                        }
                      }}
                      // D27: «Reject» and the other transitions that end the request badly are drawn as danger.
                      style={{ padding: '9px 12px', borderRadius: 8, borderWidth: 1, borderStyle: 'solid', ...transitionButtonColors(stepCategory(tr.toStep), tr.inputField, 'brand'), cursor: transitioning ? 'default' : 'pointer', fontSize: 'var(--font-size-body)', fontWeight: 600, opacity: transitioning ? 0.6 : 1, textAlign: 'left' }}
                    >
                      {tr.label}
                    </button>
                  ))}
                </div>
              )}
            </SectionCard>
          </div>}

          <SectionCard collapsible={false} defaultOpen title={t('detail.sections.details')}>
            <DetailField label={t('detail.ticketNumber')} value={<span style={{ fontWeight: 600 }}>{sr.number}</span>} />
            <DetailField label="SLA" value={sr.slaStatus ? <SlaBadge sla={sr.slaStatus} /> : t('pages.serviceRequestDetail.noSla')} />
            <DetailField label={t('detail.requester')} value={sr.requestedBy?.name ?? null} />
            {/* D56: the team first (support teams, searchable), then one of its members. */}
            <RequestAssignment request={sr} canEdit={canWrite} onChanged={refetch} />
            <DetailField label={t('detail.dueDate')} value={sr.dueDate ? formatDate(sr.dueDate) : null} />
            <DetailField label={t('detail.createdAt')} value={formatDate(sr.createdAt)} />
            {sr.completedAt && <DetailField label={t('detail.completedAt')} value={formatDate(sr.completedAt)} />}
          </SectionCard>
        </div>
      </DetailLayout>

      {/* Edit fields modal */}
      <Modal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title={t('pages.serviceRequestDetail.editTitle')}
        as="form"
        onSubmit={submitEdit}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setEditOpen(false)}>{t('common.cancel')}</Button>
            <Button type="submit" disabled={savingEdit || editForm.title.trim().length === 0}>{savingEdit ? t('common.saving') : t('common.save')}</Button>
          </>
        }
      >
        <div style={{ marginBottom: 14 }}>
          <FieldLabel htmlFor={ids.title}>{t('pages.serviceRequestDetail.titleRequired')}</FieldLabel>
          {/* eslint-disable-next-line jsx-a11y/no-autofocus -- focus management: primo campo del modal di modifica aperto dall'utente */}
          <Input id={ids.title} value={editForm.title} onChange={(e) => setEditForm({ ...editForm, title: e.target.value })} required autoFocus />
        </div>
        <div style={{ marginBottom: 14 }}>
          <FieldLabel htmlFor={ids.description}>{t('common.description')}</FieldLabel>
          <Textarea id={ids.description} value={editForm.description} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })} rows={3} />
        </div>
        <div className="og-pair">
          <div>
            <FieldLabel htmlFor={ids.priority}>{t('detail.priority')}</FieldLabel>
            <Select id={ids.priority} value={editForm.priority} onChange={(e) => setEditForm({ ...editForm, priority: e.target.value })}>
              {priorityValues.map((v) => <option key={v} value={v}>{labelOf('priority', v) ?? v}</option>)}
            </Select>
          </div>
          <div>
            <FieldLabel htmlFor={ids.dueDate}>{t('detail.dueDate')}</FieldLabel>
            <Input id={ids.dueDate} type="date" value={editForm.dueDate} onChange={(e) => setEditForm({ ...editForm, dueDate: e.target.value })} />
          </div>
        </div>
      </Modal>

      {/* Transition notes modal (for transitions requiring input, e.g. rejection reason) */}
      {transitionModal && sr.workflowInstance && (
        <Modal
          open
          onClose={() => setTransitionModal(null)}
          title={transitionModal.label}
          width={460}
          footer={
            <>
              <button type="button" onClick={() => setTransitionModal(null)} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--color-border-light)', background: colors.white, cursor: 'pointer', fontSize: 13 }}>{t('common.cancel')}</button>
              <button
                type="button"
                disabled={transitioning || transitionNotes.trim().length === 0}
                onClick={() => runTransition(sr.workflowInstance!.id, transitionModal.toStep, transitionNotes)}
                style={{ padding: '8px 16px', borderRadius: 8, borderWidth: 1, borderStyle: 'solid', ...transitionButtonColors(stepCategory(transitionModal.toStep), transitionModal.inputField, 'brand'), cursor: 'pointer', fontSize: 13, fontWeight: 600, opacity: (transitioning || transitionNotes.trim().length === 0) ? 0.6 : 1 }}
              >
                {t('common.confirm')}
              </button>
            </>
          }
        >
          <label htmlFor={ids.notes} style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-slate)', display: 'block', marginBottom: 6 }}>
            {t(transitionModal.inputField === 'rejection_reason' ? 'pages.requests.rejectionReason' : 'common.note')}
          </label>
          <textarea
            id={ids.notes}
            value={transitionNotes}
            onChange={(e) => setTransitionNotes(e.target.value)}
            rows={4}
            // eslint-disable-next-line jsx-a11y/no-autofocus -- focus management: textarea del modal di transizione aperto dall'utente
            autoFocus
            style={{ width: '100%', border: '1px solid var(--color-border-light)', borderRadius: 8, padding: 10, fontSize: 13, resize: 'vertical', boxSizing: 'border-box' }}
          />
        </Modal>
      )}
    </PageContainer>
  )
}
