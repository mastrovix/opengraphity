/**
 * ChangeDetailPage — orchestrator only. Queries the change aggregate and
 * delegates rendering to focused, prop-driven components under ./components.
 *
 * All shared state (current change, affected CIs, audit trail, who the
 * viewer is, which step we're in) lives here. Child components receive
 * what they need via props and manage only their own local UI state
 * (e.g. which modal is open inside a row).
 */
import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation } from '@apollo/client/react'
import { toast } from 'sonner'
import { ChevronRight, Plus, PlusCircle, X } from 'lucide-react'
import { PageContainer } from '@/components/PageContainer'
import { Button } from '@/components/Button'
import { Modal } from '@/components/Modal'
import { SectionCard } from '@/components/ui/SectionCard'
import { AttachmentsSection } from '@/components/AttachmentsSection'
import { EmptyState } from '@/components/EmptyState'
import {
  GET_CHANGE,
  GET_CHANGE_AFFECTED_CIS,
  GET_CHANGE_AUDIT_TRAIL,
  GET_CHANGE_IMPACTED_CIS,
  GET_ME,
} from '@/graphql/queries'
import {
  EXECUTE_CHANGE_TRANSITION,
  ADD_CI_TO_CHANGE,
  REMOVE_CI_FROM_CHANGE,
} from '@/graphql/mutations'
import { useWorkflowSteps } from '@/hooks/useWorkflowSteps'
import { TASK_STATUS } from '@/lib/taskStatus'
import type { AffectedCI, ChangeAuditEntryData, ChangeData, MeData } from '@/types/change'
import { PhaseChipBar } from './components/PhaseChipBar'
import { ChangeInfoCard } from './components/ChangeInfoCard'
import { CITasksTable } from './components/CITasksTable'
import { AuditTimeline } from './components/AuditTimeline'
import { AddCIModal } from './components/AddCIModal'
import { fmtShort } from './components/shared'

interface ImpactedCIRow {
  ci: { id: string; name: string; type: string | null; environment: string | null }
  distance: number
  affectedBy: { id: string; name: string; type: string | null }
  impactPath: string[]
}

export function ChangeDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const changeId = id ?? ''

  const { data: changeData, loading, refetch: refetchChange } = useQuery<{ change: ChangeData | null }>(GET_CHANGE, { variables: { id: changeId }, fetchPolicy: 'cache-and-network' })
  const { data: affectedData, refetch: refetchAffected } = useQuery<{ changeAffectedCIs: AffectedCI[] }>(GET_CHANGE_AFFECTED_CIS, { variables: { changeId }, fetchPolicy: 'cache-and-network' })
  const { data: auditData, refetch: refetchAudit } = useQuery<{ changeAuditTrail: ChangeAuditEntryData[] }>(GET_CHANGE_AUDIT_TRAIL, { variables: { changeId }, fetchPolicy: 'cache-and-network' })
  const { data: meData } = useQuery<{ me: MeData | null }>(GET_ME, { fetchPolicy: 'cache-first' })
  const { steps: wfSteps, byName: wfByName, initialStep: wfInitialStep, isTerminal: wfIsTerminal } = useWorkflowSteps('change')

  const refetchAll = async () => { await refetchChange(); await refetchAffected(); await refetchAudit() }
  const [executeTransition, { loading: transitioning }] = useMutation(EXECUTE_CHANGE_TRANSITION, {
    onCompleted: async () => { await refetchAll() },
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

  const change = changeData?.change
  const affected = Array.from(new Map((affectedData?.changeAffectedCIs ?? []).map(a => [a.ci.id, a])).values())
  const audit = auditData?.changeAuditTrail ?? []
  const isAdmin = meData?.me?.role === 'admin'
  const userTeamIds = new Set((meData?.me?.teams ?? []).map(t => t.id))

  const [impactDepth, setImpactDepth] = useState(1)
  const { data: impactData, error: impactError, refetch: refetchImpacted } = useQuery<{ changeImpactedCIs: ImpactedCIRow[] }>(
    GET_CHANGE_IMPACTED_CIS, { variables: { changeId, depth: impactDepth }, fetchPolicy: 'cache-and-network' },
  )
  if (impactError) console.error('[changeImpactedCIs] GraphQL error:', impactError.message)
  const impactedCIs = impactData?.changeImpactedCIs ?? []

  const [ciTab, setCITab] = useState<'affected' | 'impacted'>('affected')
  const [expandedImpactId, setExpandedImpactId] = useState<string | null>(null)
  const [showAddCI, setShowAddCI] = useState(false)
  const [confirmRemoveCI, setConfirmRemoveCI] = useState<{ id: string; name: string } | null>(null)
  const [removeCI] = useMutation(REMOVE_CI_FROM_CHANGE, {
    onCompleted: () => {
      void refetchImpacted()
      void refetchAffected()
      void refetchAudit()
      toast.success('CI rimosso')
      setConfirmRemoveCI(null)
    },
    onError: (e) => toast.error(e.message),
  })
  const [addCIFromImpacted] = useMutation(ADD_CI_TO_CHANGE, {
    onCompleted: () => {
      void refetchImpacted()
      void refetchAffected()
      void refetchAudit()
      toast.success('CI aggiunto agli affected')
    },
    onError: (e) => toast.error(e.message),
  })

  if (loading && !change) return <PageContainer><p>Caricamento...</p></PageContainer>
  if (!change) return <PageContainer><p>Change non trovato</p></PageContainer>

  const currentStep = change.workflowInstance?.currentStep ?? ''
  const transitions = change.availableTransitions ?? []

  const totalTasks = affected.length * 3
  const completedTasks = affected.reduce((n, a) => n
    + (a.assessmentOwner?.status === TASK_STATUS.COMPLETED ? 1 : 0)
    + (a.assessmentSupport?.status === TASK_STATUS.COMPLETED ? 1 : 0)
    + (a.deployPlan?.status === TASK_STATUS.COMPLETED ? 1 : 0), 0)

  const allScores = affected.filter(a => a.riskScore != null).map(a => a.riskScore!)
  const allAssessmentsDone = affected.length > 0 && affected.every(a => a.assessmentOwner?.status === TASK_STATUS.COMPLETED && a.assessmentSupport?.status === TASK_STATUS.COMPLETED)
  const liveRoute = allScores.length === 0
    ? { label: '— da calcolare —', color: 'var(--color-slate-light)', bg: '#f1f5f9' }
    : (() => {
        const max = Math.max(...allScores)
        const route = max <= 30 ? 'Auto' : max <= 60 ? 'Change Manager' : 'CAB'
        const suffix = allAssessmentsDone ? '' : ' (stima)'
        const c = allAssessmentsDone ? (max <= 30 ? '#15803d' : max <= 60 ? '#b45309' : '#b91c1c') : 'var(--color-slate)'
        const bg = allAssessmentsDone ? (max <= 30 ? '#dcfce7' : max <= 60 ? '#fef3c7' : '#fee2e2') : '#f1f5f9'
        return { label: `${route}${suffix}`, color: c, bg }
      })()

  return (
    <PageContainer style={{ padding: '16px 24px' }}>
      <button onClick={() => navigate('/changes')} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', marginBottom: 12, padding: 0 }}>← Changes</button>
      <h1 style={{ fontSize: 'var(--font-size-page-title)', fontWeight: 600, color: 'var(--color-slate-dark)', margin: '0 0 12px' }}>{change.code}</h1>
      <PhaseChipBar current={currentStep} steps={wfSteps} />

      <ChangeInfoCard
        change={change}
        currentStep={currentStep}
        initialStepName={wfInitialStep?.name ?? null}
        isTerminal={wfIsTerminal(currentStep)}
        isAdmin={isAdmin}
        transitioning={transitioning}
        liveRoute={liveRoute}
        totalTasks={totalTasks}
        completedTasks={completedTasks}
        transitions={transitions}
        stepLabel={wfByName.get(currentStep)?.label ?? currentStep}
        onTransitionClick={(tr) => {
          if (tr.requiresInput) {
            setTransitionNotes('')
            setTransitionModal({ toStep: tr.toStep, label: tr.label, inputField: tr.inputField })
          } else {
            void runTransition(tr.toStep, tr.label)
          }
        }}
      />

      {!wfIsTerminal(currentStep) && affected.some(a => a.deployPlan && a.deployPlan.steps.length > 0 && !a.validation) && (
        <SectionCard title="Prossimi Step" collapsible={false}>
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

      <CITasksTable affected={affected} isAdmin={isAdmin} userTeamIds={userTeamIds} />

      <SectionCard title="CIs Involved" collapsible defaultOpen>
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
              {impactedCIs.length === 0 && <EmptyState icon={<ChevronRight size={24} />} title="Nessun CI impattato" description={`Nessun CI impattato a profondità ${impactDepth}.`} />}
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
                              <span onClick={() => setExpandedImpactId(prev => prev === rowId ? null : rowId)} style={{ cursor: 'pointer' }}>
                                <ChevronRight size={14} color="var(--color-slate-light)" style={{ transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }} />
                              </span>
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
          <label style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4, display: 'block' }}>
            {transitionModal.inputField ?? 'Note'}
          </label>
          <textarea
            value={transitionNotes}
            onChange={(e) => setTransitionNotes(e.target.value)}
            rows={4}
            style={{ width: '100%', padding: 8, border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 'var(--font-size-body)', boxSizing: 'border-box', fontFamily: 'inherit' }}
            autoFocus
          />
        </Modal>
      )}

      <AttachmentsSection entityType="change" entityId={change.id} />

      <AuditTimeline audit={audit} />
    </PageContainer>
  )
}
