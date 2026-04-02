import { ChevronDown, ChevronRight } from 'lucide-react'
import type { Team, User, ChangeTask } from '../change-types'
import { Badge, TASK_STATUS_COLORS, STATUS_STEP_COLORS, formatDate, cardStyle } from '../change-types'
import type { TaskHandlers } from './types'

interface ValidationTaskListProps {
  changeId: string
  deploySteps: ChangeTask[]
  validationTask: ChangeTask | null
  teams: Team[]
  users: User[]
  canEditValidation: boolean
  transitioning: boolean
  instanceId: string
  validationOpen: boolean
  onSetValidationOpen: (v: boolean) => void
  updatingStep: boolean
  onExecTransition: (instanceId: string, toStep: string, notes: string | null) => void
  // Popup state (controlled from parent)
  validationStepPopup: string | null
  setValidationStepPopup: (id: string | null) => void
  valPopupNotes: string
  setValPopupNotes: (v: string) => void
  valPopupReassignTeamId: string
  setValPopupReassignTeamId: (v: string) => void
  valPopupShowReassign: boolean
  setValPopupShowReassign: (v: boolean) => void
  valPopupUserId: string
  setValPopupUserId: (v: string) => void
  globalValidationPopup: boolean
  setGlobalValidationPopup: (v: boolean) => void
  globalValNotes: string
  setGlobalValNotes: (v: string) => void
  handlers: TaskHandlers
}

export function ValidationTaskList({
  changeId,
  deploySteps,
  validationTask,
  teams,
  users,
  canEditValidation,
  transitioning,
  instanceId,
  validationOpen,
  onSetValidationOpen,
  updatingStep,
  onExecTransition,
  validationStepPopup,
  setValidationStepPopup,
  valPopupNotes,
  setValPopupNotes,
  valPopupReassignTeamId,
  setValPopupReassignTeamId,
  valPopupShowReassign,
  setValPopupShowReassign,
  valPopupUserId,
  setValPopupUserId,
  globalValidationPopup,
  setGlobalValidationPopup,
  globalValNotes,
  setGlobalValNotes,
  handlers,
}: ValidationTaskListProps) {
  const allValItems: { status: string }[] = [
    ...(validationTask ? [validationTask] : []),
    ...deploySteps.filter((s) => s.hasValidation).map((s) => ({ status: s.validationStatus ?? 'pending' })),
  ]
  const totalValCount  = allValItems.length
  const passedValCount = allValItems.filter((v) => v.status === 'passed').length
  const noTasks        = totalValCount === 0

  return (
    <div style={{ ...cardStyle, borderLeft: canEditValidation ? '4px solid var(--color-trigger-automatic)' : '4px solid #e5e7eb', borderRadius: '0 10px 10px 0', background: canEditValidation ? '#fff' : '#fafafa', padding: 0, transition: 'all 0.2s' }}>
      <div onClick={() => onSetValidationOpen(!validationOpen)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', padding: '14px 20px', borderBottom: validationOpen ? '1px solid #e5e7eb' : 'none' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-slate-dark)' }}>Validation Tasks</span>
          {totalValCount > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              {allValItems.map((v, i) => (
                <div key={i} style={{
                  width: 8, height: 8, borderRadius: '50%',
                  background: v.status === 'passed' ? '#16a34a' : v.status === 'failed' ? 'var(--color-trigger-sla-breach)' : '#e5e7eb',
                }} />
              ))}
              <span style={{ fontSize: 12, color: 'var(--color-slate-light)', marginLeft: 2 }}>
                {passedValCount}/{totalValCount} completati
              </span>
            </div>
          )}
        </div>
        {validationOpen ? <ChevronDown size={16} color="var(--color-slate-light)" /> : <ChevronRight size={16} color="var(--color-slate-light)" />}
      </div>

      {validationOpen && noTasks && (
        <div style={{ padding: '16px 20px 20px' }}>
          <div style={{ fontSize: 14, color: 'var(--color-slate-light)', marginBottom: 14, lineHeight: 1.5 }}>
            Nessun task di validazione definito.<br />
            Puoi completare la validazione direttamente.
          </div>
          {canEditValidation && (
            <button
              onClick={() => { if (instanceId) onExecTransition(instanceId, 'completed', null) }}
              disabled={transitioning}
              style={{ padding: '9px 20px', backgroundColor: transitioning ? '#e2e6f0' : 'var(--color-trigger-automatic)', color: transitioning ? 'var(--color-slate-light)' : '#fff', border: 'none', borderRadius: 7, fontSize: 14, fontWeight: 600, cursor: transitioning ? 'not-allowed' : 'pointer' }}
            >
              {transitioning ? 'Esecuzione…' : 'Valida e prosegui'}
            </button>
          )}
        </div>
      )}

      {validationOpen && !noTasks && (
        <div style={{ padding: '0 0 4px' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
              <thead>
                <tr style={{ borderBottom: '2px solid #e2e6f0' }}>
                  {['Tipo', 'Team', 'Assegnato a', 'Inizio', 'Fine', 'Status'].map((h) => (
                    <th key={h} style={{ textAlign: 'left', padding: '8px 12px', fontSize: 12, fontWeight: 600, color: 'var(--color-slate-light)', textTransform: 'uppercase' as const, letterSpacing: '0.05em' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {validationTask && (
                  <tr
                    onClick={() => { setGlobalValidationPopup(true); setGlobalValNotes('') }}
                    style={{ borderBottom: '1px solid #e2e6f0', cursor: 'pointer' }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLTableRowElement).style.backgroundColor = '#f8f9fc' }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLTableRowElement).style.backgroundColor = 'transparent' }}
                  >
                    <td style={{ padding: '10px 12px' }}>
                      <span style={{ fontSize: 12, fontWeight: 600, padding: '2px 8px', borderRadius: 100, backgroundColor: 'var(--color-slate-bg)', color: 'var(--color-slate)' }}>Globale</span>
                    </td>
                    <td style={{ padding: '10px 12px' }}>
                      {validationTask.assignedTeam?.name ?? <span style={{ color: 'var(--color-trigger-sla-breach)', fontSize: 12 }}>Non assegnato</span>}
                    </td>
                    <td style={{ padding: '10px 12px' }}>
                      {validationTask.assignee ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <div style={{ width: 20, height: 20, borderRadius: '50%', backgroundColor: 'var(--color-brand)', color: '#fff', fontSize: 9, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            {validationTask.assignee.name.charAt(0).toUpperCase()}
                          </div>
                          <span style={{ fontSize: 12 }}>{validationTask.assignee.name}</span>
                        </div>
                      ) : <span style={{ color: 'var(--color-slate-light)', fontSize: 12 }}>—</span>}
                    </td>
                    <td style={{ padding: '10px 12px', fontSize: 12, color: 'var(--color-slate-light)' }}>{formatDate(validationTask.scheduledStart ?? '')}</td>
                    <td style={{ padding: '10px 12px', fontSize: 12, color: 'var(--color-slate-light)' }}>{formatDate(validationTask.scheduledEnd ?? '')}</td>
                    <td style={{ padding: '10px 12px' }}>
                      <Badge value={validationTask.status} map={{ ...TASK_STATUS_COLORS, passed: { bg: 'var(--color-brand-light)', color: 'var(--color-brand)' }, failed: { bg: 'var(--color-brand-light)', color: 'var(--color-brand)' } }} />
                    </td>
                  </tr>
                )}
                {deploySteps.filter((s) => s.hasValidation).map((step) => (
                  <tr
                    key={step.id}
                    onClick={() => { setValidationStepPopup(step.id); setValPopupNotes(''); setValPopupShowReassign(false); setValPopupReassignTeamId(''); setValPopupUserId('') }}
                    style={{ borderBottom: '1px solid #e2e6f0', cursor: 'pointer' }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLTableRowElement).style.backgroundColor = '#f8f9fc' }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLTableRowElement).style.backgroundColor = 'transparent' }}
                  >
                    <td style={{ padding: '10px 12px', fontWeight: 500, color: 'var(--color-slate-dark)' }}>Step {step.order}: {step.title}</td>
                    <td style={{ padding: '10px 12px' }}>
                      {step.validationTeam?.name ?? <span style={{ color: 'var(--color-trigger-sla-breach)', fontSize: 12 }}>Non assegnato</span>}
                    </td>
                    <td style={{ padding: '10px 12px' }}>
                      {step.validationUser ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <div style={{ width: 20, height: 20, borderRadius: '50%', backgroundColor: 'var(--color-brand)', color: '#fff', fontSize: 9, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            {step.validationUser.name.charAt(0).toUpperCase()}
                          </div>
                          <span style={{ fontSize: 12 }}>{step.validationUser.name}</span>
                        </div>
                      ) : <span style={{ color: 'var(--color-slate-light)', fontSize: 12 }}>—</span>}
                    </td>
                    <td style={{ padding: '10px 12px', fontSize: 12, color: 'var(--color-slate-light)' }}>{formatDate(step.validationStart ?? '')}</td>
                    <td style={{ padding: '10px 12px', fontSize: 12, color: 'var(--color-slate-light)' }}>{formatDate(step.validationEnd ?? '')}</td>
                    <td style={{ padding: '10px 12px' }}>
                      <Badge value={step.validationStatus ?? 'pending'} map={{ ...STATUS_STEP_COLORS, passed: { bg: 'var(--color-brand-light)', color: 'var(--color-brand)' }, failed: { bg: 'var(--color-brand-light)', color: 'var(--color-brand)' } }} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Validation Step Popup Drawer */}
      {validationStepPopup && (() => {
        const step = deploySteps.find((s) => s.id === validationStepPopup)
        if (!step) return null
        const valDone = step.validationStatus === 'passed' || step.validationStatus === 'failed'
        const canAct = canEditValidation && !valDone
        const valTeamUsers = users.filter((u) => u.teams?.some((t: { id: string }) => t.id === step.validationTeam?.id))

        return (
          <>
            <div onClick={() => setValidationStepPopup(null)} style={{ position: 'fixed', inset: 0, zIndex: 1000, backgroundColor: 'rgba(0,0,0,0.35)' }} />
            <div style={{ position: 'fixed', right: 0, top: 0, bottom: 0, width: 520, backgroundColor: '#fff', zIndex: 1001, boxShadow: '-4px 0 24px rgba(0,0,0,0.12)', display: 'flex', flexDirection: 'column' }}>
              <div style={{ padding: '20px 24px', borderBottom: '1px solid #e2e6f0', flexShrink: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Validazione Step</div>
                    <h2 style={{ fontSize: 18, fontWeight: 600, color: 'var(--color-slate-dark)', margin: '0 0 6px' }}>Step {step.order}: {step.title}</h2>
                    <Badge value={step.validationStatus ?? 'pending'} map={{ ...STATUS_STEP_COLORS, passed: { bg: 'var(--color-brand-light)', color: 'var(--color-brand)' }, failed: { bg: 'var(--color-brand-light)', color: 'var(--color-brand)' } }} />
                  </div>
                  <button onClick={() => setValidationStepPopup(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 24, color: 'var(--color-slate-light)', lineHeight: 1, padding: 4 }}>×</button>
                </div>
              </div>
              <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
                {!canEditValidation && (
                  <div style={{ marginBottom: 16, padding: '8px 12px', borderRadius: 6, backgroundColor: '#f8fafc', border: '1px solid #e2e6f0', fontSize: 12, color: 'var(--color-slate-light)' }}>
                    Sola lettura — questa fase non è ancora attiva
                  </div>
                )}
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>ID</div>
                  <div style={{ fontSize: 12, fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", color: 'var(--color-slate-light)' }}>{step.id}</div>
                </div>
                {step.validationStart && step.validationEnd && (
                  <div style={{ marginBottom: 20 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>Finestra di Validazione</div>
                    <div style={{ display: 'flex', gap: 24, fontSize: 14 }}>
                      <div>
                        <div style={{ fontSize: 12, color: 'var(--color-slate-light)', marginBottom: 2 }}>Inizio</div>
                        <div style={{ fontWeight: 500 }}>{formatDate(step.validationStart)}</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 12, color: 'var(--color-slate-light)', marginBottom: 2 }}>Fine</div>
                        <div style={{ fontWeight: 500 }}>{formatDate(step.validationEnd)}</div>
                      </div>
                    </div>
                  </div>
                )}
                <div style={{ borderTop: '1px solid #e2e6f0', paddingTop: 16, marginBottom: 16 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>Assegnazione</div>
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', marginBottom: 6 }}>Team Validazione</div>
                    {valPopupShowReassign ? (
                      <div style={{ display: 'flex', gap: 8 }}>
                        <select
                          value={valPopupReassignTeamId}
                          onChange={(e) => setValPopupReassignTeamId(e.target.value)}
                          style={{ flex: 1, padding: '8px 10px', borderRadius: 6, border: '1px solid #e2e6f0', fontSize: 14, outline: 'none' }}
                        >
                          <option value="">Seleziona team…</option>
                          {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                        </select>
                        <button
                          disabled={!valPopupReassignTeamId}
                          onClick={() => {
                            if (valPopupReassignTeamId) {
                              handlers.onAssignValidationTeam(step.id, valPopupReassignTeamId)
                              setValPopupShowReassign(false)
                              setValPopupReassignTeamId('')
                              setValPopupUserId('')
                            }
                          }}
                          style={{ padding: '8px 14px', borderRadius: 6, border: 'none', fontSize: 12, fontWeight: 600, cursor: valPopupReassignTeamId ? 'pointer' : 'not-allowed', backgroundColor: valPopupReassignTeamId ? 'var(--color-brand)' : '#e2e6f0', color: valPopupReassignTeamId ? '#fff' : 'var(--color-slate-light)' }}
                        >
                          Salva
                        </button>
                        <button onClick={() => setValPopupShowReassign(false)} style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #e2e6f0', background: 'transparent', cursor: 'pointer', fontSize: 12 }}>✕</button>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {step.validationTeam ? (
                          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-slate-dark)' }}>{step.validationTeam.name}</span>
                        ) : (
                          <span style={{ fontSize: 14, color: 'var(--color-trigger-sla-breach)' }}>Non assegnato</span>
                        )}
                        {!valDone && <button onClick={() => setValPopupShowReassign(true)} style={{ fontSize: 12, padding: '2px 8px', borderRadius: 4, border: '1px solid #e2e6f0', background: 'transparent', cursor: 'pointer', color: 'var(--color-slate-light)' }}>Riassegna</button>}
                      </div>
                    )}
                  </div>
                  <div style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', marginBottom: 6 }}>Responsabile Validazione</div>
                    {step.validationTeam ? (
                      step.validationUser ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <div style={{ width: 24, height: 24, borderRadius: '50%', backgroundColor: 'var(--color-brand)', color: '#fff', fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                            {step.validationUser.name.charAt(0).toUpperCase()}
                          </div>
                          <span style={{ fontSize: 14, color: 'var(--color-slate-dark)' }}>{step.validationUser.name}</span>
                          {!valDone && <button onClick={() => setValPopupUserId('')} style={{ fontSize: 12, padding: '2px 8px', borderRadius: 4, border: '1px solid #e2e6f0', background: 'transparent', cursor: 'pointer', color: 'var(--color-slate-light)' }}>Cambia</button>}
                        </div>
                      ) : (
                        <select
                          value={valPopupUserId}
                          onChange={(e) => {
                            const userId = e.target.value
                            setValPopupUserId(userId)
                            if (userId) handlers.onAssignValidationUser(step.id, userId)
                          }}
                          style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #e2e6f0', fontSize: 14, outline: 'none' }}
                        >
                          <option value="">Assegna responsabile...</option>
                          {valTeamUsers.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                        </select>
                      )
                    ) : (
                      <span style={{ fontSize: 14, color: 'var(--color-slate-light)' }}>— (assegna prima un team)</span>
                    )}
                  </div>
                </div>
                {canAct && (
                  <div style={{ borderTop: '1px solid #e2e6f0', paddingTop: 16 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>Azioni</div>
                    {!step.validationTeam && (
                      <div style={{ fontSize: 12, color: 'var(--color-trigger-sla-breach)', padding: '8px 12px', borderRadius: 6, backgroundColor: 'rgba(220,38,38,0.06)', marginBottom: 12 }}>⚠ Assegna un team di validazione per procedere</div>
                    )}
                    <div style={{ marginBottom: 10 }}>
                      <label style={{ fontSize: 12, color: 'var(--color-slate-light)', fontWeight: 700, textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>Note (obbligatorie per fallimento)</label>
                      <textarea
                        value={valPopupNotes}
                        onChange={(e) => setValPopupNotes(e.target.value)}
                        rows={3}
                        placeholder="Note della validazione..."
                        style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '1px solid #e2e6f0', borderRadius: 6, fontSize: 14, fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", resize: 'vertical', outline: 'none' }}
                      />
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        disabled={!step.validationTeam || updatingStep}
                        onClick={() => { handlers.onUpdateStepValidation(step.id, 'passed', valPopupNotes || null); setValidationStepPopup(null) }}
                        style={{ flex: 1, padding: '9px 0', borderRadius: 7, border: 'none', fontSize: 14, fontWeight: 600, cursor: step.validationTeam && !updatingStep ? 'pointer' : 'not-allowed', backgroundColor: step.validationTeam && !updatingStep ? 'var(--color-trigger-automatic)' : '#e2e6f0', color: step.validationTeam && !updatingStep ? '#fff' : 'var(--color-slate-light)' }}
                      >
                        ✓ Passa
                      </button>
                      <button
                        disabled={!step.validationTeam || !valPopupNotes.trim() || updatingStep}
                        onClick={() => { handlers.onUpdateStepValidation(step.id, 'failed', valPopupNotes.trim()); setValidationStepPopup(null) }}
                        style={{ flex: 1, padding: '9px 0', borderRadius: 7, border: 'none', fontSize: 14, fontWeight: 600, cursor: step.validationTeam && valPopupNotes.trim() && !updatingStep ? 'pointer' : 'not-allowed', backgroundColor: step.validationTeam && valPopupNotes.trim() && !updatingStep ? 'var(--color-trigger-sla-breach)' : '#e2e6f0', color: step.validationTeam && valPopupNotes.trim() && !updatingStep ? '#fff' : 'var(--color-slate-light)' }}
                      >
                        ✗ Fallisce
                      </button>
                    </div>
                  </div>
                )}
                {valDone && (
                  <div style={{ borderTop: '1px solid #e2e6f0', paddingTop: 16 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>Risultato</div>
                    {step.validationNotes && <div style={{ fontSize: 14, color: 'var(--color-slate-dark)', marginBottom: 8, lineHeight: 1.5 }}>{step.validationNotes}</div>}
                    {step.completedAt && <div style={{ fontSize: 12, color: 'var(--color-slate-light)' }}>Completato il: {new Date(step.completedAt).toLocaleString('it-IT')}</div>}
                  </div>
                )}
              </div>
            </div>
          </>
        )
      })()}

      {/* Global Validation Popup Drawer */}
      {globalValidationPopup && validationTask && (() => {
        const val = validationTask
        const valDone = val.status === 'passed' || val.status === 'failed'
        const canAct  = canEditValidation && !valDone
        return (
          <>
            <div onClick={() => setGlobalValidationPopup(false)} style={{ position: 'fixed', inset: 0, zIndex: 1000, backgroundColor: 'rgba(0,0,0,0.35)' }} />
            <div style={{ position: 'fixed', right: 0, top: 0, bottom: 0, width: 520, backgroundColor: '#fff', zIndex: 1001, boxShadow: '-4px 0 24px rgba(0,0,0,0.12)', display: 'flex', flexDirection: 'column' }}>
              <div style={{ padding: '20px 24px', borderBottom: '1px solid #e2e6f0', flexShrink: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Validazione</div>
                    <h2 style={{ fontSize: 18, fontWeight: 600, color: 'var(--color-slate-dark)', margin: '0 0 6px' }}>Validazione Globale</h2>
                    <Badge value={val.status} map={{ ...TASK_STATUS_COLORS, passed: { bg: 'var(--color-brand-light)', color: 'var(--color-brand)' }, failed: { bg: 'var(--color-brand-light)', color: 'var(--color-brand)' } }} />
                  </div>
                  <button onClick={() => setGlobalValidationPopup(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 24, color: 'var(--color-slate-light)', lineHeight: 1, padding: 4 }}>×</button>
                </div>
              </div>
              <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
                {!canEditValidation && (
                  <div style={{ marginBottom: 16, padding: '8px 12px', borderRadius: 6, backgroundColor: '#f8fafc', border: '1px solid #e2e6f0', fontSize: 12, color: 'var(--color-slate-light)' }}>
                    Sola lettura — questa fase non è ancora attiva
                  </div>
                )}
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>ID</div>
                  <div style={{ fontSize: 12, fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", color: 'var(--color-slate-light)' }}>{val.id}</div>
                </div>
                {val.scheduledStart && val.scheduledEnd && (
                  <div style={{ marginBottom: 20 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>Finestra di Validazione</div>
                    <div style={{ display: 'flex', gap: 24, fontSize: 14 }}>
                      <div>
                        <div style={{ fontSize: 12, color: 'var(--color-slate-light)', marginBottom: 2 }}>Inizio</div>
                        <div style={{ fontWeight: 500 }}>{formatDate(val.scheduledStart)}</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 12, color: 'var(--color-slate-light)', marginBottom: 2 }}>Fine</div>
                        <div style={{ fontWeight: 500 }}>{formatDate(val.scheduledEnd)}</div>
                      </div>
                    </div>
                  </div>
                )}
                <div style={{ borderTop: '1px solid #e2e6f0', paddingTop: 16, marginBottom: 16 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>Assegnazione</div>
                  <div style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', marginBottom: 4 }}>Team</div>
                    {val.assignedTeam ? (
                      <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-slate-dark)' }}>{val.assignedTeam.name}</span>
                    ) : (
                      <span style={{ fontSize: 14, color: 'var(--color-trigger-sla-breach)' }}>Non assegnato</span>
                    )}
                  </div>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', marginBottom: 4 }}>Responsabile</div>
                    {val.assignee ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ width: 24, height: 24, borderRadius: '50%', backgroundColor: 'var(--color-brand)', color: '#fff', fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                          {val.assignee.name.charAt(0).toUpperCase()}
                        </div>
                        <span style={{ fontSize: 14, color: 'var(--color-slate-dark)' }}>{val.assignee.name}</span>
                      </div>
                    ) : (
                      <span style={{ fontSize: 14, color: 'var(--color-slate-light)' }}>—</span>
                    )}
                  </div>
                </div>
                {canAct && (
                  <div style={{ borderTop: '1px solid #e2e6f0', paddingTop: 16 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>Azioni</div>
                    <div style={{ marginBottom: 10 }}>
                      <label style={{ fontSize: 12, color: 'var(--color-slate-light)', fontWeight: 700, textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>Note (obbligatorie per fallimento)</label>
                      <textarea
                        value={globalValNotes}
                        onChange={(e) => setGlobalValNotes(e.target.value)}
                        rows={3}
                        placeholder="Note della validazione..."
                        style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '1px solid #e2e6f0', borderRadius: 6, fontSize: 14, fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", resize: 'vertical', outline: 'none' }}
                      />
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        onClick={() => { handlers.onCompleteValidation(changeId, globalValNotes || null); setGlobalValidationPopup(false) }}
                        style={{ flex: 1, padding: '9px 0', borderRadius: 7, border: 'none', fontSize: 14, fontWeight: 600, cursor: 'pointer', backgroundColor: 'var(--color-trigger-automatic)', color: '#fff' }}
                      >
                        ✓ Passa
                      </button>
                      <button
                        disabled={!globalValNotes.trim()}
                        onClick={() => { handlers.onFailValidation(changeId); setGlobalValidationPopup(false) }}
                        style={{ flex: 1, padding: '9px 0', borderRadius: 7, border: 'none', fontSize: 14, fontWeight: 600, cursor: globalValNotes.trim() ? 'pointer' : 'not-allowed', backgroundColor: globalValNotes.trim() ? 'var(--color-trigger-sla-breach)' : '#e2e6f0', color: globalValNotes.trim() ? '#fff' : 'var(--color-slate-light)' }}
                      >
                        ✗ Fallisce
                      </button>
                    </div>
                  </div>
                )}
                {valDone && (
                  <div style={{ borderTop: '1px solid #e2e6f0', paddingTop: 16 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>Risultato</div>
                    {val.notes && <div style={{ fontSize: 14, color: 'var(--color-slate-dark)', marginBottom: 8, lineHeight: 1.5 }}>{val.notes}</div>}
                    {val.completedAt && <div style={{ fontSize: 12, color: 'var(--color-slate-light)' }}>Completato il: {new Date(val.completedAt).toLocaleString('it-IT')}</div>}
                  </div>
                )}
              </div>
            </div>
          </>
        )
      })()}
    </div>
  )
}
