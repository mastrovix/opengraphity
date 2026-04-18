import { useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useQuery, useMutation } from '@apollo/client/react'
import { toast } from 'sonner'
import { Eye, X, ChevronRight, ExternalLink, Search, Plus, PlusCircle } from 'lucide-react'
import { PageContainer } from '@/components/PageContainer'
import { SectionCard } from '@/components/ui/SectionCard'
import { EmptyState } from '@/components/EmptyState'
import {
  GET_CHANGE,
  GET_CHANGE_AFFECTED_CIS,
  GET_CHANGE_AUDIT_TRAIL,
  GET_CHANGE_IMPACTED_CIS,
  GET_ALL_CIS,
  GET_ME,
} from '@/graphql/queries'
import {
  EXECUTE_CHANGE_TRANSITION,
  ADD_CI_TO_CHANGE,
  REMOVE_CI_FROM_CHANGE,
} from '@/graphql/mutations'
import { useWorkflowSteps } from '@/hooks/useWorkflowSteps'

// ── Types ─────────────────────────────────────────────────────────────────────

interface AvailableTransition {
  toStep: string; label: string; requiresInput: boolean
  inputField: string | null; condition: string | null
}
interface ChangeData {
  id: string; code: string; title: string; description: string | null
  aggregateRiskScore: number | null; approvalRoute: string | null; approvalStatus: string | null
  approvalAt: string | null; createdAt: string; updatedAt: string
  requester: { name: string } | null; changeOwner: { name: string } | null
  approvalBy: { name: string } | null
  workflowInstance: { id: string; currentStep: string; status: string } | null
  availableTransitions: AvailableTransition[]
}

interface TimeWindow { start: string; end: string }
interface DeployStep { title: string; validationWindow: TimeWindow; releaseWindow: TimeWindow }
interface ResponseDetail { question: { id: string; text: string; category: string }; selectedOption: { id: string; label: string; score: number } }
interface AssessmentTask { id: string; code: string; responderRole: string; status: string; score: number | null; completedBy: { name: string } | null; completedAt: string | null; assignedTeam: { name: string } | null; assignee: { name: string } | null; responses: ResponseDetail[] }
interface DeployPlanTask { id: string; code: string; status: string; steps: DeployStep[]; completedBy: { name: string } | null; completedAt: string | null; assignedTeam: { name: string } | null; assignee: { name: string } | null }
interface AffectedCI {
  ciPhase: string; riskScore: number | null
  ci: { id: string; name: string; type: string | null; environment: string | null; ownerGroup: { id: string } | null; supportGroup: { id: string } | null }
  assessmentOwner: AssessmentTask | null; assessmentSupport: AssessmentTask | null
  deployPlan: DeployPlanTask | null
  validation: { id: string; code: string; status: string; result: string | null; testedAt: string | null; testedBy: { name: string } | null } | null
  deployment: { id: string; code: string; status: string; deployedAt: string | null; deployedBy: { name: string } | null } | null
  review: { id: string; code: string; status: string; result: string | null; reviewedAt: string | null; reviewedBy: { name: string } | null } | null
}

interface AuditEntry { timestamp: string; action: string; detail: string | null; actor: { name: string } | null }

// ── Helpers ───────────────────────────────────────────────────────────────────

function StatusLabel({ status }: { status: string | null | undefined }) {
  const s = status ?? '—'
  const color = s === 'completed' ? '#16a34a' : s === 'in-progress' ? '#f59e0b' : s === 'pending' ? '#ef4444' : s === 'failed' || s === 'rejected' ? '#ef4444' : '#d1d5db'
  const label = s === 'pending' ? 'TO BE COMPLETED' : s.replace(/_/g, ' ')
  return <strong style={{ color, textTransform: 'uppercase' }}>{label}</strong>
}

function RiskBadge({ score }: { score: number | null | undefined }) {
  if (score == null) return <span style={{ color: 'var(--color-slate-light)' }}>—</span>
  const p = score <= 30 ? { bg: '#dcfce7', color: '#15803d', label: 'LOW' } : score <= 60 ? { bg: '#fef3c7', color: '#b45309', label: 'MEDIUM' } : { bg: '#fee2e2', color: '#b91c1c', label: 'HIGH' }
  return <span style={{ padding: '2px 8px', borderRadius: 6, fontSize: 'var(--font-size-label)', fontWeight: 600, backgroundColor: p.bg, color: p.color }}>{p.label} · {score}</span>
}

function fmtDate(iso: string | null | undefined): string { if (!iso) return '—'; try { return new Date(iso).toLocaleDateString() } catch { return iso } }

function PhaseChipBar({ current, steps }: {
  current: string
  steps: Array<{ name: string; label: string; isTerminal: boolean }>
}) {
  if (steps.length === 0) return null
  const curIdx = steps.findIndex((s) => s.name === current)
  const terminal = steps.find((s) => s.name === current)?.isTerminal ?? false
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 0, width: '60%', margin: '20px auto 24px' }}>
      {steps.map((p, i) => {
        const isCur = !terminal && i === curIdx
        const isPast = terminal || i < curIdx
        const isLast = i === steps.length - 1
        const labelColor = isCur ? 'var(--color-brand)' : isPast ? 'var(--color-slate-dark)' : 'var(--color-slate-light)'
        const lineColor = isPast ? 'var(--color-brand)' : '#e5e7eb'

        return (
          <div key={p.name} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', position: 'relative' }}>
            {!isLast && (
              <div style={{ position: 'absolute', top: 4, left: '50%', right: '-50%', height: 2, background: lineColor, zIndex: 0 }} />
            )}
            <div style={{
              width: 10, height: 10, borderRadius: '50%', zIndex: 1,
              backgroundColor: (isPast || isCur) ? 'var(--color-brand)' : '#e5e7eb',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: isCur ? '0 0 0 4px rgba(2,132,199,0.2)' : 'none',
            }}>
              {isPast && (
                <svg width={8} height={8} viewBox="0 0 8 8"><path d="M1 4L3 6L7 2" fill="none" stroke="#fff" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" /></svg>
              )}
            </div>
            <span style={{ marginTop: 6, fontSize: 11, fontWeight: 500, color: labelColor, textAlign: 'center', whiteSpace: 'nowrap' }}>
              {p.label}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ── Expanded Row ──────────────────────────────────────────────────────────────

function fmtShort(iso: string | null | undefined): string {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    const p = (n: number) => String(n).padStart(2, '0')
    return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`
  } catch { return iso }
}

function TaskStatusRow({ label, code, status, scheduledDate, result, actor, date, assignedTeam, assignee, action }: {
  label: string; code?: string; status: string | null; scheduledDate?: string | null
  result?: string | null; actor?: string | null; date?: string | null
  assignedTeam?: string | null; assignee?: string | null
  action?: React.ReactNode
}) {
  const isScheduled = scheduledDate && status === 'pending' && new Date(scheduledDate).getTime() > Date.now()
  const isCompleted = status === 'completed'
  return (
    <div style={{ display: 'flex', gap: 8, padding: '6px 0', borderBottom: '1px solid #f3f4f6', fontSize: 'var(--font-size-label)' }}>
      <span style={{ width: 90, flexShrink: 0, color: 'var(--color-slate)', fontWeight: 500, paddingTop: 1 }}>{label}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {code && <span style={{ fontWeight: 500, color: 'var(--color-slate-dark)' }}>{code}</span>}
          {isScheduled
            ? <span style={{ color: 'var(--color-slate-light)' }}>Schedulato — {fmtShort(scheduledDate)}</span>
            : status ? <StatusLabel status={status} /> : <span style={{ color: '#d1d5db' }}>—</span>
          }
          {!isScheduled && result && <span style={{ color: 'var(--color-slate)' }}>· {result}</span>}
        </div>
        {isCompleted && (actor || date) && (
          <div style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)', marginTop: 2 }}>
            {actor}{actor && date ? ' · ' : ''}{date ? fmtShort(date) : ''}
          </div>
        )}
        {!isCompleted && assignedTeam && (
          <div style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)', marginTop: 2 }}>
            Assegnato a: <span style={{ fontWeight: 600 }}>{assignedTeam}</span>{assignee ? ` — ${assignee}` : ''}
          </div>
        )}
      </div>
      {action && <span style={{ flexShrink: 0, paddingTop: 1 }}>{action}</span>}
    </div>
  )
}

function OpenTaskButton({ taskId }: { taskId: string }) {
  return (
    <Link to={`/tasks/${taskId}`} onClick={(e) => e.stopPropagation()} style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '4px 10px', borderRadius: 6, border: '1px solid var(--color-brand)',
      fontSize: 'var(--font-size-label)', fontWeight: 500,
      color: 'var(--color-brand)', background: 'transparent', textDecoration: 'none',
    }}>
      <ExternalLink size={12} /> Apri
    </Link>
  )
}

function EyeButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={(e) => { e.stopPropagation(); onClick() }} style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      background: 'none', border: '1px solid #e5e7eb', borderRadius: 4,
      padding: '2px 6px', cursor: 'pointer', fontSize: 'var(--font-size-label)',
      color: 'var(--color-brand)', fontWeight: 500,
    }}>
      <Eye size={12} /> Vedi
    </button>
  )
}

function ModalOverlay({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }} onClick={onClose}>
      <div style={{ background: '#fff', borderRadius: 12, padding: 24, maxWidth: 600, width: '90%', maxHeight: '80vh', overflowY: 'auto', boxShadow: '0 8px 24px rgba(0,0,0,0.15)' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 'var(--font-size-card-title)', color: 'var(--color-slate-dark)' }}>{title}</h3>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}><X size={18} color="var(--color-slate-light)" /></button>
        </div>
        {children}
      </div>
    </div>
  )
}

function CIExpandedRow({ a }: { a: AffectedCI }) {
  const bothAssessDone = a.assessmentOwner?.status === 'completed' && a.assessmentSupport?.status === 'completed'
  const [modal, setModal] = useState<'functional' | 'technical' | 'plan' | null>(null)

  const renderResponsesModal = (task: AssessmentTask, label: string) => (
    <ModalOverlay title={`Risposte ${label} — ${a.ci.name}`} onClose={() => setModal(null)}>
      {!bothAssessDone ? (
        <p style={{ color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)', margin: '16px 0' }}>
          Le risposte saranno visibili quando entrambi gli assessment saranno completati.
        </p>
      ) : (
        <>
          {task.responses.map((r, i) => (
            <div key={i} style={{ padding: '8px 0', borderBottom: '1px solid #f3f4f6' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', flex: 1 }}>{r.question.text}</span>
                <span style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, padding: '1px 6px', borderRadius: 4, backgroundColor: '#f1f5f9', color: 'var(--color-slate)', whiteSpace: 'nowrap', flexShrink: 0 }}>W:{r.selectedOption.score}</span>
              </div>
              <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-brand)', fontWeight: 500 }}>
                {r.selectedOption.label} ({r.selectedOption.score})
              </div>
            </div>
          ))}
          <div style={{ marginTop: 12, fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate-dark)' }}>
            Score: {task.score ?? '—'}
          </div>
        </>
      )}
    </ModalOverlay>
  )

  const renderPlanModal = () => {
    const steps = a.deployPlan?.steps ?? []
    return (
      <ModalOverlay title={`Piano di Deploy — ${a.ci.name}`} onClose={() => setModal(null)}>
        {steps.map((s, i) => (
          <div key={i} style={{ padding: '10px 0', borderBottom: i < steps.length - 1 ? '1px solid #f3f4f6' : 'none' }}>
            <div style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate-dark)', marginBottom: 4 }}>Step {i + 1}: {s.title}</div>
            <div style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate)' }}>
              Validazione: {fmtShort(s.validationWindow.start)} → {fmtShort(s.validationWindow.end)}
            </div>
            <div style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate)' }}>
              Deploy: {fmtShort(s.releaseWindow.start)} → {fmtShort(s.releaseWindow.end)}
            </div>
          </div>
        ))}
        {steps.length === 0 && <p style={{ color: 'var(--color-slate-light)', margin: 0 }}>Nessuno step pianificato</p>}
      </ModalOverlay>
    )
  }

  return (
    <div style={{ padding: '12px 0 12px 16px', fontSize: 'var(--font-size-body)' }}>
      {/* Modals */}
      {modal === 'functional' && a.assessmentOwner && renderResponsesModal(a.assessmentOwner, 'Functional')}
      {modal === 'technical' && a.assessmentSupport && renderResponsesModal(a.assessmentSupport, 'Technical')}
      {modal === 'plan' && renderPlanModal()}

      {/* Task rows — only show tasks that exist, with schedule info + action buttons */}
      {(() => {
        const firstValStart = a.deployPlan?.steps?.[0]?.validationWindow?.start ?? null
        const firstRelStart = a.deployPlan?.steps?.[0]?.releaseWindow?.start ?? null
        const notScheduled = (d: string | null) => !d || new Date(d).getTime() <= Date.now()

        // Task-level actions: "Vedi" on completed tasks, "Apri" on any task
        // that is still actionable (not yet completed). Task status is the
        // only gate — the workflow step doesn't appear here.
        const assessAction = (task: AssessmentTask | null, modalKey: 'functional' | 'technical') => {
          const btns: React.ReactNode[] = []
          if (task?.status === 'completed') btns.push(<EyeButton key="eye" onClick={() => setModal(modalKey)} />)
          if (task && task.status !== 'completed') btns.push(<OpenTaskButton key="open" taskId={task.id} />)
          return btns.length > 0 ? <span style={{ display: 'flex', gap: 4 }}>{btns}</span> : undefined
        }

        const planAction = () => {
          const btns: React.ReactNode[] = []
          if (a.deployPlan?.status === 'completed') btns.push(<EyeButton key="eye" onClick={() => setModal('plan')} />)
          if (a.deployPlan && a.deployPlan.status !== 'completed') btns.push(<OpenTaskButton key="open" taskId={a.deployPlan.id} />)
          return btns.length > 0 ? <span style={{ display: 'flex', gap: 4 }}>{btns}</span> : undefined
        }

        const valAction = () => {
          if (a.validation && a.validation.status !== 'completed' && notScheduled(firstValStart)) return <OpenTaskButton taskId={a.validation.id} />
          return undefined
        }

        const depAction = () => {
          if (a.deployment && a.deployment.status !== 'completed' && a.deployment.status !== 'planning' && notScheduled(firstRelStart)) return <OpenTaskButton taskId={a.deployment.id} />
          return undefined
        }

        const revAction = () => {
          if (a.review && a.review.status !== 'completed') return <OpenTaskButton taskId={a.review.id} />
          return undefined
        }

        return (
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, color: 'var(--color-slate)', textTransform: 'uppercase', marginBottom: 6 }}>Task</div>
            {a.assessmentOwner && (
              <TaskStatusRow label="Functional" code={a.assessmentOwner.code} status={a.assessmentOwner.status ?? null} actor={a.assessmentOwner.completedBy?.name} date={a.assessmentOwner.completedAt}
                assignedTeam={a.assessmentOwner.assignedTeam?.name} assignee={a.assessmentOwner.assignee?.name}
                action={assessAction(a.assessmentOwner, 'functional')} />
            )}
            {a.assessmentSupport && (
              <TaskStatusRow label="Technical" code={a.assessmentSupport.code} status={a.assessmentSupport.status ?? null} actor={a.assessmentSupport.completedBy?.name} date={a.assessmentSupport.completedAt}
                assignedTeam={a.assessmentSupport.assignedTeam?.name} assignee={a.assessmentSupport.assignee?.name}
                action={assessAction(a.assessmentSupport, 'technical')} />
            )}
            {a.deployPlan && (
              <TaskStatusRow label="Planning" code={a.deployPlan.code} status={a.deployPlan.status ?? null} actor={a.deployPlan.completedBy?.name} date={a.deployPlan.completedAt}
                assignedTeam={a.deployPlan.assignedTeam?.name} assignee={a.deployPlan.assignee?.name}
                action={planAction()} />
            )}
            {a.validation && (
              <TaskStatusRow label="Validation" code={a.validation.code} status={a.validation.status ?? null} scheduledDate={firstValStart} result={a.validation.result} actor={a.validation.testedBy?.name} date={a.validation.testedAt}
                action={valAction()} />
            )}
            {a.deployment && a.deployment.status !== 'planning' && (
              <TaskStatusRow label="Deploy" code={a.deployment.code} status={a.deployment.status ?? null} scheduledDate={firstRelStart} actor={a.deployment.deployedBy?.name} date={a.deployment.deployedAt}
                action={depAction()} />
            )}
            {a.review && (
              <TaskStatusRow label="Review" code={a.review.code} status={a.review.status ?? null} result={a.review.result} actor={a.review.reviewedBy?.name} date={a.review.reviewedAt}
                action={revAction()} />
            )}
          </div>
        )
      })()}

      {/* Score summary — only if both assessment done */}
      {bothAssessDone && (
        <div style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate)' }}>
          Functional score: <strong>{a.assessmentOwner?.score ?? '—'}</strong> · Technical score: <strong>{a.assessmentSupport?.score ?? '—'}</strong> · Risk CI: <RiskBadge score={a.riskScore} />
        </div>
      )}
    </div>
  )
}

// ── Audit Timeline ────────────────────────────────────────────────────────────

type AuditCategory = 'stato' | 'assessment' | 'assegnazioni' | 'commenti' | 'sistema'
const AUDIT_CAT_COLOR: Record<AuditCategory, string> = { stato: '#16a34a', assessment: '#2563eb', assegnazioni: '#7c3aed', commenti: '#64748b', sistema: '#94a3b8' }
const AUDIT_CAT_LABEL: Record<AuditCategory, string> = { stato: 'Stato', assessment: 'Assessment', assegnazioni: 'Assegnazioni', commenti: 'Commenti', sistema: 'Sistema' }

function categorizeAction(action: string): AuditCategory {
  const a = action.toLowerCase()
  if (a.includes('phase') || a.includes('approv') || a.includes('reject') || a.includes('auto_approv') || a.includes('closed') || a.includes('advanced_to')) return 'stato'
  if (a.includes('assessment') || a.includes('response') || a.includes('risk') || a.includes('deploy_plan')) return 'assessment'
  if (a.includes('assign') || a.includes('team')) return 'assegnazioni'
  if (a.includes('comment')) return 'commenti'
  return 'sistema'
}

function AuditTimeline({ audit }: { audit: AuditEntry[] }) {
  const [filter, setFilter] = useState<AuditCategory | 'all'>('all')
  const [showAll, setShowAll] = useState(false)
  const [expandedIdx, setExpandedIdx] = useState<Set<number>>(new Set())
  const filtered = filter === 'all' ? audit : audit.filter(e => categorizeAction(e.action) === filter)
  const visible = showAll ? filtered : filtered.slice(0, 20)
  const fmtTS = (iso: string) => { try { const d = new Date(iso); const p = (n: number) => String(n).padStart(2, '0'); return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}` } catch { return iso } }

  return (
    <SectionCard title="Audit Trail" collapsible defaultOpen={false} count={audit.length}>
      <div style={{ marginBottom: 12 }}>
        <select value={filter} onChange={(e) => { setFilter(e.target.value as AuditCategory | 'all'); setShowAll(false) }} style={{ padding: '5px 10px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 'var(--font-size-body)' }}>
          <option value="all">Tutti ({audit.length})</option>
          {(Object.keys(AUDIT_CAT_LABEL) as AuditCategory[]).map(cat => { const n = audit.filter(e => categorizeAction(e.action) === cat).length; return n > 0 ? <option key={cat} value={cat}>{AUDIT_CAT_LABEL[cat]} ({n})</option> : null })}
        </select>
      </div>
      {filtered.length === 0 && <p style={{ color: 'var(--color-slate-light)', margin: 0 }}>Nessun evento</p>}
      <div>
        {visible.map((e, i) => {
          const cat = categorizeAction(e.action); const color = AUDIT_CAT_COLOR[cat]
          const isLong = (e.detail ?? '').length > 120; const isExp = expandedIdx.has(i)
          const isLast = i === visible.length - 1
          return (
            <div key={i} style={{ display: 'flex', gap: 12 }}>
              {/* Left: dot + line */}
              <div style={{ width: 20, flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <div style={{ width: 12, height: 12, borderRadius: '50%', backgroundColor: color, border: '2px solid #fff', boxShadow: '0 0 0 1px #e5e7eb', flexShrink: 0, zIndex: 1 }} />
                {!isLast && <div style={{ width: 2, flex: 1, backgroundColor: '#e5e7eb' }} />}
              </div>
              {/* Right: card */}
              <div style={{ flex: 1, paddingBottom: 10 }}>
                <div style={{ padding: '6px 10px', background: '#f8fafc', borderRadius: 6, border: '1px solid #f3f4f6' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                    <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)' }}>{fmtTS(e.timestamp)}</span>
                    <span style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, padding: '1px 5px', borderRadius: 4, backgroundColor: `${color}15`, color }}>{e.action.replace(/_/g, ' ')}</span>
                    {e.actor && <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate)' }}>{e.actor.name}</span>}
                  </div>
                  {e.detail && <div style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-dark)', ...(isLong && !isExp ? { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' } : {}) }}>{e.detail}</div>}
                  {isLong && <button type="button" onClick={() => setExpandedIdx(prev => { const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n })} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 'var(--font-size-label)', color: 'var(--color-brand)', marginTop: 2 }}>{isExp ? 'Mostra meno' : 'Mostra tutto'}</button>}
                </div>
              </div>
            </div>
          )
        })}
      </div>
      {filtered.length > 20 && !showAll && <button type="button" onClick={() => setShowAll(true)} style={{ marginTop: 6, background: 'none', border: '1px solid #e5e7eb', borderRadius: 6, padding: '5px 12px', cursor: 'pointer', fontSize: 'var(--font-size-body)', color: 'var(--color-brand)' }}>Mostra tutti ({filtered.length})</button>}
    </SectionCard>
  )
}

// ── Add CI Modal ──────────────────────────────────────────────────────────────

function AddCIModal({ changeId, existingCIIds, onClose, refetchAffected, refetchImpacted, refetchAudit }: {
  changeId: string
  existingCIIds: Set<string>
  onClose: () => void
  refetchAffected: () => Promise<unknown>
  refetchImpacted: () => Promise<unknown>
  refetchAudit:    () => Promise<unknown>
}) {
  const [search, setSearch] = useState('')
  const { data: ciData } = useQuery<{ allCIs: { items: Array<{ id: string; name: string; type: string | null; environment: string | null; ownerGroup: { id: string; name: string } | null; supportGroup: { id: string; name: string } | null }> } }>(
    GET_ALL_CIS, { variables: { search, limit: 20 }, skip: search.length < 2, fetchPolicy: 'network-only' },
  )
  const [addCI, { loading }] = useMutation(ADD_CI_TO_CHANGE, {
    onCompleted: () => {
      void refetchImpacted()
      void refetchAffected()
      void refetchAudit()
      toast.success('CI aggiunto')
    },
    onError: (e) => toast.error(e.message),
  })
  const results = ciData?.allCIs?.items ?? []

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }} onClick={onClose}>
      <div style={{ background: '#fff', borderRadius: 12, padding: 24, maxWidth: 560, width: '90%', maxHeight: '80vh', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 24px rgba(0,0,0,0.15)' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 'var(--font-size-card-title)', color: 'var(--color-slate-dark)' }}>Aggiungi CI al Change</h3>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}><X size={18} color="var(--color-slate-light)" /></button>
        </div>
        <div style={{ position: 'relative', marginBottom: 12 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--color-slate-light)' }} />
          <input
            type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Cerca CI per nome..." autoFocus
            style={{ width: '100%', padding: '8px 12px 8px 30px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 'var(--font-size-body)', boxSizing: 'border-box' }}
          />
        </div>
        <div style={{ flex: 1, overflowY: 'auto', maxHeight: 400 }}>
          {search.length < 2 && <p style={{ color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)', margin: 0 }}>Digita almeno 2 caratteri per cercare</p>}
          {search.length >= 2 && results.length === 0 && <p style={{ color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)', margin: 0 }}>Nessun CI trovato</p>}
          {results.map(ci => {
            const alreadyAdded = existingCIIds.has(ci.id)
            const hasOwner = !!ci.ownerGroup
            const hasSupport = !!ci.supportGroup
            const canAdd = !alreadyAdded && hasOwner && hasSupport
            return (
              <div key={ci.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid #f3f4f6' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 500, color: 'var(--color-slate-dark)', fontSize: 'var(--font-size-body)' }}>{ci.name}</div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
                    {ci.type && <span style={{ fontSize: 'var(--font-size-label)', padding: '1px 4px', borderRadius: 3, backgroundColor: '#f1f5f9', color: 'var(--color-slate)' }}>{ci.type}</span>}
                    {ci.environment && <span style={{ fontSize: 'var(--font-size-label)', padding: '1px 4px', borderRadius: 3, backgroundColor: '#f1f5f9', color: 'var(--color-slate)' }}>{ci.environment}</span>}
                  </div>
                  <div style={{ display: 'flex', gap: 12, marginTop: 3, fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)' }}>
                    <span><span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', backgroundColor: hasOwner ? '#16a34a' : '#ef4444', marginRight: 4, verticalAlign: 'middle' }} />Owner: {ci.ownerGroup?.name ?? '—'}</span>
                    <span><span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', backgroundColor: hasSupport ? '#16a34a' : '#ef4444', marginRight: 4, verticalAlign: 'middle' }} />Support: {ci.supportGroup?.name ?? '—'}</span>
                  </div>
                </div>
                {alreadyAdded ? (
                  <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)', flexShrink: 0 }}>Già aggiunto</span>
                ) : (
                  <button
                    type="button" disabled={!canAdd || loading}
                    title={!canAdd ? 'Owner Group e Support Group obbligatori' : undefined}
                    onClick={() => void addCI({ variables: { changeId, ciId: ci.id } })}
                    style={{
                      padding: '4px 10px', borderRadius: 6, border: 'none', fontSize: 'var(--font-size-label)', fontWeight: 600, flexShrink: 0,
                      backgroundColor: canAdd ? 'var(--color-brand)' : '#e5e7eb', color: canAdd ? '#fff' : 'var(--color-slate-light)',
                      cursor: canAdd ? 'pointer' : 'not-allowed',
                    }}
                  >
                    Aggiungi
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ── Detail Fields ─────────────────────────────────────────────────────────────

const fieldLabelStyle: React.CSSProperties = {
  fontSize: 'var(--font-size-label)', fontWeight: 500, color: 'var(--color-slate-light)',
  textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4,
}
const fieldValueStyle: React.CSSProperties = {
  fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)',
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={fieldLabelStyle}>{label}</div>
      <div style={fieldValueStyle}>{value}</div>
    </div>
  )
}

function DescriptionField({ value }: { value: string }) {
  const [showFull, setShowFull] = useState(false)
  return (
    <div>
      <div style={fieldLabelStyle}>Descrizione</div>
      <div style={{ ...fieldValueStyle, ...(showFull ? {} : { display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }) }}>
        {value}
      </div>
      {value.length > 150 && (
        <button type="button" onClick={() => setShowFull(p => !p)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 'var(--font-size-label)', color: 'var(--color-brand)', marginTop: 2 }}>
          {showFull ? 'Mostra meno' : 'Mostra tutto'}
        </button>
      )}
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export function ChangeDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const changeId = id ?? ''

  const { data: changeData, loading, refetch: refetchChange } = useQuery<{ change: ChangeData | null }>(GET_CHANGE, { variables: { id: changeId }, fetchPolicy: 'cache-and-network' })
  const { data: affectedData, refetch: refetchAffected } = useQuery<{ changeAffectedCIs: AffectedCI[] }>(GET_CHANGE_AFFECTED_CIS, { variables: { changeId }, fetchPolicy: 'cache-and-network' })
  const { data: auditData, refetch: refetchAudit } = useQuery<{ changeAuditTrail: AuditEntry[] }>(GET_CHANGE_AUDIT_TRAIL, { variables: { changeId }, fetchPolicy: 'cache-and-network' })
  const { data: meData } = useQuery<{ me: { id: string; role: string; teams: { id: string }[] } | null }>(GET_ME, { fetchPolicy: 'cache-first' })
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
  const { data: impactData, error: impactError, refetch: refetchImpacted } = useQuery<{ changeImpactedCIs: Array<{ ci: { id: string; name: string; type: string | null; environment: string | null }; distance: number; affectedBy: { id: string; name: string; type: string | null }; impactPath: string[] }> }>(
    GET_CHANGE_IMPACTED_CIS, { variables: { changeId, depth: impactDepth }, fetchPolicy: 'cache-and-network' },
  )
  if (impactError) console.error('[changeImpactedCIs] GraphQL error:', impactError.message)
  const impactedCIs = impactData?.changeImpactedCIs ?? []

  const [expandedCIId, setExpandedCIId] = useState<string | null>(null)
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

  // Counts
  const totalTasks = affected.length * 3
  const completedTasks = affected.reduce((n, a) => n + (a.assessmentOwner?.status === 'completed' ? 1 : 0) + (a.assessmentSupport?.status === 'completed' ? 1 : 0) + (a.deployPlan?.status === 'completed' ? 1 : 0), 0)

  // Approval route live
  const allScores = affected.filter(a => a.riskScore != null).map(a => a.riskScore!)
  const allAssessmentsDone = affected.length > 0 && affected.every(a => a.assessmentOwner?.status === 'completed' && a.assessmentSupport?.status === 'completed')
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

  // Find the first pending task for the current user. Task status is the
  // source of truth; we don't gate by workflow step name — if a task is
  // still pending/in-progress, it's actionable.
  const findPendingTaskId = (a: AffectedCI): string | null => {
    const inTeam = (tid: string | null) => isAdmin || (!!tid && userTeamIds.has(tid))
    const oOk = inTeam(a.ci.ownerGroup?.id ?? null); const sOk = inTeam(a.ci.supportGroup?.id ?? null)
    if (oOk && a.assessmentOwner   && a.assessmentOwner.status   !== 'completed') return a.assessmentOwner.id
    if (sOk && a.assessmentSupport && a.assessmentSupport.status !== 'completed') return a.assessmentSupport.id
    if (sOk && a.deployPlan        && a.deployPlan.status        !== 'completed') return a.deployPlan.id
    if (oOk && a.validation        && a.validation.status        !== 'completed') return a.validation.id
    if (sOk && a.deployment        && a.deployment.status        !== 'completed') return a.deployment.id
    if (oOk && a.review            && a.review.status            !== 'completed') return a.review.id
    return null
  }

  // (CI list rendered manually below)


  return (
    <PageContainer style={{ padding: '16px 24px' }}>
      {/* Header */}
      <button onClick={() => navigate('/changes')} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', marginBottom: 12, padding: 0 }}>← Changes</button>
      <h1 style={{ fontSize: 'var(--font-size-page-title)', fontWeight: 600, color: 'var(--color-slate-dark)', margin: '0 0 12px' }}>{change.code}</h1>
      <PhaseChipBar current={currentStep} steps={wfSteps} />

      {/* Details box */}
      <SectionCard title="Change Information" collapsible defaultOpen>
        {/* Fields vertical */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16 }}>
          <DetailField label="Titolo" value={change.title} />
          {change.description && <DescriptionField value={change.description} />}
          {change.changeOwner && <DetailField label="Change Owner" value={change.changeOwner.name} />}
          {change.requester && <DetailField label="Requestor" value={change.requester.name} />}
          <DetailField label="Creato il" value={fmtDate(change.createdAt)} />
          <DetailField label="Aggiornato il" value={fmtDate(change.updatedAt)} />
        </div>
        {/* Badges + progress + actions */}
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          {change.aggregateRiskScore != null && <RiskBadge score={change.aggregateRiskScore} />}
          {liveRoute.label !== '— da calcolare —' && (
            <span style={{ padding: '3px 10px', borderRadius: 6, fontSize: 'var(--font-size-label)', fontWeight: 600, backgroundColor: liveRoute.bg, color: liveRoute.color }}>{liveRoute.label}</span>
          )}
          {currentStep === wfInitialStep?.name && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 180 }}>
              <div style={{ height: 6, borderRadius: 3, backgroundColor: '#e5e7eb', overflow: 'hidden', flex: 1 }}>
                <div style={{ height: '100%', width: `${totalTasks > 0 ? Math.round(completedTasks / totalTasks * 100) : 0}%`, backgroundColor: 'var(--color-brand)', borderRadius: 3, transition: 'width 200ms' }} />
              </div>
              <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate)', flexShrink: 0 }}>{completedTasks}/{totalTasks} task completati</span>
            </div>
          )}
          {isAdmin && transitions.map((tr) => (
            <button
              key={tr.toStep}
              type="button"
              disabled={transitioning}
              onClick={() => {
                if (tr.requiresInput) {
                  setTransitionNotes('')
                  setTransitionModal({ toStep: tr.toStep, label: tr.label, inputField: tr.inputField })
                } else {
                  void runTransition(tr.toStep, tr.label)
                }
              }}
              style={{
                padding: '6px 14px', borderRadius: 6, border: 'none',
                background: 'var(--color-brand)', color: '#fff', fontWeight: 600,
                cursor: transitioning ? 'wait' : 'pointer', fontSize: 'var(--font-size-label)',
              }}
            >
              {tr.label}
            </button>
          ))}
          {wfIsTerminal(currentStep) && <span style={{ fontSize: 'var(--font-size-label)', color: '#16a34a', fontWeight: 600 }}>✓ Completato</span>}
          {transitions.length === 0 && currentStep && !wfIsTerminal(currentStep) && (
            <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate)' }}>{wfByName.get(currentStep)?.label ?? currentStep} in corso</span>
          )}
        </div>
      </SectionCard>

      {/* Upcoming preview: shown whenever there are deploy plan steps and the
          workflow hasn't yet reached the deployment step (no validation tasks
          have been created yet). */}
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

      {/* Active Tasks */}
      <SectionCard title="Active Tasks" count={affected.length} collapsible defaultOpen>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid #e5e7eb', fontSize: 'var(--font-size-label)', fontWeight: 600, color: 'var(--color-slate-light)', textTransform: 'uppercase' }}>
          <span style={{ width: 24, flexShrink: 0 }} />
          <span style={{ flex: 1 }}>Nome</span>
          <span style={{ width: 80 }}>Tipo</span>
          <span style={{ width: 80 }}>Env</span>
          <span style={{ width: 80 }}>Risk</span>
          <span style={{ width: 130 }}>Status</span>
          <span style={{ width: 90 }} />
        </div>
        {affected.map((a) => {
          const isOpen = expandedCIId === a.ci.id
          const tid = findPendingTaskId(a)
          return (
            <div key={a.ci.id} style={{ borderLeft: isOpen ? '3px solid var(--color-brand)' : '3px solid transparent', marginBottom: 2, transition: 'border-color 0.15s' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0 8px 4px', borderBottom: '1px solid #f3f4f6' }}>
                <span onClick={() => setExpandedCIId(prev => prev === a.ci.id ? null : a.ci.id)} style={{ width: 24, flexShrink: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <ChevronRight size={16} color="var(--color-slate-light)" style={{ transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }} />
                </span>
                <span style={{ flex: 1, fontWeight: 500, color: 'var(--color-slate-dark)', fontSize: 'var(--font-size-body)' }}>{a.ci.name}</span>
                <span style={{ width: 80, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>{a.ci.type ?? ''}</span>
                <span style={{ width: 80, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>{a.ci.environment ?? ''}</span>
                <span style={{ width: 80 }}>{a.riskScore != null && (
                  <span style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: a.riskScore <= 30 ? '#15803d' : a.riskScore <= 60 ? '#b45309' : '#b91c1c' }}>{a.riskScore}</span>
                )}</span>
                <span style={{ width: 130 }}>{(() => {
                  // A CI counts as COMPLETED when every task that exists on it
                  // is completed (and for validation/review, with the right
                  // result). Missing tasks are ignored — the workflow creates
                  // them on entering the corresponding step.
                  const taskDone = (t: { status?: string } | null | undefined) =>
                    !t || t.status === 'completed'
                  const validationDone = !a.validation || (a.validation.status === 'completed' && a.validation.result === 'pass')
                  const reviewDone     = !a.review     || (a.review.status     === 'completed' && a.review.result     === 'confirmed')
                  const done =
                    taskDone(a.assessmentOwner) &&
                    taskDone(a.assessmentSupport) &&
                    taskDone(a.deployPlan) &&
                    validationDone &&
                    taskDone(a.deployment) &&
                    reviewDone
                  return done
                    ? <span style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, color: 'var(--color-success)', textTransform: 'uppercase' }}>COMPLETED</span>
                    : <span style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, color: 'var(--color-trigger-sla-breach)', textTransform: 'uppercase' }}>NOT YET COMPLETED</span>
                })()}</span>
                <span style={{ width: 90 }}>{tid && <Link to={`/tasks/${tid}`} style={{ padding: '3px 8px', borderRadius: 6, fontSize: 'var(--font-size-label)', fontWeight: 600, backgroundColor: 'var(--color-brand)', color: '#fff', textDecoration: 'none' }}>Apri task</Link>}</span>
              </div>
              {isOpen && <div style={{ paddingLeft: 28 }}><CIExpandedRow a={a} /></div>}
            </div>
          )
        })}
      </SectionCard>

      {/* CIs Involved */}
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
                      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = '#ef4444' }}
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
                          <span style={{ width: 60 }}><span style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, padding: '1px 6px', borderRadius: 4, backgroundColor: b.distance === 1 ? '#fef2f2' : b.distance === 2 ? '#fff7ed' : '#f1f5f9', color: b.distance === 1 ? '#ef4444' : b.distance === 2 ? '#b45309' : 'var(--color-slate)' }}>{b.distance} hop</span></span>
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

        {/* Add CI Modal */}
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

        {/* Remove CI Confirm */}
        {confirmRemoveCI && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
            <div style={{ background: '#fff', borderRadius: 12, padding: 24, maxWidth: 420, width: '90%', boxShadow: '0 8px 24px rgba(0,0,0,0.15)' }}>
              <h3 style={{ margin: '0 0 12px', fontSize: 'var(--font-size-card-title)', color: 'var(--color-slate-dark)' }}>Rimuovere CI</h3>
              <p style={{ margin: '0 0 16px', fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>
                Rimuovere <strong>{confirmRemoveCI.name}</strong> dal change? Tutti i task associati verranno eliminati.
              </p>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button type="button" onClick={() => setConfirmRemoveCI(null)} style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer', fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>Annulla</button>
                <button type="button" onClick={() => void removeCI({ variables: { changeId, ciId: confirmRemoveCI.id } })} style={{ padding: '6px 14px', borderRadius: 6, border: 'none', background: '#ef4444', color: '#fff', fontWeight: 600, cursor: 'pointer', fontSize: 'var(--font-size-body)' }}>Rimuovi</button>
              </div>
            </div>
          </div>
        )}
      </SectionCard>

      {/* Transition notes modal */}
      {transitionModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 24, maxWidth: 480, width: '90%', boxShadow: '0 8px 24px rgba(0,0,0,0.15)' }}>
            <h3 style={{ margin: '0 0 12px', fontSize: 'var(--font-size-card-title)', color: 'var(--color-slate-dark)' }}>{transitionModal.label}</h3>
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
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
              <button type="button" onClick={() => setTransitionModal(null)} style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer', fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>Annulla</button>
              <button
                type="button"
                disabled={!transitionNotes.trim()}
                onClick={async () => {
                  const m = transitionModal
                  setTransitionModal(null)
                  await runTransition(m.toStep, m.label, transitionNotes.trim())
                }}
                style={{ padding: '6px 14px', borderRadius: 6, border: 'none', background: 'var(--color-brand)', color: '#fff', fontWeight: 600, cursor: transitionNotes.trim() ? 'pointer' : 'not-allowed', fontSize: 'var(--font-size-body)', opacity: transitionNotes.trim() ? 1 : 0.6 }}
              >
                Conferma
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Audit */}
      <AuditTimeline audit={audit} />
    </PageContainer>
  )
}
