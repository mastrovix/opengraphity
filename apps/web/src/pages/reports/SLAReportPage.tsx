import { useState } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { Gauge, Plus, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { PageContainer } from '@/components/PageContainer'
import { PageTitle } from '@/components/PageTitle'
import { QueryError } from '@/components/QueryError'
import { Skeleton } from '@/components/ui/skeleton'
import { Modal } from '@/components/Modal'
import { Button } from '@/components/Button'
import { Input, Textarea, Select, FieldLabel } from '@/components/ui/FormControls'
import { Pill } from '@/components/ui/Pill'
import { GET_SLA_REPORT, GET_OLA_CONTRACTS } from '@/graphql/queries'
import { CREATE_OLA_CONTRACT, UPDATE_OLA_CONTRACT } from '@/graphql/mutations'

// ── Types ─────────────────────────────────────────────────────────────────────

interface SLAPriorityRow { priority: string; total: number; met: number; breached: number }
interface OLARow {
  id: string; type: string; name: string; entityType: string; partyType: string | null
  partyName: string | null; resolveMinutes: number; evaluated: number; met: number
  breached: number; attainmentPct: number | null
}
interface SLAReport {
  generatedAt: string; windowDays: number
  sla: {
    total: number; met: number; breached: number; paused: number; openOnTrack: number
    breachRate: number; avgResolutionMinutes: number | null; byPriority: SLAPriorityRow[]
  }
  ola: OLARow[]
}
interface OLAContract {
  id: string; type: string; name: string; description: string | null; entityType: string
  responseMinutes: number; resolveMinutes: number; businessHours: boolean
  partyType: string | null; partyName: string | null; teamId: string | null
  teamName: string | null; enabled: boolean; createdAt: string
}

const ENTITY_LABELS: Record<string, string> = {
  incident: 'Incident', problem: 'Problem', change: 'Change', service_request: 'Service Request', any: 'Tutti',
}
const WINDOWS = [7, 30, 90]

// ── Helpers ─────────────────────────────────────────────────────────────────

function fmtMinutes(m: number | null): string {
  if (m == null) return '—'
  if (m < 60) return `${Math.round(m)}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${Math.round(m % 60)}m`
  return `${Math.floor(h / 24)}g ${h % 24}h`
}
function pctColor(pct: number | null): string {
  if (pct == null) return 'var(--color-slate-light)'
  if (pct >= 95) return '#15803d'
  if (pct >= 80) return '#b45309'
  return '#b91c1c'
}

type OLAForm = {
  type: string; name: string; description: string; entityType: string
  responseMinutes: number; resolveMinutes: number; partyType: string; partyName: string
}
const EMPTY_OLA: OLAForm = {
  type: 'ola', name: '', description: '', entityType: 'incident',
  responseMinutes: 240, resolveMinutes: 1440, partyType: 'team', partyName: '',
}

// ── KPI card ──────────────────────────────────────────────────────────────────

function Kpi({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ border: '1px solid var(--color-border-light)', borderRadius: 10, padding: '14px 16px', minWidth: 120, flex: 1 }}>
      <div style={{ fontSize: 22, fontWeight: 700, color: color ?? 'var(--color-slate-dark)' }}>{value}</div>
      <div style={{ fontSize: 12, color: 'var(--color-slate-light)', marginTop: 2 }}>{label}</div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function SLAReportPage() {
  const [windowDays, setWindowDays] = useState(30)
  const { data, loading, error, refetch } = useQuery<{ slaReport: SLAReport }>(GET_SLA_REPORT, {
    variables: { windowDays }, fetchPolicy: 'cache-and-network',
  })
  const { data: olaData, refetch: refetchOLA } = useQuery<{ olaContracts: OLAContract[] }>(GET_OLA_CONTRACTS, {
    fetchPolicy: 'cache-and-network',
  })

  const [modal, setModal] = useState<{ mode: 'create' } | { mode: 'edit'; item: OLAContract } | null>(null)
  const [form, setForm] = useState<OLAForm>(EMPTY_OLA)

  const [createOLA, { loading: creating }] = useMutation(CREATE_OLA_CONTRACT, {
    onCompleted: async () => { setModal(null); await refetchOLA(); await refetch(); toast.success('Contratto creato') },
    onError: (e) => toast.error(e.message),
  })
  const [updateOLA, { loading: updating }] = useMutation(UPDATE_OLA_CONTRACT, {
    onCompleted: async () => { setModal(null); await refetchOLA(); await refetch() },
    onError: (e) => toast.error(e.message),
  })
  const saving = creating || updating

  const openCreate = () => { setForm(EMPTY_OLA); setModal({ mode: 'create' }) }
  const openEdit = (o: OLAContract) => {
    setForm({
      type: o.type, name: o.name, description: o.description ?? '', entityType: o.entityType,
      responseMinutes: o.responseMinutes, resolveMinutes: o.resolveMinutes,
      partyType: o.partyType ?? 'team', partyName: o.partyName ?? '',
    })
    setModal({ mode: 'edit', item: o })
  }
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!modal) return
    const base = {
      name: form.name.trim(), description: form.description.trim() || null, entityType: form.entityType,
      responseMinutes: Number(form.responseMinutes), resolveMinutes: Number(form.resolveMinutes),
      partyType: form.partyType, partyName: form.partyName.trim() || null,
    }
    if (modal.mode === 'create') void createOLA({ variables: { input: { type: form.type, ...base } } })
    else void updateOLA({ variables: { id: modal.item.id, input: base } })
  }
  const toggleEnabled = (o: OLAContract) => void updateOLA({ variables: { id: o.id, input: { enabled: !o.enabled } } })

  const report = data?.slaReport
  const contracts = olaData?.olaContracts ?? []

  return (
    <PageContainer>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <PageTitle icon={<Gauge size={20} />}>Report SLA</PageTitle>
        <div style={{ display: 'flex', gap: 6 }}>
          {WINDOWS.map((w) => (
            <button
              key={w}
              onClick={() => setWindowDays(w)}
              style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid var(--color-border-light)', background: windowDays === w ? 'var(--color-brand)' : '#fff', color: windowDays === w ? '#fff' : 'var(--color-slate)', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
            >
              {w}g
            </button>
          ))}
        </div>
      </div>

      {loading && !data && <Skeleton style={{ height: 160 }} />}
      {error && !data && <QueryError message={error.message} onRetry={() => void refetch()} />}

      {report && (
        <>
          {/* SLA compliance KPIs */}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
            <Kpi label={`SLA nel periodo (${report.windowDays}g)`} value={String(report.sla.total)} />
            <Kpi label="Rispettati" value={String(report.sla.met)} color="#15803d" />
            <Kpi label="Violati" value={String(report.sla.breached)} color="#b91c1c" />
            <Kpi label="In pausa" value={String(report.sla.paused)} color="#4338ca" />
            <Kpi label="Tasso di violazione" value={`${report.sla.breachRate.toFixed(1)}%`} color={pctColor(100 - report.sla.breachRate)} />
            <Kpi label="Tempo medio risoluzione" value={fmtMinutes(report.sla.avgResolutionMinutes)} />
          </div>

          {/* By priority */}
          <div style={{ marginBottom: 28 }}>
            <h3 style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)', margin: '0 0 10px' }}>Per priorità</h3>
            {report.sla.byPriority.length === 0 ? (
              <p style={{ color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)' }}>Nessun dato SLA nel periodo.</p>
            ) : (
              <div style={{ border: '1px solid var(--color-border-light)', borderRadius: 10, overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-size-body)' }}>
                  <thead>
                    <tr style={{ background: 'var(--color-bg-subtle, #f8fafc)', textAlign: 'left', color: 'var(--color-slate-light)' }}>
                      <th style={{ padding: '9px 14px', fontWeight: 600 }}>Priorità</th>
                      <th style={{ padding: '9px 14px', fontWeight: 600 }}>Totale</th>
                      <th style={{ padding: '9px 14px', fontWeight: 600 }}>Rispettati</th>
                      <th style={{ padding: '9px 14px', fontWeight: 600 }}>Violati</th>
                      <th style={{ padding: '9px 14px', fontWeight: 600 }}>Compliance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.sla.byPriority.map((r) => {
                      const concluded = r.met + r.breached
                      const pct = concluded > 0 ? (r.met / concluded) * 100 : null
                      return (
                        <tr key={r.priority} style={{ borderTop: '1px solid var(--color-border-light)' }}>
                          <td style={{ padding: '9px 14px', fontWeight: 600, color: 'var(--color-slate-dark)', textTransform: 'capitalize' }}>{r.priority}</td>
                          <td style={{ padding: '9px 14px', color: 'var(--color-slate)' }}>{r.total}</td>
                          <td style={{ padding: '9px 14px', color: '#15803d' }}>{r.met}</td>
                          <td style={{ padding: '9px 14px', color: '#b91c1c' }}>{r.breached}</td>
                          <td style={{ padding: '9px 14px', fontWeight: 600, color: pctColor(pct) }}>{pct == null ? '—' : `${pct.toFixed(0)}%`}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* OLA / UC attainment */}
          <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)', margin: 0, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <ShieldCheck size={16} /> OLA / UC
            </h3>
            <Button onClick={openCreate}><Plus size={15} style={{ marginRight: 6 }} />Nuovo contratto</Button>
          </div>

          {contracts.length === 0 ? (
            <p style={{ color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)' }}>
              Nessun OLA/UC definito. Un OLA fissa un target tra team interni; un UC lo lega a un fornitore esterno.
            </p>
          ) : (
            <div style={{ border: '1px solid var(--color-border-light)', borderRadius: 10, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-size-body)' }}>
                <thead>
                  <tr style={{ background: 'var(--color-bg-subtle, #f8fafc)', textAlign: 'left', color: 'var(--color-slate-light)' }}>
                    <th style={{ padding: '9px 14px', fontWeight: 600 }}>Tipo</th>
                    <th style={{ padding: '9px 14px', fontWeight: 600 }}>Nome</th>
                    <th style={{ padding: '9px 14px', fontWeight: 600 }}>Ambito</th>
                    <th style={{ padding: '9px 14px', fontWeight: 600 }}>Responsabile</th>
                    <th style={{ padding: '9px 14px', fontWeight: 600 }}>Target</th>
                    <th style={{ padding: '9px 14px', fontWeight: 600 }}>Attainment ({report.windowDays}g)</th>
                    <th style={{ padding: '9px 14px', fontWeight: 600, textAlign: 'right' }}>Azioni</th>
                  </tr>
                </thead>
                <tbody>
                  {contracts.map((o) => {
                    const att = report.ola.find((r) => r.id === o.id)
                    const pct = att?.attainmentPct ?? null
                    return (
                      <tr key={o.id} style={{ borderTop: '1px solid var(--color-border-light)', opacity: o.enabled ? 1 : 0.55 }}>
                        <td style={{ padding: '9px 14px' }}>
                          <Pill bg={o.type === 'uc' ? '#ede9fe' : '#dbeafe'} color={o.type === 'uc' ? '#6d28d9' : '#1d4ed8'}>{o.type.toUpperCase()}</Pill>
                        </td>
                        <td style={{ padding: '9px 14px', fontWeight: 600, color: 'var(--color-slate-dark)' }}>{o.name}</td>
                        <td style={{ padding: '9px 14px', color: 'var(--color-slate)' }}>{ENTITY_LABELS[o.entityType] ?? o.entityType}</td>
                        <td style={{ padding: '9px 14px', color: 'var(--color-slate)' }}>{o.partyName ?? o.teamName ?? '—'}</td>
                        <td style={{ padding: '9px 14px', color: 'var(--color-slate)' }}>{fmtMinutes(o.resolveMinutes)}</td>
                        <td style={{ padding: '9px 14px', fontWeight: 600, color: pctColor(pct) }}>
                          {pct == null ? <span style={{ color: 'var(--color-slate-light)', fontWeight: 400 }}>nessun dato</span> : `${pct.toFixed(0)}%`}
                          {att && att.evaluated > 0 && (
                            <span style={{ color: 'var(--color-slate-light)', fontWeight: 400, marginLeft: 6, fontSize: 12 }}>
                              ({att.met}/{att.evaluated})
                            </span>
                          )}
                        </td>
                        <td style={{ padding: '9px 14px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <Button variant="ghost" onClick={() => openEdit(o)} style={{ marginRight: 6 }}>Modifica</Button>
                          <Button variant="secondary" onClick={() => toggleEnabled(o)} disabled={saving}>
                            {o.enabled ? 'Disattiva' : 'Attiva'}
                          </Button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          <p style={{ marginTop: 10, fontSize: 12, color: 'var(--color-slate-light)' }}>
            Generato il {new Date(report.generatedAt).toLocaleString('it-IT')}. L'attainment OLA/UC confronta il tempo di risoluzione reale delle entità concluse nel periodo con il target del contratto.
          </p>
        </>
      )}

      {/* Create / edit OLA modal */}
      <Modal
        open={modal !== null}
        onClose={() => setModal(null)}
        title={modal?.mode === 'edit' ? 'Modifica contratto OLA/UC' : 'Nuovo contratto OLA/UC'}
        as="form"
        onSubmit={submit}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setModal(null)}>Annulla</Button>
            <Button type="submit" disabled={saving || form.name.trim().length === 0}>{saving ? 'Salvataggio…' : 'Salva'}</Button>
          </>
        }
      >
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <FieldLabel>Tipo</FieldLabel>
            <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} disabled={modal?.mode === 'edit'}>
              <option value="ola">OLA (team interni)</option>
              <option value="uc">UC (fornitore esterno)</option>
            </Select>
          </div>
          <div>
            <FieldLabel>Ambito</FieldLabel>
            <Select value={form.entityType} onChange={(e) => setForm({ ...form, entityType: e.target.value })}>
              {Object.entries(ENTITY_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <FieldLabel>Nome *</FieldLabel>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required autoFocus placeholder="Es. Ripristino rete entro 4h" />
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <FieldLabel>Descrizione</FieldLabel>
            <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2} />
          </div>
          <div>
            <FieldLabel>Target risposta (min)</FieldLabel>
            <Input type="number" min={1} value={form.responseMinutes} onChange={(e) => setForm({ ...form, responseMinutes: Number(e.target.value) })} required />
          </div>
          <div>
            <FieldLabel>Target risoluzione (min)</FieldLabel>
            <Input type="number" min={1} value={form.resolveMinutes} onChange={(e) => setForm({ ...form, resolveMinutes: Number(e.target.value) })} required />
          </div>
          <div>
            <FieldLabel>Responsabile</FieldLabel>
            <Select value={form.partyType} onChange={(e) => setForm({ ...form, partyType: e.target.value })}>
              <option value="team">Team interno</option>
              <option value="supplier">Fornitore esterno</option>
            </Select>
          </div>
          <div>
            <FieldLabel>{form.partyType === 'supplier' ? 'Nome fornitore' : 'Nome team'}</FieldLabel>
            <Input value={form.partyName} onChange={(e) => setForm({ ...form, partyName: e.target.value })} placeholder={form.partyType === 'supplier' ? 'Es. Acme Cloud Srl' : 'Es. Network Ops'} />
          </div>
        </div>
      </Modal>
    </PageContainer>
  )
}
