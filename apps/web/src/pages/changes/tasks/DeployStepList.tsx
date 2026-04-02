import { ChevronDown, ChevronRight } from 'lucide-react'
import { CollapsibleGroup } from '@/components/ui/CollapsibleGroup'
import { DetailField } from '@/components/ui/DetailField'
import type { Team, User, ChangeTask } from '../change-types'
import { Badge, STATUS_STEP_COLORS, formatDate, groupByField, cardStyle } from '../change-types'
import type { TaskHandlers } from './types'

interface DeployStepListProps {
  deploySteps: ChangeTask[]
  teams: Team[]
  users: User[]
  canEditDeploy: boolean
  deployOpen: boolean
  onSetDeployOpen: (v: boolean) => void
  updatingStep: boolean
  // Popup state (controlled from parent)
  deployStepPopup: string | null
  setDeployStepPopup: (id: string | null) => void
  deployPopupNotes: string
  setDeployPopupNotes: (v: string) => void
  deployPopupShowSkip: boolean
  setDeployPopupShowSkip: (v: boolean) => void
  deployPopupSkipReason: string
  setDeployPopupSkipReason: (v: string) => void
  deployPopupShowFail: boolean
  setDeployPopupShowFail: (v: boolean) => void
  deployPopupFailReason: string
  setDeployPopupFailReason: (v: string) => void
  deployPopupReassignTeamId: string
  setDeployPopupReassignTeamId: (v: string) => void
  deployPopupShowReassign: boolean
  setDeployPopupShowReassign: (v: boolean) => void
  deployPopupUserId: string
  setDeployPopupUserId: (v: string) => void
  handlers: TaskHandlers
}

export function DeployStepList({
  deploySteps,
  teams,
  users,
  canEditDeploy,
  deployOpen,
  onSetDeployOpen,
  updatingStep,
  deployStepPopup,
  setDeployStepPopup,
  deployPopupNotes,
  setDeployPopupNotes,
  deployPopupShowSkip,
  setDeployPopupShowSkip,
  deployPopupSkipReason,
  setDeployPopupSkipReason,
  deployPopupShowFail,
  setDeployPopupShowFail,
  deployPopupFailReason,
  setDeployPopupFailReason,
  deployPopupReassignTeamId,
  setDeployPopupReassignTeamId,
  deployPopupShowReassign,
  setDeployPopupShowReassign,
  deployPopupUserId,
  setDeployPopupUserId,
  handlers,
}: DeployStepListProps) {
  const totalDeployCount     = deploySteps.length
  const completedDeployCount = deploySteps.filter((s) => s.status === 'completed').length

  return (
    <div style={{ ...cardStyle, borderLeft: canEditDeploy ? '4px solid #0891b2' : '4px solid #e5e7eb', borderRadius: '0 10px 10px 0', background: canEditDeploy ? '#fff' : '#fafafa', padding: 0, transition: 'all 0.2s' }}>
      <div onClick={() => onSetDeployOpen(!deployOpen)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', padding: '14px 20px', borderBottom: deployOpen ? '1px solid #e5e7eb' : 'none' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-slate-dark)' }}>Deploy Tasks</span>
          {totalDeployCount > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              {deploySteps.map((s) => (
                <div key={s.id} style={{
                  width: 8, height: 8, borderRadius: '50%',
                  background: s.status === 'completed' ? '#16a34a' : s.status === 'failed' ? 'var(--color-trigger-sla-breach)' : s.status === 'skipped' ? 'var(--color-slate-light)' : '#e5e7eb',
                }} />
              ))}
              <span style={{ fontSize: 12, color: 'var(--color-slate-light)', marginLeft: 2 }}>
                {completedDeployCount}/{totalDeployCount} completati
              </span>
            </div>
          )}
        </div>
        {deployOpen ? <ChevronDown size={16} color="var(--color-slate-light)" /> : <ChevronRight size={16} color="var(--color-slate-light)" />}
      </div>
      {deployOpen && (
        <div style={{ padding: '8px 20px 12px' }}>
          {deploySteps.length === 0 ? (
            <div style={{ fontSize: 14, color: 'var(--color-slate-light)' }}>Nessuno step pianificato.</div>
          ) : (
            Object.entries(groupByField(deploySteps, (s) => s.assignedTeam?.name ?? 'Non assegnato')).map(([status, steps]) => (
              <CollapsibleGroup key={status} title={status.replace(/_/g, ' ')} count={steps.length}>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                    <thead>
                      <tr style={{ borderBottom: '2px solid #e2e6f0' }}>
                        {['Titolo', 'Team', 'Assegnato a', 'Inizio', 'Fine'].map((h) => (
                          <th key={h} style={{ textAlign: 'left', padding: '6px 12px', fontSize: 12, fontWeight: 600, color: 'var(--color-slate-light)', textTransform: 'uppercase' as const, letterSpacing: '0.05em' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {steps.map((step) => (
                        <tr
                          key={step.id}
                          onClick={() => { setDeployStepPopup(step.id); setDeployPopupNotes(''); setDeployPopupShowSkip(false); setDeployPopupSkipReason(''); setDeployPopupShowFail(false); setDeployPopupFailReason(''); setDeployPopupShowReassign(false); setDeployPopupReassignTeamId(''); setDeployPopupUserId('') }}
                          style={{ borderBottom: '1px solid #e2e6f0', cursor: 'pointer' }}
                          onMouseEnter={(e) => { (e.currentTarget as HTMLTableRowElement).style.backgroundColor = '#f8f9fc' }}
                          onMouseLeave={(e) => { (e.currentTarget as HTMLTableRowElement).style.backgroundColor = 'transparent' }}
                        >
                          <td style={{ padding: '8px 12px', fontWeight: 500, color: 'var(--color-slate-dark)' }}>{step.title}</td>
                          <td style={{ padding: '8px 12px' }}>
                            {step.assignedTeam?.name ?? <span style={{ color: 'var(--color-trigger-sla-breach)', fontSize: 12 }}>Non assegnato</span>}
                          </td>
                          <td style={{ padding: '8px 12px' }}>
                            {step.assignee ? (
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <div style={{ width: 20, height: 20, borderRadius: '50%', backgroundColor: 'var(--color-brand)', color: '#fff', fontSize: 9, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                  {step.assignee.name.charAt(0).toUpperCase()}
                                </div>
                                <span style={{ fontSize: 12 }}>{step.assignee.name}</span>
                              </div>
                            ) : <span style={{ color: 'var(--color-slate-light)', fontSize: 12 }}>—</span>}
                          </td>
                          <td style={{ padding: '8px 12px', fontSize: 12, color: 'var(--color-slate-light)' }}>{formatDate(step.scheduledStart ?? '')}</td>
                          <td style={{ padding: '8px 12px', fontSize: 12, color: 'var(--color-slate-light)' }}>{formatDate(step.scheduledEnd ?? '')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CollapsibleGroup>
            ))
          )}
        </div>
      )}

      {/* Deploy Step Popup Drawer */}
      {deployStepPopup && (() => {
        const step = deploySteps.find((s) => s.id === deployStepPopup)
        if (!step) return null
        const stepDone = ['completed', 'skipped', 'failed'].includes(step.status)
        const canAct = canEditDeploy && !stepDone
        const stepTeamUsers = users.filter((u) => u.teams?.some((t: { id: string }) => t.id === step.assignedTeam?.id))

        return (
          <>
            <div onClick={() => setDeployStepPopup(null)} style={{ position: 'fixed', inset: 0, zIndex: 1000, backgroundColor: 'rgba(0,0,0,0.35)' }} />
            <div style={{ position: 'fixed', right: 0, top: 0, bottom: 0, width: 520, backgroundColor: '#fff', zIndex: 1001, boxShadow: '-4px 0 24px rgba(0,0,0,0.12)', display: 'flex', flexDirection: 'column' }}>
              <div style={{ padding: '20px 24px', borderBottom: '1px solid #e2e6f0', flexShrink: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Deploy Step</div>
                    <h2 style={{ fontSize: 18, fontWeight: 600, color: 'var(--color-slate-dark)', margin: '0 0 6px' }}>
                      <span style={{ fontSize: 12, fontWeight: 700, backgroundColor: '#f3f4f6', padding: '2px 6px', borderRadius: 4, marginRight: 8 }}>#{step.order}</span>
                      {step.title}
                    </h2>
                    <Badge value={step.status} map={STATUS_STEP_COLORS} />
                  </div>
                  <button onClick={() => setDeployStepPopup(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 24, color: 'var(--color-slate-light)', lineHeight: 1, padding: 4 }}>×</button>
                </div>
              </div>
              <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
                {!canEditDeploy && (
                  <div style={{ marginBottom: 16, padding: '8px 12px', borderRadius: 6, backgroundColor: '#f8fafc', border: '1px solid #e2e6f0', fontSize: 12, color: 'var(--color-slate-light)' }}>
                    Sola lettura — questa fase non è ancora attiva
                  </div>
                )}
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>ID</div>
                  <div style={{ fontSize: 12, fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", color: 'var(--color-slate-light)' }}>{step.id}</div>
                </div>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>Dettagli</div>
                <div style={{ display: 'flex', gap: 24, marginBottom: 20, fontSize: 14 }}>
                  <div>
                    <div style={{ fontSize: 12, color: 'var(--color-slate-light)', marginBottom: 2 }}>Inizio</div>
                    <div style={{ fontWeight: 500 }}>{formatDate(step.scheduledStart ?? '')}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: 'var(--color-slate-light)', marginBottom: 2 }}>Fine</div>
                    <div style={{ fontWeight: 500 }}>{formatDate(step.scheduledEnd ?? '')}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: 'var(--color-slate-light)', marginBottom: 2 }}>Durata</div>
                    <div style={{ fontWeight: 500 }}>{step.durationDays} {step.durationDays === 1 ? 'giorno' : 'giorni'}</div>
                  </div>
                </div>
                <div style={{ borderTop: '1px solid #e2e6f0', paddingTop: 16, marginBottom: 4 }}>
                  <DetailField
                    label="Rollback Plan"
                    value={step.rollbackPlan}
                    editable={true}
                    onSave={(value) => { void handlers.onUpdateChangeTask(step.id, { rollbackPlan: value }) }}
                  />
                </div>
                <div style={{ borderTop: '1px solid #e2e6f0', paddingTop: 16, marginBottom: 16 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>Assegnazione</div>
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', marginBottom: 6 }}>Team</div>
                    {deployPopupShowReassign ? (
                      <div style={{ display: 'flex', gap: 8 }}>
                        <select
                          value={deployPopupReassignTeamId}
                          onChange={(e) => setDeployPopupReassignTeamId(e.target.value)}
                          style={{ flex: 1, padding: '8px 10px', borderRadius: 6, border: '1px solid #e2e6f0', fontSize: 14, outline: 'none' }}
                        >
                          <option value="">Seleziona team…</option>
                          {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                        </select>
                        <button
                          disabled={!deployPopupReassignTeamId}
                          onClick={() => {
                            if (deployPopupReassignTeamId) {
                              handlers.onAssignStepTeam(step.id, deployPopupReassignTeamId)
                              setDeployPopupShowReassign(false)
                              setDeployPopupReassignTeamId('')
                              setDeployPopupUserId('')
                            }
                          }}
                          style={{ padding: '8px 14px', borderRadius: 6, border: 'none', fontSize: 12, fontWeight: 600, cursor: deployPopupReassignTeamId ? 'pointer' : 'not-allowed', backgroundColor: deployPopupReassignTeamId ? 'var(--color-brand)' : '#e2e6f0', color: deployPopupReassignTeamId ? '#fff' : 'var(--color-slate-light)' }}
                        >
                          Salva
                        </button>
                        <button onClick={() => setDeployPopupShowReassign(false)} style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #e2e6f0', background: 'transparent', cursor: 'pointer', fontSize: 12 }}>✕</button>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {step.assignedTeam ? (
                          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-slate-dark)' }}>{step.assignedTeam.name}</span>
                        ) : (
                          <span style={{ fontSize: 14, color: 'var(--color-trigger-sla-breach)' }}>Non assegnato</span>
                        )}
                        <button onClick={() => setDeployPopupShowReassign(true)} style={{ fontSize: 12, padding: '2px 8px', borderRadius: 4, border: '1px solid #e2e6f0', background: 'transparent', cursor: 'pointer', color: 'var(--color-slate-light)' }}>Riassegna</button>
                      </div>
                    )}
                  </div>
                  <div style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', marginBottom: 6 }}>Assegnato a</div>
                    {step.assignedTeam ? (
                      step.assignee ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <div style={{ width: 24, height: 24, borderRadius: '50%', backgroundColor: 'var(--color-brand)', color: '#fff', fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                            {step.assignee.name.charAt(0).toUpperCase()}
                          </div>
                          <span style={{ fontSize: 14, color: 'var(--color-slate-dark)' }}>{step.assignee.name}</span>
                          <button onClick={() => setDeployPopupUserId('')} style={{ fontSize: 12, padding: '2px 8px', borderRadius: 4, border: '1px solid #e2e6f0', background: 'transparent', cursor: 'pointer', color: 'var(--color-slate-light)' }}>Cambia</button>
                        </div>
                      ) : (
                        <select
                          value={deployPopupUserId}
                          onChange={(e) => {
                            const userId = e.target.value
                            setDeployPopupUserId(userId)
                            if (userId) handlers.onAssignStepUser(step.id, userId)
                          }}
                          style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #e2e6f0', fontSize: 14, outline: 'none' }}
                        >
                          <option value="">Assegna utente...</option>
                          {stepTeamUsers.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
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
                    {!step.assignedTeam && (
                      <div style={{ fontSize: 12, color: 'var(--color-trigger-sla-breach)', padding: '8px 12px', borderRadius: 6, backgroundColor: 'rgba(220,38,38,0.06)', marginBottom: 12 }}>⚠ Assegna un team allo step per procedere</div>
                    )}
                    {(step.status === 'pending' || step.status === 'in_progress') && (
                      <>
                        <div style={{ marginBottom: 10 }}>
                          <label style={{ fontSize: 12, color: 'var(--color-slate-light)', fontWeight: 700, textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>Note (obbligatorie per completare)</label>
                          <textarea
                            value={deployPopupNotes}
                            onChange={(e) => setDeployPopupNotes(e.target.value)}
                            rows={3}
                            placeholder="Descrivi il risultato del deployment..."
                            style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '1px solid #e2e6f0', borderRadius: 6, fontSize: 14, fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", resize: 'vertical', outline: 'none' }}
                          />
                        </div>
                        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                          <button
                            disabled={!deployPopupNotes.trim() || !step.assignedTeam || updatingStep}
                            onClick={() => { handlers.onUpdateStepStatus(step.id, 'completed', deployPopupNotes.trim()); setDeployStepPopup(null) }}
                            style={{ flex: 1, padding: '9px 0', borderRadius: 7, border: 'none', fontSize: 14, fontWeight: 600, cursor: deployPopupNotes.trim() && step.assignedTeam && !updatingStep ? 'pointer' : 'not-allowed', backgroundColor: deployPopupNotes.trim() && step.assignedTeam && !updatingStep ? 'var(--color-trigger-automatic)' : '#e2e6f0', color: deployPopupNotes.trim() && step.assignedTeam && !updatingStep ? '#fff' : 'var(--color-slate-light)' }}
                          >
                            ✓ Completa
                          </button>
                          <button onClick={() => { setDeployPopupShowFail(true); setDeployPopupShowSkip(false) }}
                            style={{ padding: '9px 14px', borderRadius: 7, border: 'none', fontSize: 14, fontWeight: 600, cursor: 'pointer', backgroundColor: '#fef2f2', color: 'var(--color-trigger-sla-breach)' }}>
                            Fallito
                          </button>
                          <button onClick={() => { setDeployPopupShowSkip(true); setDeployPopupShowFail(false) }}
                            style={{ padding: '9px 14px', borderRadius: 7, border: 'none', fontSize: 14, fontWeight: 600, cursor: 'pointer', backgroundColor: '#f3f4f6', color: 'var(--color-slate)' }}>
                            Salta
                          </button>
                        </div>
                        {deployPopupShowSkip && (
                          <div style={{ padding: 14, borderRadius: 8, border: '1px solid #e2e6f0', backgroundColor: '#fafafa', marginBottom: 10 }}>
                            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-slate)', marginBottom: 8 }}>Motivo del salto (min. 10 caratteri)</div>
                            <textarea
                              value={deployPopupSkipReason}
                              onChange={(e) => setDeployPopupSkipReason(e.target.value)}
                              rows={3}
                              autoFocus
                              placeholder="Es: Step non necessario per questo ambiente..."
                              style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '1px solid #e2e6f0', borderRadius: 6, fontSize: 14, fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", resize: 'none', outline: 'none', marginBottom: 8 }}
                            />
                            <div style={{ display: 'flex', gap: 8 }}>
                              <button
                                disabled={deployPopupSkipReason.trim().length < 10 || updatingStep}
                                onClick={() => { handlers.onUpdateStepStatus(step.id, 'skipped', undefined, deployPopupSkipReason.trim()); setDeployStepPopup(null) }}
                                style={{ flex: 1, padding: '7px 0', borderRadius: 6, border: 'none', fontSize: 12, fontWeight: 600, cursor: deployPopupSkipReason.trim().length >= 10 && !updatingStep ? 'pointer' : 'not-allowed', backgroundColor: deployPopupSkipReason.trim().length >= 10 && !updatingStep ? 'var(--color-brand)' : '#e2e6f0', color: deployPopupSkipReason.trim().length >= 10 && !updatingStep ? '#fff' : 'var(--color-slate-light)' }}
                              >
                                Conferma salto
                              </button>
                              <button onClick={() => setDeployPopupShowSkip(false)} style={{ padding: '7px 14px', borderRadius: 6, border: '1px solid #e2e6f0', background: 'transparent', cursor: 'pointer', fontSize: 12 }}>Annulla</button>
                            </div>
                          </div>
                        )}
                        {deployPopupShowFail && (
                          <div style={{ padding: 14, borderRadius: 8, border: '1px solid #fecaca', backgroundColor: 'rgba(254,242,242,0.5)', marginBottom: 10 }}>
                            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-trigger-sla-breach)', marginBottom: 8 }}>Motivo del fallimento (min. 10 caratteri)</div>
                            <textarea
                              value={deployPopupFailReason}
                              onChange={(e) => setDeployPopupFailReason(e.target.value)}
                              rows={3}
                              autoFocus
                              placeholder="Es: Errore di deploy, rollback eseguito..."
                              style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '1px solid #fecaca', borderRadius: 6, fontSize: 14, fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", resize: 'none', outline: 'none', marginBottom: 8 }}
                            />
                            <div style={{ display: 'flex', gap: 8 }}>
                              <button
                                disabled={deployPopupFailReason.trim().length < 10 || updatingStep}
                                onClick={() => { handlers.onUpdateStepStatus(step.id, 'failed', deployPopupFailReason.trim()); setDeployStepPopup(null) }}
                                style={{ flex: 1, padding: '7px 0', borderRadius: 6, border: 'none', fontSize: 12, fontWeight: 600, cursor: deployPopupFailReason.trim().length >= 10 && !updatingStep ? 'pointer' : 'not-allowed', backgroundColor: deployPopupFailReason.trim().length >= 10 && !updatingStep ? 'var(--color-trigger-sla-breach)' : '#e2e6f0', color: deployPopupFailReason.trim().length >= 10 && !updatingStep ? '#fff' : 'var(--color-slate-light)' }}
                              >
                                Conferma fallimento
                              </button>
                              <button onClick={() => setDeployPopupShowFail(false)} style={{ padding: '7px 14px', borderRadius: 6, border: '1px solid #e2e6f0', background: 'transparent', cursor: 'pointer', fontSize: 12 }}>Annulla</button>
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
                {stepDone && (
                  <div style={{ borderTop: '1px solid #e2e6f0', paddingTop: 16 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>Risultato</div>
                    {step.skipReason && <div style={{ fontSize: 14, color: 'var(--color-slate)', marginBottom: 8, fontStyle: 'italic' }}>Motivo salto: {step.skipReason}</div>}
                    {step.notes && <div style={{ fontSize: 14, color: 'var(--color-slate-dark)', marginBottom: 8, lineHeight: 1.5 }}>{step.notes}</div>}
                    {step.completedAt && <div style={{ fontSize: 12, color: 'var(--color-slate-light)' }}>Completato il: {new Date(step.completedAt).toLocaleString('it-IT')}</div>}
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
