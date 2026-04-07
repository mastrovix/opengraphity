import { useState } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { createPortal } from 'react-dom'
import { PageContainer } from '@/components/PageContainer'
import { Clock, Shield, Plus, Pencil, Trash2, X, ToggleLeft, ToggleRight } from 'lucide-react'
import { toast } from 'sonner'
import { GET_SLA_POLICIES, GET_TEAMS } from '@/graphql/queries'
import { CREATE_SLA_POLICY, UPDATE_SLA_POLICY, DELETE_SLA_POLICY } from '@/graphql/mutations'

// ── Types ─────────────────────────────────────────────────────────────────────

interface SLAPolicy {
  id: string; name: string; entityType: string; priority: string | null
  category: string | null; teamId: string | null; teamName: string | null
  timezone: string; responseMinutes: number; resolveMinutes: number
  businessHours: boolean; enabled: boolean
}

interface Team { id: string; name: string }

type FormState = {
  name: string; entityType: string; priority: string; category: string
  teamId: string; responseMinutes: number; resolveMinutes: number
  businessHours: boolean; timezone: string
}

const EMPTY_FORM: FormState = {
  name: '', entityType: 'incident', priority: '', category: '',
  teamId: '', responseMinutes: 60, resolveMinutes: 480,
  businessHours: true, timezone: 'Europe/Rome',
}

const ENTITY_TYPES = ['incident', 'problem', 'change', 'service_request'] as const
const PRIORITIES   = ['critical', 'high', 'medium', 'low'] as const
const CATEGORIES   = ['hardware', 'software', 'network', 'access', 'other'] as const

const ENTITY_LABELS: Record<string, string> = {
  incident: 'Incident', problem: 'Problem', change: 'Change', service_request: 'Service Request',
}

// ── Styles ────────────────────────────────────────────────────────────────────

const inputS: React.CSSProperties = {
  width: '100%', padding: '7px 10px', border: '1px solid #e5e7eb',
  borderRadius: 6, fontSize: 13, color: 'var(--color-slate-dark)',
  outline: 'none', backgroundColor: '#fff', boxSizing: 'border-box',
}
const selectS: React.CSSProperties = {
  ...inputS, appearance: 'none' as const,
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238892a4' stroke-width='2.5'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`,
  backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center', paddingRight: 30, cursor: 'pointer',
}
const labelS: React.CSSProperties = { display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--color-slate)', marginBottom: 4 }
const btnPrimary: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '7px 14px', border: 'none', borderRadius: 6, background: 'var(--color-brand)',
  color: '#fff', fontSize: 13, fontWeight: 500, cursor: 'pointer',
}
const btnSecondary: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '7px 14px', border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff',
  color: 'var(--color-slate)', fontSize: 13, cursor: 'pointer',
}
const badge = (bg: string, fg: string): React.CSSProperties => ({
  display: 'inline-block', padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600, background: bg, color: fg,
})

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtMinutes(m: number): string {
  if (m < 60) return `${m}min`
  if (m < 1440) return m % 60 === 0 ? `${m / 60}h` : `${Math.floor(m / 60)}h ${m % 60}min`
  const d = m / 1440
  return d === Math.floor(d) ? `${d}gg` : `${Math.floor(d)}gg ${fmtMinutes(m % 1440)}`
}

function applicabilityText(p: SLAPolicy): string {
  const parts: string[] = [`${ENTITY_LABELS[p.entityType] ?? p.entityType}`]
  if (p.priority) parts.push(`priorita ${p.priority}`)
  if (p.category) parts.push(`categoria ${p.category}`)
  if (p.teamName) parts.push(`team ${p.teamName}`)
  return parts.length === 1 ? `Si applica a: tutti gli ${parts[0]}` : `Si applica a: ${parts[0]} con ${parts.slice(1).join(', ')}`
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function SLAPoliciesPage() {
  const [modalOpen, setModalOpen]     = useState(false)
  const [editingId, setEditingId]     = useState<string | null>(null)
  const [deleteId, setDeleteId]       = useState<string | null>(null)
  const [form, setForm]               = useState<FormState>(EMPTY_FORM)

  const { data, loading } = useQuery<{ slaPolicies: SLAPolicy[] }>(GET_SLA_POLICIES)
  const { data: teamsData }           = useQuery<{ teams: Team[] }>(GET_TEAMS)
  const policies: SLAPolicy[]        = data?.slaPolicies ?? []
  const teams: Team[]                 = teamsData?.teams ?? []

  const refetch = { refetchQueries: [{ query: GET_SLA_POLICIES }] }
  const [createPolicy] = useMutation(CREATE_SLA_POLICY, refetch)
  const [updatePolicy] = useMutation(UPDATE_SLA_POLICY, refetch)
  const [deletePolicy] = useMutation(DELETE_SLA_POLICY, refetch)

  // Group by entity type
  const grouped = ENTITY_TYPES.reduce<Record<string, SLAPolicy[]>>((acc, et) => {
    const items = policies.filter(p => p.entityType === et)
    if (items.length) acc[et] = items
    return acc
  }, {})

  function openCreate() {
    setEditingId(null); setForm(EMPTY_FORM); setModalOpen(true)
  }
  function openEdit(p: SLAPolicy) {
    setEditingId(p.id)
    setForm({
      name: p.name, entityType: p.entityType, priority: p.priority ?? '',
      category: p.category ?? '', teamId: p.teamId ?? '',
      responseMinutes: p.responseMinutes, resolveMinutes: p.resolveMinutes,
      businessHours: p.businessHours, timezone: p.timezone,
    })
    setModalOpen(true)
  }

  async function handleSave() {
    if (!form.name.trim()) { toast.error('Il nome e obbligatorio'); return }
    try {
      if (editingId) {
        await updatePolicy({ variables: { id: editingId, input: {
          name: form.name.trim(),
          priority: form.priority || null, category: form.category || null,
          teamId: form.teamId || null,
          responseMinutes: Number(form.responseMinutes), resolveMinutes: Number(form.resolveMinutes),
          businessHours: form.businessHours, timezone: form.timezone,
        } } })
        toast.success('Policy aggiornata')
      } else {
        await createPolicy({ variables: { input: {
          name: form.name.trim(), entityType: form.entityType,
          priority: form.priority || null, category: form.category || null,
          teamId: form.teamId || null,
          responseMinutes: Number(form.responseMinutes), resolveMinutes: Number(form.resolveMinutes),
          businessHours: form.businessHours, timezone: form.timezone,
        } } })
        toast.success('Policy creata')
      }
      setModalOpen(false)
    } catch (e: unknown) { toast.error(e instanceof Error ? e.message : String(e)) }
  }

  async function handleDelete() {
    if (!deleteId) return
    try {
      await deletePolicy({ variables: { id: deleteId } })
      toast.success('Policy eliminata')
    } catch (e: unknown) { toast.error((e as Error).message) }
    setDeleteId(null)
  }

  async function handleToggle(p: SLAPolicy) {
    try {
      await updatePolicy({ variables: { id: p.id, input: { enabled: !p.enabled } } })
      toast.success(p.enabled ? 'Policy disabilitata' : 'Policy abilitata')
    } catch (e: unknown) { toast.error((e as Error).message) }
  }

  // ── Preview text for modal form ───────────────────────────────────────────
  function formPreview(): string {
    const parts: string[] = [ENTITY_LABELS[form.entityType] ?? form.entityType]
    if (form.priority) parts.push(`priorita ${form.priority}`)
    if (form.category) parts.push(`categoria ${form.category}`)
    const team = teams.find(t => t.id === form.teamId)
    if (team) parts.push(`team ${team.name}`)
    return parts.length === 1 ? `Tutti gli ${parts[0]}` : `${parts[0]} con ${parts.slice(1).join(', ')}`
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <PageContainer>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Shield size={22} color="var(--color-brand)" />
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: 'var(--color-slate-dark)' }}>SLA Policies</h1>
        </div>
        <button style={btnPrimary} onClick={openCreate}><Plus size={15} /> Nuova Policy</button>
      </div>

      {loading && <p style={{ color: 'var(--color-slate)', fontSize: 13 }}>Caricamento...</p>}

      {!loading && policies.length === 0 && (
        <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--color-slate)' }}>
          <Clock size={40} strokeWidth={1.5} style={{ marginBottom: 12, opacity: 0.4 }} />
          <p style={{ fontSize: 15, fontWeight: 500 }}>Nessuna SLA policy configurata</p>
          <p style={{ fontSize: 13 }}>Crea la prima policy per definire i tempi di risposta e risoluzione.</p>
        </div>
      )}

      {Object.entries(grouped).map(([entityType, items]) => (
        <div key={entityType} style={{ marginBottom: 28 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-slate-dark)', marginBottom: 8, textTransform: 'capitalize' }}>
            {ENTITY_LABELS[entityType]}
          </h3>
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden', background: '#fff' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9fafb', color: 'var(--color-slate)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  <th style={{ padding: '8px 14px', textAlign: 'left', fontWeight: 600 }}>Nome</th>
                  <th style={{ padding: '8px 14px', textAlign: 'left', fontWeight: 600 }}>Priorita</th>
                  <th style={{ padding: '8px 14px', textAlign: 'left', fontWeight: 600 }}>Categoria</th>
                  <th style={{ padding: '8px 14px', textAlign: 'left', fontWeight: 600 }}>Team</th>
                  <th style={{ padding: '8px 14px', textAlign: 'left', fontWeight: 600 }}>Risposta</th>
                  <th style={{ padding: '8px 14px', textAlign: 'left', fontWeight: 600 }}>Risoluzione</th>
                  <th style={{ padding: '8px 14px', textAlign: 'center', fontWeight: 600 }}>Business Hours</th>
                  <th style={{ padding: '8px 14px', textAlign: 'center', fontWeight: 600 }}>Attiva</th>
                  <th style={{ padding: '8px 14px', textAlign: 'right', fontWeight: 600 }}>Azioni</th>
                </tr>
              </thead>
              <tbody>
                {items.map(p => (
                  <tr key={p.id} style={{ borderTop: '1px solid #f3f4f6' }}>
                    <td style={{ padding: '10px 14px' }}>
                      <div style={{ fontWeight: 500, color: 'var(--color-slate-dark)' }}>{p.name}</div>
                      <div style={{ fontSize: 11, color: 'var(--color-slate)', marginTop: 2, fontStyle: 'italic' }}>{applicabilityText(p)}</div>
                    </td>
                    <td style={{ padding: '10px 14px' }}>
                      {p.priority ? <span style={badge('#fef3c7', '#92400e')}>{p.priority}</span> : <span style={{ color: 'var(--color-slate)', fontSize: 12 }}>Tutte</span>}
                    </td>
                    <td style={{ padding: '10px 14px' }}>
                      {p.category ? <span style={badge('#dbeafe', '#1e40af')}>{p.category}</span> : <span style={{ color: 'var(--color-slate)', fontSize: 12 }}>Tutte</span>}
                    </td>
                    <td style={{ padding: '10px 14px', color: p.teamName ? 'var(--color-slate-dark)' : 'var(--color-slate)', fontSize: 12 }}>
                      {p.teamName ?? 'Tutti'}
                    </td>
                    <td style={{ padding: '10px 14px', fontWeight: 500 }}>{fmtMinutes(p.responseMinutes)}</td>
                    <td style={{ padding: '10px 14px', fontWeight: 500 }}>{fmtMinutes(p.resolveMinutes)}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'center' }}>
                      <span style={badge(p.businessHours ? '#dcfce7' : '#f3f4f6', p.businessHours ? '#15803d' : 'var(--color-slate)')}>
                        {p.businessHours ? 'Si' : 'No'}
                      </span>
                    </td>
                    <td style={{ padding: '10px 14px', textAlign: 'center' }}>
                      <button onClick={() => handleToggle(p)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2 }}>
                        {p.enabled
                          ? <ToggleRight size={22} color="var(--color-brand)" />
                          : <ToggleLeft size={22} color="#cbd5e1" />}
                      </button>
                    </td>
                    <td style={{ padding: '10px 14px', textAlign: 'right' }}>
                      <div style={{ display: 'inline-flex', gap: 6 }}>
                        <button onClick={() => openEdit(p)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }} title="Modifica">
                          <Pencil size={15} color="var(--color-slate)" />
                        </button>
                        <button onClick={() => setDeleteId(p.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }} title="Elimina">
                          <Trash2 size={15} color="#ef4444" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {/* ── Create / Edit Modal ──────────────────────────────────────────────── */}
      {modalOpen && createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: 16 }}
             onClick={e => { if (e.target === e.currentTarget) setModalOpen(false) }}>
          <div style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 560, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 24px 80px rgba(0,0,0,0.22)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 24px', borderBottom: '1px solid #f3f4f6' }}>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: 'var(--color-slate-dark)' }}>
                {editingId ? 'Modifica Policy' : 'Nuova SLA Policy'}
              </h2>
              <button onClick={() => setModalOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 6, borderRadius: 6, display: 'flex' }}>
                <X size={20} color="var(--color-slate)" />
              </button>
            </div>

            <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label style={labelS}>Nome *</label>
                <input style={inputS} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="es. SLA Critical Incident" />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={labelS}>Tipo Entita *</label>
                  <select style={selectS} value={form.entityType} onChange={e => setForm({ ...form, entityType: e.target.value })}>
                    {ENTITY_TYPES.map(et => <option key={et} value={et}>{ENTITY_LABELS[et]}</option>)}
                  </select>
                </div>
                <div>
                  <label style={labelS}>Priorita</label>
                  <select style={selectS} value={form.priority} onChange={e => setForm({ ...form, priority: e.target.value })}>
                    <option value="">Tutte</option>
                    {PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={labelS}>Categoria</label>
                  <select style={selectS} value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}>
                    <option value="">Tutte</option>
                    {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label style={labelS}>Team</label>
                  <select style={selectS} value={form.teamId} onChange={e => setForm({ ...form, teamId: e.target.value })}>
                    <option value="">Tutti</option>
                    {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={labelS}>Tempo Risposta (minuti) *</label>
                  <input style={inputS} type="number" min={1} value={form.responseMinutes} onChange={e => setForm({ ...form, responseMinutes: Number(e.target.value) })} />
                </div>
                <div>
                  <label style={labelS}>Tempo Risoluzione (minuti) *</label>
                  <input style={inputS} type="number" min={1} value={form.resolveMinutes} onChange={e => setForm({ ...form, resolveMinutes: Number(e.target.value) })} />
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, alignItems: 'end' }}>
                <div>
                  <label style={labelS}>Timezone</label>
                  <input style={inputS} value={form.timezone} onChange={e => setForm({ ...form, timezone: e.target.value })} />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 2 }}>
                  <button onClick={() => setForm({ ...form, businessHours: !form.businessHours })} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex' }}>
                    {form.businessHours
                      ? <ToggleRight size={26} color="var(--color-brand)" />
                      : <ToggleLeft size={26} color="#cbd5e1" />}
                  </button>
                  <span style={{ fontSize: 13, color: 'var(--color-slate-dark)' }}>Solo orario lavorativo</span>
                </div>
              </div>

              {/* Preview */}
              <div style={{ background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#0369a1' }}>
                <strong>Anteprima:</strong> {formPreview()} — risposta entro {fmtMinutes(form.responseMinutes)}, risoluzione entro {fmtMinutes(form.resolveMinutes)}
                {form.businessHours ? ' (orario lavorativo)' : ' (24/7)'}
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '14px 24px', borderTop: '1px solid #f3f4f6' }}>
              <button style={btnSecondary} onClick={() => setModalOpen(false)}>Annulla</button>
              <button style={btnPrimary} onClick={handleSave}>{editingId ? 'Salva' : 'Crea'}</button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* ── Delete Confirmation ──────────────────────────────────────────────── */}
      {deleteId && createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: 16 }}
             onClick={e => { if (e.target === e.currentTarget) setDeleteId(null) }}>
          <div style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 400, boxShadow: '0 24px 80px rgba(0,0,0,0.22)', padding: '24px' }}>
            <h3 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 700, color: 'var(--color-slate-dark)' }}>Conferma eliminazione</h3>
            <p style={{ fontSize: 13, color: 'var(--color-slate)', margin: '0 0 20px' }}>
              Sei sicuro di voler eliminare questa SLA policy? L'azione non e reversibile.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button style={btnSecondary} onClick={() => setDeleteId(null)}>Annulla</button>
              <button style={{ ...btnPrimary, background: '#ef4444' }} onClick={handleDelete}>Elimina</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </PageContainer>
  )
}
