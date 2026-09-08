/**
 * ChangeDetailPage — orchestrator only. Queries the change aggregate and
 * delegates rendering to focused, prop-driven components under ./components.
 *
 * All shared state (current change, affected CIs, audit trail, who the
 * viewer is, which step we're in) lives here. Child components receive
 * what they need via props and manage only their own local UI state
 * (e.g. which modal is open inside a row).
 */
import { useId, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation } from '@apollo/client/react'
import { toast } from 'sonner'
import { ChevronRight, FileDown, Loader2, Plus, PlusCircle, X, CheckCircle, XCircle, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { downloadPdf } from '@/lib/downloadPdf'
import { PageContainer } from '@/components/PageContainer'
import { Button } from '@/components/Button'
import { Modal } from '@/components/Modal'
import { SectionCard } from '@/components/ui/SectionCard'
import { FieldLabel } from '@/components/ui/FormControls'
import { AttachmentsSection } from '@/components/AttachmentsSection'
import { EmptyState } from '@/components/EmptyState'
import { QueryError } from '@/components/QueryError'
import {
  GET_CHANGE,
  GET_CHANGE_AFFECTED_CIS,
  GET_CHANGE_AUDIT_TRAIL,
  GET_CHANGE_IMPACTED_CIS,
} from '@/graphql/queries'
import { useMe } from '@/hooks/useMe'
import {
  EXECUTE_CHANGE_TRANSITION,
  ADD_CI_TO_CHANGE,
  REMOVE_CI_FROM_CHANGE,
  APPROVE_CHANGE_APPROVAL,
  REJECT_CHANGE_APPROVAL,
  LINK_RESOLVED_TICKET,
  UNLINK_RESOLVED_TICKET,
  DELETE_CHANGE,
} from '@/graphql/mutations'
import { useWorkflowSteps } from '@/hooks/useWorkflowSteps'
import { TASK_STATUS } from '@/lib/taskStatus'
import type { AffectedCI, ChangeAuditEntryData, ChangeData, MeData } from '@/types/change'
import { PhaseChipBar } from './components/PhaseChipBar'
import { ChangeInfoCard } from './components/ChangeInfoCard'
import { CITasksTable } from './components/CITasksTable'
import { AuditTimeline } from './components/AuditTimeline'
import { AddCIModal } from './components/AddCIModal'
import { fmtShort, fmtDate } from './components/shared'
import { UnifiedLinkedTickets } from '@/components/UnifiedLinkedTickets'

interface ImpactedCIRow {
  ci: { id: string; name: string; type: string | null; environment: string | null }
  distance: number
  affectedBy: { id: string; name: string; type: string | null }
  impactPath: string[]
}

export function ChangeDetailPage() {
  const { t } = useTranslation()
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const changeId = id ?? ''
  const rejectNoteId = useId()
  const transitionNotesId = useId()

  const { data: changeData, loading, error: changeError, refetch: refetchChange } = useQuery<{ change: ChangeData | null }>(GET_CHANGE, { variables: { id: changeId }, fetchPolicy: 'cache-and-network' })
  const { data: affectedData, refetch: refetchAffected } = useQuery<{ changeAffectedCIs: AffectedCI[] }>(GET_CHANGE_AFFECTED_CIS, { variables: { changeId }, fetchPolicy: 'cache-and-network' })
  const { data: auditData, refetch: refetchAudit } = useQuery<{ changeAuditTrail: ChangeAuditEntryData[] }>(GET_CHANGE_AUDIT_TRAIL, { variables: { changeId }, fetchPolicy: 'cache-and-network' })
  const { me } = useMe()
  const meData: { me: MeData | null } = { me }
  const { steps: wfSteps, byName: wfByName, initialStep: wfInitialStep, isTerminal: wfIsTerminal } = useWorkflowSteps('change')

  const refetchAll = async () => { await refetchChange(); await refetchAffected(); await refetchAudit() }
  const [executeTransition, { loading: transitioning }] = useMutation<{ executeChangeTransition?: { actionErrors?: string[] | null } }>(EXECUTE_CHANGE_TRANSITION, {
    onCompleted: async (data) => {
      // La transizione è avvenuta, ma alcune azioni di step (SLA, eventi, timer)
      // sono fallite: va detto, non nascosto.
      const errs = data?.executeChangeTransition?.actionErrors
      if (errs?.length) toast.warning(t('toast.change.transitionPartial', { count: errs.length, errors: errs.join(' · ') }), { duration: 10000 })
      await refetchAll()
    },
    onError: (e) => toast.error(e.message),
  })
  const [transitionModal, setTransitionModal] = useState<{ toStep: string; label: string; inputField: string | null } | null>(null)
  const [transitionNotes, setTransitionNotes] = useState('')
  const runTransition = async (toStep: string, label: string, notes?: string) => {
    try {
      await executeTransition({ variables: { changeId, toStep, notes: notes ?? null } })
      toast.success(label)
    } catch { /* onError handles toast */ }
  }

  const [approveApproval, { loading: approving }] = useMutation(APPROVE_CHANGE_APPROVAL, {
    onCompleted: async () => { toast.success(t('toast.change.approvalRecorded')); await refetchAll() },
    onError: (e) => toast.error(e.message),
  })
  const [rejectApproval] = useMutation(REJECT_CHANGE_APPROVAL, {
    onCompleted: async () => { toast.success(t('toast.change.approvalRejected')); await refetchAll() },
    onError: (e) => toast.error(e.message),
  })
  const [rejectModal, setRejectModal] = useState<{ teamId: string; teamName: string } | null>(null)
  const [rejectNote, setRejectNote] = useState('')
  const [reopenMode, setReopenMode] = useState<'all' | 'some'>('all')
  const [reopenIds, setReopenIds] = useState<Set<string>>(new Set())

  // ── Ticket collegati: UnifiedLinkedTickets (stessa sezione di incident e
  //    problem; la ricerca vive nel componente). Link/unlink aggiornano anche
  //    l'audit trail.
  const [linkTicket] = useMutation(LINK_RESOLVED_TICKET, {
    onCompleted: async () => { toast.success(t('toast.change.ticketLinked')); await refetchAll() },
    onError: (e) => toast.error(e.message),
  })
  const [unlinkTicket] = useMutation(UNLINK_RESOLVED_TICKET, {
    onCompleted: async () => { toast.success(t('toast.change.ticketUnlinked')); await refetchAll() },
    onError: (e) => toast.error(e.message),
  })

  const change = changeData?.change
  const affected = Array.from(new Map((affectedData?.changeAffectedCIs ?? []).map(a => [a.ci.id, a])).values())
  const audit = auditData?.changeAuditTrail ?? []
  const isAdmin = meData?.me?.role === 'admin'
  const userTeamIds = new Set((meData?.me?.teams ?? []).map(t => t.id))

  const [impactDepth, setImpactDepth] = useState(1)
  const { data: impactData, error: impactError, refetch: refetchImpacted } = useQuery<{ changeImpactedCIs: ImpactedCIRow[] }>(
    GET_CHANGE_IMPACTED_CIS, { variables: { changeId, depth: impactDepth }, fetchPolicy: 'cache-and-network' },
  )
  const impactedCIs = impactData?.changeImpactedCIs ?? []

  const [ciTab, setCITab] = useState<'affected' | 'impacted'>('affected')
  const [expandedImpactId, setExpandedImpactId] = useState<string | null>(null)
  const [showAddCI, setShowAddCI] = useState(false)
  const [confirmRemoveCI, setConfirmRemoveCI] = useState<{ id: string; name: string } | null>(null)
  const [exportingPdf, setExportingPdf] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleteChange, { loading: deleting }] = useMutation(DELETE_CHANGE, {
    onCompleted: () => { toast.success(t('toast.change.deleted')); navigate('/changes') },
    onError: (e) => toast.error(e.message),
  })

  const handleExportPdf = async () => {
    if (!change) return
    setExportingPdf(true)
    try {
      await downloadPdf(`/api/changes/${change.id}/pdf`, `${change.code || change.id}.pdf`)
    } catch {
      toast.error(t('detail.exportPdfFailed'))
    } finally {
      setExportingPdf(false)
    }
  }
  const [removeCI] = useMutation(REMOVE_CI_FROM_CHANGE, {
    onCompleted: () => {
      void refetchImpacted()
      void refetchAffected()
      void refetchAudit()
      toast.success(t('toast.change.ciRemoved'))
      setConfirmRemoveCI(null)
    },
    onError: (e) => toast.error(e.message),
  })
  const [addCIFromImpacted] = useMutation(ADD_CI_TO_CHANGE, {
    onCompleted: () => {
      void refetchImpacted()
      void refetchAffected()
      void refetchAudit()
      toast.success(t('toast.change.ciAddedToAffected'))
    },
    onError: (e) => toast.error(e.message),
  })

  if (loading && !change) return <PageContainer><p>Caricamento...</p></PageContainer>
  if (changeError && !changeData) return <PageContainer><QueryError message={changeError.message} onRetry={() => void refetchChange()} /></PageContainer>
  if (!change) return <PageContainer><p>Change non trovato</p></PageContainer>

  const currentStep = change.workflowInstance?.currentStep ?? ''
  const transitions = change.availableTransitions ?? []

  const totalTasks = affected.length * 3
  const completedTasks = affected.reduce((n, a) => n
    + (a.assessmentOwner?.status === TASK_STATUS.COMPLETED ? 1 : 0)
    + (a.assessmentSupport?.status === TASK_STATUS.COMPLETED ? 1 : 0)
    + (a.deployPlan?.status === TASK_STATUS.COMPLETED ? 1 : 0), 0)

  // Click su una transizione: apre la modale note se richiede input, altrimenti
  // esegue subito. Condiviso da ChangeInfoCard e dal box Approvazione.
  const handleTransitionClick = (tr: { toStep: string; label: string; requiresInput?: boolean; inputField?: string | null }) => {
    if (tr.requiresInput) {
      setTransitionNotes('')
      setTransitionModal({ toStep: tr.toStep, label: tr.label, inputField: tr.inputField ?? null })
    } else {
      void runTransition(tr.toStep, tr.label)
    }
  }

  // Posizione rispetto allo step di approvazione: il box Approvazione è aperto
  // e azionabile DURANTE approval, poi resta visibile ma collassato (esito).
  const stepNames    = wfSteps.map(s => s.name)
  const approvalIdx  = stepNames.indexOf('approval')
  const currentIdx   = stepNames.indexOf(currentStep)
  const atApproval   = currentStep === 'approval'
  const pastApproval = approvalIdx >= 0 && currentIdx > approvalIdx
  const showApproval = atApproval || pastApproval

  return (
    <PageContainer style={{ padding: '16px 24px' }}>
      <button type="button" onClick={() => navigate('/changes')} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', marginBottom: 12, padding: 0 }}>← Changes</button>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
        <h1 style={{ fontSize: 'var(--font-size-page-title)', fontWeight: 600, color: 'var(--color-slate-dark)', margin: 0 }}>{change.code}</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Button
            variant="secondary"
            disabled={exportingPdf}
            icon={exportingPdf ? <Loader2 size={13} className="animate-spin" /> : <FileDown size={13} />}
            onClick={() => void handleExportPdf()}
          >
            {t('detail.exportPdf')}
          </Button>
          {isAdmin && (
            <Button
              variant="secondary"
              disabled={deleting}
              icon={deleting ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
              onClick={() => setConfirmDelete(true)}
            >
              Elimina
            </Button>
          )}
        </div>
      </div>
      <PhaseChipBar current={currentStep} steps={wfSteps} />

      <ChangeInfoCard
        change={change}
        currentStep={currentStep}
        initialStepName={wfInitialStep?.name ?? null}
        isTerminal={wfIsTerminal(currentStep)}
        isAdmin={isAdmin}
        transitioning={transitioning}
        totalTasks={totalTasks}
        completedTasks={completedTasks}
        transitions={transitions}
        stepLabel={wfByName.get(currentStep)?.label ?? currentStep}
        onTransitionClick={handleTransitionClick}
      />

      {/* Approvazione multi-parte: Change Manager + un owner group per CI affected.
          Tabellare; aperto durante approval, collassato dopo. */}
      {showApproval && (() => {
        const approvals = change.approvals ?? []
        const approvedN = approvals.filter(a => a.status === 'approved').length
        return (
          <SectionCard
            key={`approval-${currentStep}`}
            title="Approvazione"
            count={approvals.length}
            collapsible
            defaultOpen={atApproval}
            activeColor="#FEF9C3"
            activeTextColor="var(--color-slate-dark)"
            headerRight={<span style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)' }}>{approvedN}/{approvals.length} approvate</span>}
          >
            {approvals.length === 0 ? (
              <p style={{ margin: 0, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>
                Nessun requisito di approvazione. Verifica che sia designato un team <strong>Change Manager</strong> (Team e Utenti) e che i CI affected abbiano un owner group.
              </p>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid #e5e7eb', fontSize: 'var(--font-size-label)', fontWeight: 600, color: 'var(--color-slate-light)', textTransform: 'uppercase' }}>
                  <span style={{ width: 150 }}>Requisito</span>
                  <span style={{ flex: 1 }}>Team</span>
                  <span style={{ width: 110 }}>Stato</span>
                  <span style={{ flex: 1 }}>Approvato da</span>
                  <span style={{ width: 200 }}>Azioni</span>
                </div>
                {approvals.map((a) => (
                  <div key={`${a.kind}-${a.teamId}`} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 0', borderBottom: '1px solid #f3f4f6', fontSize: 'var(--font-size-body)' }}>
                    <span style={{ width: 150, fontWeight: 500, color: 'var(--color-slate-dark)' }}>{a.kind === 'change_manager' ? 'Change Manager' : 'Owner Group'}</span>
                    <span style={{ flex: 1, color: 'var(--color-slate)' }}>{a.teamName ?? '—'}</span>
                    <span style={{ width: 110 }}>
                      {a.status === 'approved'
                        ? <span style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, color: '#166534', background: '#DCFCE7', padding: '2px 8px', borderRadius: 12 }}>Approvato</span>
                        : <span style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, color: '#854D0E', background: '#FEF9C3', padding: '2px 8px', borderRadius: 12 }}>In attesa</span>}
                    </span>
                    <span style={{ flex: 1, fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)' }}>
                      {a.approvedByName ? `${a.approvedByName}${a.approvedAt ? ` · ${fmtDate(a.approvedAt)}` : ''}` : '—'}
                    </span>
                    <span style={{ width: 200, display: 'flex', gap: 8 }}>
                      {a.canApprove && a.teamId && (
                        <>
                          <button type="button" disabled={approving} onClick={() => void approveApproval({ variables: { changeId, teamId: a.teamId, note: null } })}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 8, border: 'none', background: '#22c55e', color: '#fff', fontWeight: 600, fontSize: 'var(--font-size-label)', cursor: approving ? 'wait' : 'pointer' }}>
                            <CheckCircle size={14} /> Approva
                          </button>
                          <button type="button" onClick={() => { setRejectNote(''); setReopenMode('all'); setReopenIds(new Set()); setRejectModal({ teamId: a.teamId!, teamName: a.teamName ?? '' }) }}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 8, border: '1px solid var(--color-danger)', background: '#fff', color: 'var(--color-danger)', fontWeight: 600, fontSize: 'var(--font-size-label)', cursor: 'pointer' }}>
                            <XCircle size={14} /> Rigetta
                          </button>
                        </>
                      )}
                    </span>
                  </div>
                ))}
              </>
            )}
          </SectionCard>
        )
      })()}

      <UnifiedLinkedTickets
        title="Ticket collegati"
        types={[
          {
            kind: 'PROBLEM', label: 'Problem', routeBase: '/problems',
            items: change.resolvesProblems ?? [],
            onLink: (entityId) => void linkTicket({ variables: { changeId, entityType: 'problem', entityId } }),
            onUnlink: (entityId) => void unlinkTicket({ variables: { changeId, entityType: 'problem', entityId } }),
          },
          {
            kind: 'INCIDENT', label: 'Incident', routeBase: '/incidents',
            items: change.resolvesIncidents ?? [],
            onLink: (entityId) => void linkTicket({ variables: { changeId, entityType: 'incident', entityId } }),
            onUnlink: (entityId) => void unlinkTicket({ variables: { changeId, entityType: 'incident', entityId } }),
          },
        ]}
      />

      {!wfIsTerminal(currentStep) && affected.some(a => a.deployPlan && a.deployPlan.steps.length > 0 && !a.validation) && (
        <SectionCard title="Prossimi Step" collapsible count={affected.filter(a => (a.deployPlan?.steps?.length ?? 0) > 0).length}>
          {affected.map((a) => {
            const steps = a.deployPlan?.steps ?? []
            if (steps.length === 0) return null
            const firstVal = steps[0]?.validationWindow?.start
            const firstRel = steps[0]?.releaseWindow?.start
            return (
              <div key={a.ci.id} style={{ display: 'flex', gap: 16, padding: '6px 0', borderBottom: '1px solid #f3f4f6', fontSize: 'var(--font-size-label)' }}>
                <span style={{ width: 120, fontWeight: 500, color: 'var(--color-slate-dark)', flexShrink: 0 }}>{a.ci.name}</span>
                {firstVal && <span style={{ color: 'var(--color-slate-light)' }}>Validation: <strong style={{ color: 'var(--color-slate)' }}>{fmtShort(firstVal)}</strong></span>}
                {firstRel && <span style={{ color: 'var(--color-slate-light)' }}>Deploy: <strong style={{ color: 'var(--color-slate)' }}>{fmtShort(firstRel)}</strong></span>}
              </div>
            )
          })}
        </SectionCard>
      )}

      <CITasksTable
        key={`tasks-${currentStep}`}
        affected={affected}
        isAdmin={isAdmin}
        userTeamIds={userTeamIds}
        defaultOpen={currentStep !== 'approval'}
        activeColor={currentStep === 'approval' ? undefined : '#FEF9C3'}
        activeTextColor={currentStep === 'approval' ? undefined : 'var(--color-slate-dark)'}
      />

      <SectionCard title="CIs Involved" collapsible count={affected.length}>
        <div style={{ display: 'flex', borderBottom: '1px solid #e5e7eb' }}>
          {(['affected', 'impacted'] as const).map(tab => {
            const active = ciTab === tab
            return (
              <button key={tab} type="button" onClick={() => setCITab(tab)} style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '8px 16px', fontSize: 'var(--font-size-body)', background: 'none', border: 'none', cursor: 'pointer',
                borderBottom: active ? '2px solid var(--color-brand)' : '2px solid transparent',
                color: active ? 'var(--color-brand)' : 'var(--color-slate-light)',
                fontWeight: active ? 600 : 500,
              }}>
                {tab === 'affected' ? 'CI Affected' : 'CI Impacted'}
                <span style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, padding: '1px 6px', borderRadius: 8, backgroundColor: active ? 'var(--color-brand-light)' : '#f1f5f9', color: active ? 'var(--color-brand)' : 'var(--color-slate-light)' }}>
                  {tab === 'affected' ? affected.length : impactedCIs.length}
                </span>
              </button>
            )
          })}
        </div>
        <div>
          {ciTab === 'affected' && (
            <>
              {currentStep === wfInitialStep?.name && (
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
                  <button type="button" onClick={() => setShowAddCI(true)} style={{
                    padding: '4px 10px', borderRadius: 6, border: '1px solid var(--color-brand)',
                    color: 'var(--color-brand)', background: 'transparent',
                    fontSize: 'var(--font-size-label)', fontWeight: 500, cursor: 'pointer',
                    display: 'flex', alignItems: 'center', gap: 4,
                  }}>
                    <Plus size={12} /> Aggiungi
                  </button>
                </div>
              )}
              {affected.map((a) => (
                <div key={a.ci.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid #f3f4f6', fontSize: 'var(--font-size-body)' }}>
                  <span style={{ flex: 1, fontWeight: 500, color: 'var(--color-slate-dark)' }}>{a.ci.name}</span>
                  {a.ci.type && <span style={{ fontSize: 'var(--font-size-label)', padding: '1px 6px', borderRadius: 4, backgroundColor: '#f1f5f9', color: 'var(--color-slate)' }}>{a.ci.type}</span>}
                  {a.ci.environment && <span style={{ fontSize: 'var(--font-size-label)', padding: '1px 6px', borderRadius: 4, backgroundColor: '#f1f5f9', color: 'var(--color-slate)' }}>{a.ci.environment}</span>}
                  {currentStep === wfInitialStep?.name && (
                    <button
                      type="button"
                      onClick={() => setConfirmRemoveCI({ id: a.ci.id, name: a.ci.name })}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: 'var(--color-slate-light)', flexShrink: 0 }}
                      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--color-danger)' }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--color-slate-light)' }}
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
              ))}
            </>
          )}
          {ciTab === 'impacted' && (
            <>
              <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 'var(--font-size-label)', fontWeight: 500, color: 'var(--color-slate-light)', textTransform: 'uppercase' }}>Profondità</span>
                <select value={impactDepth} onChange={e => setImpactDepth(Number(e.target.value))} style={{ padding: '4px 8px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 'var(--font-size-body)' }}>
                  {[1, 2, 3, 4, 5].map(d => <option key={d} value={d}>{d}</option>)}
                </select>
              </div>
              {impactError && (
                <div style={{ padding: '10px 12px', backgroundColor: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, fontSize: 'var(--font-size-body)', color: 'var(--color-danger, #ef4444)', marginBottom: 8 }}>
                  Errore nel calcolo dei CI impattati: {impactError.message}{' '}
                  <button type="button" onClick={() => void refetchImpacted()} style={{ background: 'none', border: 'none', color: 'var(--color-danger, #ef4444)', textDecoration: 'underline', cursor: 'pointer', fontSize: 'var(--font-size-body)', padding: 0 }}>Riprova</button>
                </div>
              )}
              {!impactError && impactedCIs.length === 0 && <EmptyState icon={<ChevronRight size={24} />} title="Nessun CI impattato" description={`Nessun CI impattato a profondità ${impactDepth}.`} />}
              {impactedCIs.length > 0 && (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid #e5e7eb', fontSize: 'var(--font-size-label)', fontWeight: 600, color: 'var(--color-slate-light)', textTransform: 'uppercase' }}>
                    <span style={{ width: 24, flexShrink: 0 }} />
                    <span style={{ flex: 1 }}>CI Impattato</span>
                    <span style={{ width: 80 }}>Tipo</span>
                    <span style={{ width: 80 }}>Env</span>
                    <span style={{ width: 60 }}>Dist.</span>
                    <span style={{ width: 140 }}>Impattato da</span>
                    {currentStep === wfInitialStep?.name && <span style={{ width: 100, flexShrink: 0 }} />}
                  </div>
                  {impactedCIs.map((b, i) => {
                    const rowId = `${b.ci.id}-${i}`
                    const isOpen = expandedImpactId === rowId
                    const hasPath = b.impactPath.length >= 2
                    return (
                      <div key={rowId}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid #f3f4f6', fontSize: 'var(--font-size-body)' }}>
                          <span style={{ width: 24, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            {hasPath && (
                              <button type="button" aria-expanded={isOpen} aria-label={b.ci.name} onClick={() => setExpandedImpactId(prev => prev === rowId ? null : rowId)} style={{ cursor: 'pointer', background: 'none', border: 'none', padding: 0, display: 'flex', alignItems: 'center', font: 'inherit', color: 'inherit' }}>
                                <ChevronRight size={14} color="var(--color-slate-light)" style={{ transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }} />
                              </button>
                            )}
                          </span>
                          <span style={{ flex: 1, fontWeight: 500, color: 'var(--color-slate-dark)' }}>{b.ci.name}</span>
                          <span style={{ width: 80 }}>{b.ci.type ? <span style={{ fontSize: 'var(--font-size-label)', padding: '1px 6px', borderRadius: 4, backgroundColor: '#f1f5f9', color: 'var(--color-slate)' }}>{b.ci.type}</span> : null}</span>
                          <span style={{ width: 80 }}>{b.ci.environment ? <span style={{ fontSize: 'var(--font-size-label)', padding: '1px 6px', borderRadius: 4, backgroundColor: '#f1f5f9', color: 'var(--color-slate)' }}>{b.ci.environment}</span> : null}</span>
                          <span style={{ width: 60 }}><span style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, padding: '1px 6px', borderRadius: 4, backgroundColor: b.distance === 1 ? 'var(--color-danger-bg)' : b.distance === 2 ? '#fff7ed' : '#f1f5f9', color: b.distance === 1 ? 'var(--color-danger)' : b.distance === 2 ? '#b45309' : 'var(--color-slate)' }}>{b.distance} hop</span></span>
                          <span style={{ width: 140, fontSize: 'var(--font-size-label)', color: 'var(--color-slate)' }}>{b.affectedBy.name}</span>
                          {currentStep === wfInitialStep?.name && (
                            <span style={{ width: 100, flexShrink: 0, display: 'flex', justifyContent: 'flex-end' }}>
                              <button
                                type="button"
                                title="Sposta in CI Affected"
                                onClick={() => void addCIFromImpacted({ variables: { changeId, ciId: b.ci.id } })}
                                style={{
                                  padding: '4px 8px', borderRadius: 6, border: '1px solid var(--color-brand)',
                                  color: 'var(--color-brand)', background: 'transparent',
                                  fontSize: 'var(--font-size-label)', fontWeight: 500, cursor: 'pointer',
                                  display: 'flex', alignItems: 'center', gap: 4,
                                }}
                              >
                                <PlusCircle size={14} /> Aggiungi
                              </button>
                            </span>
                          )}
                        </div>
                        {isOpen && hasPath && (
                          <div style={{ padding: '8px 0 8px 28px', fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)' }}>
                            {b.impactPath.join(' → ')}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </>
              )}
            </>
          )}
        </div>

        {showAddCI && (
          <AddCIModal
            changeId={changeId}
            existingCIIds={new Set(affected.map(a => a.ci.id))}
            onClose={() => setShowAddCI(false)}
            refetchAffected={refetchAffected}
            refetchImpacted={refetchImpacted}
            refetchAudit={refetchAudit}
          />
        )}

        {confirmRemoveCI && (
          <Modal
            open
            onClose={() => setConfirmRemoveCI(null)}
            title="Rimuovere CI"
            width={420}
            footer={
              <>
                <Button variant="secondary" size="xs" onClick={() => setConfirmRemoveCI(null)}>Annulla</Button>
                <Button size="xs" onClick={() => void removeCI({ variables: { changeId, ciId: confirmRemoveCI.id } })} style={{ backgroundColor: 'var(--color-danger)', fontWeight: 600 }}>Rimuovi</Button>
              </>
            }
          >
            <p style={{ margin: 0, fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>
              Rimuovere <strong>{confirmRemoveCI.name}</strong> dal change? Tutti i task associati verranno eliminati.
            </p>
          </Modal>
        )}
      </SectionCard>

      {rejectModal && (() => {
        const taskGroups = affected.map((a) => ({
          ciName: a.ci.name,
          tasks: [
            a.assessmentOwner   ? { id: a.assessmentOwner.id,   label: 'Functional', code: a.assessmentOwner.code,   status: a.assessmentOwner.status } : null,
            a.assessmentSupport ? { id: a.assessmentSupport.id, label: 'Technical',  code: a.assessmentSupport.code, status: a.assessmentSupport.status } : null,
            a.deployPlan        ? { id: a.deployPlan.id,        label: 'Planning',   code: a.deployPlan.code,        status: a.deployPlan.status } : null,
          ].filter((x): x is { id: string; label: string; code: string; status: string } => !!x),
        })).filter((g) => g.tasks.length > 0)
        const canConfirm = rejectNote.trim() !== '' && (reopenMode === 'all' || reopenIds.size > 0)
        return (
        <Modal
          open
          onClose={() => setRejectModal(null)}
          title={`Rigetta approvazione — ${rejectModal.teamName}`}
          width={520}
          footer={
            <>
              <Button variant="secondary" size="xs" onClick={() => setRejectModal(null)}>Annulla</Button>
              <Button
                size="xs"
                disabled={!canConfirm}
                onClick={async () => {
                  const m = rejectModal
                  setRejectModal(null)
                  await rejectApproval({ variables: {
                    changeId, teamId: m.teamId, note: rejectNote.trim(),
                    reopenAll: reopenMode === 'all',
                    reopenTaskIds: reopenMode === 'some' ? [...reopenIds] : null,
                  } })
                }}
                style={{ backgroundColor: 'var(--color-danger)', fontWeight: 600, opacity: canConfirm ? 1 : 0.6 }}
              >
                Rigetta
              </Button>
            </>
          }
        >
          <p style={{ margin: '0 0 10px', fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>
            Il rigetto riporta la change in <strong>assessment</strong> riaprendo i task selezionati e azzera le approvazioni.
          </p>

          <label htmlFor={rejectNoteId} style={{ display: 'block', fontSize: 'var(--font-size-label)', fontWeight: 600, color: 'var(--color-slate-light)', textTransform: 'uppercase', marginBottom: 6 }}>Motivo <span style={{ color: 'var(--color-danger)' }}>*</span></label>
          <textarea
            id={rejectNoteId}
            value={rejectNote}
            onChange={(e) => setRejectNote(e.target.value)}
            rows={3}
            style={{ width: '100%', padding: 8, border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 'var(--font-size-body)', boxSizing: 'border-box', fontFamily: 'inherit', marginBottom: 14 }}
            // eslint-disable-next-line jsx-a11y/no-autofocus -- focus management: textarea del modal di rigetto aperto dall'utente
            autoFocus
          />

          <fieldset style={{ border: 'none', padding: 0, margin: 0 }}>
            <legend style={{ display: 'block', fontSize: 'var(--font-size-label)', fontWeight: 600, color: 'var(--color-slate-light)', textTransform: 'uppercase', marginBottom: 6, padding: 0 }}>Assessment da riaprire</legend>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 'var(--font-size-body)' }}>
                <input type="radio" name="reopenMode" checked={reopenMode === 'all'} onChange={() => setReopenMode('all')} />
                Riapri <strong>tutti</strong> gli assessment
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 'var(--font-size-body)' }}>
                <input type="radio" name="reopenMode" checked={reopenMode === 'some'} onChange={() => setReopenMode('some')} />
                Riapri <strong>alcuni specifici</strong>
              </label>
            </div>
          </fieldset>

          {reopenMode === 'some' && (
            <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 12px', maxHeight: 240, overflowY: 'auto' }}>
              {taskGroups.length === 0 ? (
                <p style={{ margin: 0, fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)' }}>Nessun task disponibile.</p>
              ) : taskGroups.map((g) => (
                <div key={g.ciName} style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 'var(--font-size-label)', fontWeight: 700, color: 'var(--color-slate)', textTransform: 'uppercase', letterSpacing: '0.03em', padding: '4px 0' }}>{g.ciName}</div>
                  {g.tasks.map((t) => (
                    <label key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0 3px 12px', cursor: 'pointer', fontSize: 'var(--font-size-body)' }}>
                      <input
                        type="checkbox"
                        checked={reopenIds.has(t.id)}
                        onChange={(e) => setReopenIds((prev) => { const n = new Set(prev); if (e.target.checked) n.add(t.id); else n.delete(t.id); return n })}
                      />
                      <span style={{ flex: 1 }}>{t.label}{t.code && <span style={{ marginLeft: 6, fontSize: 'var(--font-size-caption)', color: 'var(--color-slate-light)', fontWeight: 600 }}>{t.code}</span>}</span>
                      <span style={{ fontSize: 'var(--font-size-caption)', color: 'var(--color-slate-light)', textTransform: 'capitalize' }}>{(t.status ?? '').replace(/_/g, ' ')}</span>
                    </label>
                  ))}
                </div>
              ))}
            </div>
          )}
        </Modal>
        )
      })()}

      {transitionModal && (
        <Modal
          open
          onClose={() => setTransitionModal(null)}
          title={transitionModal.label}
          footer={
            <>
              <Button variant="secondary" size="xs" onClick={() => setTransitionModal(null)}>Annulla</Button>
              <Button
                size="xs"
                disabled={!transitionNotes.trim()}
                onClick={async () => {
                  const m = transitionModal
                  setTransitionModal(null)
                  await runTransition(m.toStep, m.label, transitionNotes.trim())
                }}
                style={{ fontWeight: 600, opacity: transitionNotes.trim() ? 1 : 0.6 }}
              >
                Conferma
              </Button>
            </>
          }
        >
          <FieldLabel htmlFor={transitionNotesId} style={{ fontWeight: 400 }}>
            {transitionModal.inputField ?? 'Note'}
          </FieldLabel>
          <textarea
            id={transitionNotesId}
            value={transitionNotes}
            onChange={(e) => setTransitionNotes(e.target.value)}
            rows={4}
            style={{ width: '100%', padding: 8, border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 'var(--font-size-body)', boxSizing: 'border-box', fontFamily: 'inherit' }}
            // eslint-disable-next-line jsx-a11y/no-autofocus -- focus management: textarea del modal di transizione aperto dall'utente
            autoFocus
          />
        </Modal>
      )}

      <AttachmentsSection entityType="change" entityId={change.id} defaultOpen={false} />

      <AuditTimeline audit={audit} />

      {confirmDelete && (
        <Modal
          open
          onClose={() => setConfirmDelete(false)}
          title="Elimina change"
          width={460}
          footer={
            <>
              <Button variant="secondary" size="xs" onClick={() => setConfirmDelete(false)}>Annulla</Button>
              <Button size="xs" disabled={deleting} onClick={() => void deleteChange({ variables: { id: changeId } })} style={{ backgroundColor: 'var(--color-danger)', fontWeight: 600 }}>Elimina</Button>
            </>
          }
        >
          <p style={{ margin: 0, fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>
            Eliminare <strong>{change.code}</strong>? La change sparirà dagli elenchi e i suoi collegamenti (incluso quello creato automaticamente dal ticket richiedente) non saranno più mostrati. L'operazione è una cancellazione logica.
          </p>
        </Modal>
      )}
    </PageContainer>
  )
}
