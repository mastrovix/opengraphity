import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation } from '@apollo/client/react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { StatusBadge } from '@/components/StatusBadge'
import { CIGraph } from '@/components/CIGraph'
import { TypeBadge } from '@/components/Badges'
import { Modal } from '@/components/Modal'
import { CountBadge } from '@/components/ui/CountBadge'
import { GET_CI_DETAIL, GET_BLAST_RADIUS, GET_CIS } from '@/graphql/queries'
import { ADD_CI_DEPENDENCY, UPDATE_CI } from '@/graphql/mutations'

interface CIRef {
  id:          string
  name:        string
  type:        string
  status:      string
  environment: string
}

interface BlastRadiusItem extends CIRef {
  distance: number
}

const DIST_BG:   Record<number, string> = { 1: '#fef2f2', 2: '#fff7ed', 3: '#fefce8' }
const DIST_TEXT: Record<number, string> = { 1: '#dc2626', 2: '#ea580c', 3: '#ca8a04' }

interface CIRelation {
  relationType: string
  ci:           CIRef
}

interface Team {
  id:   string
  name: string
}

interface CIDetail extends CIRef {
  createdAt:            string
  updatedAt:            string
  dependenciesWithType: CIRelation[]
  dependentsWithType:   CIRelation[]
  owner:                Team | null
  supportGroup:         Team | null
  ipAddress:            string | null
  location:             string | null
  vendor:               string | null
  version:              string | null
  port:                 number | null
  url:                  string | null
  region:               string | null
  expiryDate:           string | null
  notes:                string | null
}

const DEP_TYPES = [
  { value: 'depends_on',   label: 'Depends On' },
  { value: 'hosted_on',    label: 'Hosted On' },
  { value: 'connects_to',  label: 'Connects To' },
  { value: 'backed_up_by', label: 'Backed Up By' },
  { value: 'protected_by', label: 'Protected By' },
]

const TYPE_ICON: Record<string, string> = {
  server:            '🖥',
  virtual_machine:   '☁️',
  database:          '🗄',
  database_instance: '🗄',
  application:       '📦',
  microservice:      '⚙️',
  network_device:    '🌐',
  storage:           '💾',
  cloud_service:     '☁️',
  ssl_certificate:   '🔒',
  api_endpoint:      '🔌',
}

function CIRow({ ci, relationType, onClick }: { ci: CIRef; relationType?: string; onClick?: () => void }) {
  return (
    <div
      onClick={onClick}
      style={{
        display:       'flex',
        alignItems:    'center',
        gap:           12,
        padding:       '10px 0',
        borderBottom:  '1px solid #f1f3f9',
        cursor:        onClick ? 'pointer' : 'default',
      }}
    >
      <span style={{ fontSize: 18 }}>{TYPE_ICON[ci.type] ?? '📄'}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#0f1629', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {ci.name}
        </div>
        <div style={{ fontSize: 12, color: '#8892a4', textTransform: 'capitalize' }}>
          {ci.type.replace(/_/g, ' ')} · {ci.environment}
        </div>
        {relationType && (
          <div style={{ fontSize: 11, color: '#8892a4', marginTop: 2, fontFamily: 'DM Mono, monospace', textTransform: 'lowercase' }}>
            {relationType.replace(/_/g, ' ')}
          </div>
        )}
      </div>
      <StatusBadge value={ci.status} />
    </div>
  )
}


const CI_FIELDS: Record<string, string[]> = {
  server:            ['ipAddress', 'location', 'vendor', 'notes'],
  virtual_machine:   ['ipAddress', 'location', 'notes'],
  database_instance: ['ipAddress', 'version', 'port', 'notes'],
  database:          ['version', 'notes'],
  microservice:      ['version', 'ipAddress', 'port', 'url', 'notes'],
  application:       ['version', 'vendor', 'url', 'port', 'notes'],
  network_device:    ['ipAddress', 'location', 'vendor', 'notes'],
  storage:           ['location', 'vendor', 'notes'],
  cloud_service:     ['vendor', 'region', 'url', 'notes'],
  ssl_certificate:   ['version', 'expiryDate', 'vendor', 'notes'],
  api_endpoint:      ['version', 'url', 'port', 'notes'],
}

export function CMDBDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [dialogOpen,    setDialogOpen]    = useState(false)
  const [selectedCIId,  setSelectedCIId]  = useState('')
  const [depType,       setDepType]       = useState('depends_on')
  const [submitted,     setSubmitted]     = useState(false)
  const [graphOpen,     setGraphOpen]     = useState(false)
  const [infoOpen,      setInfoOpen]      = useState(true)
  const [depsOpen,      setDepsOpen]      = useState(false)
  const [depentsOpen,   setDepentsOpen]   = useState(false)
  const [blastOpen,     setBlastOpen]     = useState(false)
  const [editOpen,      setEditOpen]      = useState(false)
  const [editForm,      setEditForm]      = useState<Record<string, string | number | null>>({})

  const { data, loading, refetch } = useQuery<{ configurationItem: CIDetail | null }, { id: string | undefined }>(
    GET_CI_DETAIL,
    { variables: { id }, skip: !id },
  )

  const { data: cisData } = useQuery<{ configurationItems: { items: CIRef[] } }>(GET_CIS)

  const { data: blastData, loading: blastLoading } = useQuery<{ blastRadius: BlastRadiusItem[] }>(
    GET_BLAST_RADIUS,
    { variables: { ciId: id, depth: 3 }, skip: !id },
  )

  const [addDep, { loading: adding }] = useMutation(ADD_CI_DEPENDENCY, {
    onCompleted: () => {
      setDialogOpen(false)
      setSelectedCIId('')
      setDepType('depends_on')
      setSubmitted(false)
      refetch()
    },
  })

  const [updateCI, { loading: saving }] = useMutation(UPDATE_CI, {
    onCompleted: () => { setEditOpen(false); refetch() },
  })

  const ci = data?.configurationItem

  function openEdit() {
    if (!ci) return
    setEditForm({
      name:        ci.name,
      status:      ci.status,
      environment: ci.environment,
      ipAddress:   ci.ipAddress   ?? '',
      location:    ci.location    ?? '',
      vendor:      ci.vendor      ?? '',
      version:     ci.version     ?? '',
      port:        ci.port        ?? '',
      url:         ci.url         ?? '',
      region:      ci.region      ?? '',
      expiryDate:  ci.expiryDate  ?? '',
      notes:       ci.notes       ?? '',
    })
    setEditOpen(true)
  }

  function handleEditSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!ci) return
    const input: Record<string, string | number | null> = {}
    for (const [k, v] of Object.entries(editForm)) {
      if (v === '' || v === null || v === undefined) {
        input[k] = null
      } else if (k === 'port') {
        input[k] = Number(v)
      } else {
        input[k] = String(v)
      }
    }
    updateCI({ variables: { id: ci.id, input } })
  }

  function handleAddDep(e: React.FormEvent) {
    e.preventDefault()
    setSubmitted(true)
    if (!selectedCIId) return
    addDep({ variables: { fromId: id, toId: selectedCIId, type: depType } })
  }

  const inputBase: React.CSSProperties = {
    width:           '100%',
    padding:         '10px 14px',
    border:          '1px solid #e5e7eb',
    borderRadius:    6,
    fontSize:        14,
    color:           '#0f1629',
    outline:         'none',
    backgroundColor: '#ffffff',
    boxSizing:       'border-box',
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200, color: '#8892a4', fontSize: 14 }}>
        Loading…
      </div>
    )
  }

  if (!ci) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 200, gap: 12 }}>
        <span style={{ fontSize: 32 }}>🔍</span>
        <p style={{ color: '#8892a4', fontSize: 14, margin: 0 }}>Configuration item non trovato.</p>
        <button onClick={() => navigate('/cmdb')} style={{ color: '#4f46e5', background: 'none', border: 'none', fontSize: 14, cursor: 'pointer' }}>
          ← Back to CMDB
        </button>
      </div>
    )
  }

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <button
          onClick={() => navigate('/cmdb')}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: '#8892a4', background: 'none', border: 'none', fontSize: 13, cursor: 'pointer', padding: 0, marginBottom: 12 }}
        >
          ← CMDB
        </button>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 24 }}>{TYPE_ICON[ci.type] ?? '📄'}</span>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0f1629', letterSpacing: '-0.01em', margin: 0 }}>
              {ci.name}
            </h1>
            <TypeBadge type={ci.type} />
            <StatusBadge value={ci.status} />
          </div>
          <button
            onClick={openEdit}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: 6, border: '1px solid #e5e7eb', background: 'white', fontSize: 14, fontWeight: 500, color: '#1a1f2e', cursor: 'pointer' }}
          >
            ✏️ Modifica
          </button>
        </div>
      </div>

      {/* Information — collapsible full-width card */}
      {(() => {
        const ciItem = ci
        const FIELD_LABELS: Record<string, string> = {
          ipAddress:  'IP Address',
          location:   'Location',
          vendor:     'Vendor',
          version:    'Version',
          port:       'Port',
          url:        'URL',
          region:     'Region',
          expiryDate: 'Expiry Date',
          notes:      'Notes',
        }
        const typeFields = CI_FIELDS[ciItem.type] ?? []

        function renderFieldValue(field: string) {
          const raw = ciItem[field as keyof typeof ciItem]
          if (raw === null || raw === undefined || raw === '') return <span style={{ color: '#c4cad4' }}>—</span>
          if (field === 'expiryDate') return String(new Date(String(raw)).toLocaleDateString())
          return String(raw)
        }

        const InfoField = ({ label, children }: { label: string; children: React.ReactNode }) => (
          <div>
            <div style={{ fontSize: 11, color: '#8892a4', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>{label}</div>
            <div style={{ fontSize: 13, fontWeight: 500, color: '#111827' }}>{children}</div>
          </div>
        )

        return (
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, marginBottom: 16 }}>
            {/* Header */}
            <div
              onClick={() => setInfoOpen((v) => !v)}
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 20px', cursor: 'pointer', borderBottom: infoOpen ? '1px solid #e5e7eb' : 'none', borderRadius: infoOpen ? '10px 10px 0 0' : 10 }}
            >
              <h3 style={{ fontSize: 14, fontWeight: 600, color: '#0f1629', margin: 0 }}>Information</h3>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button
                  onClick={(e) => { e.stopPropagation(); setDialogOpen(true) }}
                  style={{ padding: '6px 12px', backgroundColor: '#4f46e5', color: '#ffffff', border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap' }}
                >
                  + Add Dependency
                </button>
                {infoOpen
                  ? <ChevronDown size={16} color="#8892a4" />
                  : <ChevronRight size={16} color="#8892a4" />
                }
              </div>
            </div>

            {/* Content — 2-column grid */}
            {infoOpen && (
              <div style={{ padding: '16px 20px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px 32px' }}>
                {/* ID — full width */}
                <div style={{ gridColumn: '1 / -1' }}>
                  <InfoField label="ID">
                    <span
                      title={ciItem.id}
                      style={{ fontFamily: 'DM Mono, monospace', fontSize: 12, cursor: 'default', display: 'block', maxWidth: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >
                      {ciItem.id}
                    </span>
                  </InfoField>
                </div>
                {/* Row 2 */}
                <InfoField label="Tipo"><TypeBadge type={ciItem.type} /></InfoField>
                <InfoField label="Status"><StatusBadge value={ciItem.status} /></InfoField>
                {/* Row 3 */}
                <InfoField label="Environment"><span style={{ textTransform: 'capitalize' }}>{ciItem.environment}</span></InfoField>
                <InfoField label="Creato">{new Date(ciItem.createdAt).toLocaleDateString('it-IT')}</InfoField>
                {/* Row 4 */}
                <InfoField label="Owner">
                  {ciItem.owner
                    ? <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 100, backgroundColor: '#eef2ff', fontSize: 12, fontWeight: 500, color: '#4f46e5' }}>{ciItem.owner.name}</span>
                    : <span style={{ color: '#c4cad4' }}>—</span>}
                </InfoField>
                <InfoField label="Support Group">
                  {ciItem.supportGroup
                    ? <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 100, backgroundColor: '#ecfdf5', fontSize: 12, fontWeight: 500, color: '#059669' }}>{ciItem.supportGroup.name}</span>
                    : <span style={{ color: '#c4cad4' }}>—</span>}
                </InfoField>
                {/* Type-specific fields */}
                {typeFields.map((field) => (
                  <InfoField key={field} label={FIELD_LABELS[field] ?? field}>{renderFieldValue(field)}</InfoField>
                ))}
              </div>
            )}
          </div>
        )
      })()}

      {/* Graph card — collapsible */}
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, marginBottom: 16, overflow: 'hidden' }}>
        <div
          onClick={() => setGraphOpen((p) => !p)}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', padding: '14px 20px', borderBottom: graphOpen ? '1px solid #e5e7eb' : 'none' }}
        >
          <span style={{ fontSize: 14, fontWeight: 600, color: '#111827' }}>Mappa Dipendenze</span>
          {graphOpen
            ? <ChevronDown size={16} color="#8892a4" />
            : <ChevronRight size={16} color="#8892a4" />}
        </div>
        {graphOpen && (
          <div>
            <CIGraph
              centerCI={ci}
              dependencies={ci.dependenciesWithType}
              dependents={ci.dependentsWithType}
              blastRadius={(() => {
                const known = new Set([
                  ...ci.dependenciesWithType.map((r) => r.ci.id),
                  ...ci.dependentsWithType.map((r) => r.ci.id),
                  ci.id,
                ])
                return (blastData?.blastRadius ?? []).filter((n) => !known.has(n.id))
              })()}
            />
          </div>
        )}
      </div>

      {/* Single-column layout */}
      <div>
        {/* Dependencies */}
        <div style={{ backgroundColor: '#ffffff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20, marginBottom: 16 }}>
          <div
            onClick={() => setDepsOpen((v) => !v)}
            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', margin: 0 }}
          >
            <h3 style={{ fontSize: 14, fontWeight: 600, color: '#0f1629', margin: 0, display: 'flex', alignItems: 'center' }}>
              Dipendenze
              <CountBadge count={ci.dependenciesWithType.length} />
            </h3>
            {depsOpen ? <ChevronDown size={16} color="#8892a4" /> : <ChevronRight size={16} color="#8892a4" />}
          </div>
          {depsOpen && (
            <div style={{ marginTop: 16 }}>
              {ci.dependenciesWithType.length === 0 ? (
                <p style={{ fontSize: 13, color: '#8892a4', margin: 0 }}>Nessuna dipendenza.</p>
              ) : (
                ci.dependenciesWithType.map((rel) => (
                  <CIRow key={rel.ci.id} ci={rel.ci} relationType={rel.relationType} onClick={() => navigate(`/cmdb/${rel.ci.id}`)} />
                ))
              )}
            </div>
          )}
        </div>

        {/* Dependents */}
        <div style={{ backgroundColor: '#ffffff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20, marginBottom: 16 }}>
          <div
            onClick={() => setDepentsOpen((v) => !v)}
            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', margin: 0 }}
          >
            <h3 style={{ fontSize: 14, fontWeight: 600, color: '#0f1629', margin: 0, display: 'flex', alignItems: 'center' }}>
              Dipendenti
              <CountBadge count={ci.dependentsWithType.length} />
            </h3>
            {depentsOpen ? <ChevronDown size={16} color="#8892a4" /> : <ChevronRight size={16} color="#8892a4" />}
          </div>
          {depentsOpen && (
            <div style={{ marginTop: 16 }}>
              {ci.dependentsWithType.length === 0 ? (
                <p style={{ fontSize: 13, color: '#8892a4', margin: 0 }}>Nessun dipendente.</p>
              ) : (
                ci.dependentsWithType.map((rel) => (
                  <CIRow key={rel.ci.id} ci={rel.ci} relationType={rel.relationType} onClick={() => navigate(`/cmdb/${rel.ci.id}`)} />
                ))
              )}
            </div>
          )}
        </div>

        {/* Blast Radius */}
        <div style={{ backgroundColor: '#ffffff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20, marginBottom: 16 }}>
          <div
            onClick={() => setBlastOpen((v) => !v)}
            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', margin: 0 }}
          >
            <h3 style={{ fontSize: 14, fontWeight: 600, color: '#0f1629', margin: 0, display: 'flex', alignItems: 'center' }}>
              Blast Radius
              <CountBadge count={blastData?.blastRadius?.length ?? 0} />
            </h3>
            {blastOpen ? <ChevronDown size={16} color="#8892a4" /> : <ChevronRight size={16} color="#8892a4" />}
          </div>
          {blastOpen && (
            <div style={{ marginTop: 16 }}>
              {blastLoading ? (
                <p style={{ fontSize: 13, color: '#8892a4', margin: 0 }}>Caricamento…</p>
              ) : !blastData?.blastRadius?.length ? (
                <p style={{ fontSize: 13, color: '#8892a4', margin: 0 }}>Nessun impatto downstream rilevato.</p>
              ) : (() => {
                const groups = new Map<number, BlastRadiusItem[]>()
                for (const item of blastData.blastRadius) {
                  const g = groups.get(item.distance) ?? []
                  g.push(item)
                  groups.set(item.distance, g)
                }
                return Array.from(groups.entries()).map(([dist, items]) => (
                  <div key={dist}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: '#8892a4', textTransform: 'uppercase', letterSpacing: '0.04em', padding: '8px 0 4px' }}>
                      {dist === 1 ? 'Dipendenze dirette' : `Profondità ${dist}`}
                    </div>
                    {items.map((d) => (
                      <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 4 }} onClick={() => navigate(`/cmdb/${d.id}`)}>
                        <div style={{ flex: 1 }}>
                          <CIRow ci={d} />
                        </div>
                        <span style={{ display: 'inline-flex', alignItems: 'center', padding: '1px 6px', borderRadius: 4, fontSize: 10, fontWeight: 600, background: DIST_BG[dist] ?? '#f1f5f9', color: DIST_TEXT[dist] ?? '#64748b', whiteSpace: 'nowrap', flexShrink: 0 }}>
                          {dist} hop
                        </span>
                      </div>
                    ))}
                  </div>
                ))
              })()}
            </div>
          )}
        </div>
      </div>

      {/* Dialog overlay */}
      <Modal
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title="Add Dependency"
        width={440}
        footer={
          <>
            <button
              type="button"
              onClick={() => { setDialogOpen(false); setSubmitted(false); setSelectedCIId('') }}
              style={{ padding: '9px 18px', background: 'none', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 14, color: '#4a5468', cursor: 'pointer' }}
            >
              Cancel
            </button>
            <button
              type="submit"
              form="add-dep-form"
              disabled={adding || !selectedCIId}
              style={{ padding: '9px 18px', backgroundColor: '#4f46e5', color: '#ffffff', border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 500, cursor: (adding || !selectedCIId) ? 'not-allowed' : 'pointer', opacity: (adding || !selectedCIId) ? 0.5 : 1 }}
            >
              {adding ? 'Adding…' : 'Add'}
            </button>
          </>
        }
      >
        <form id="add-dep-form" onSubmit={handleAddDep}>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 500, color: '#374151', marginBottom: 6 }}>
              Configuration Item <span style={{ color: '#dc2626' }}>*</span>
            </label>
            <select
              value={selectedCIId}
              onChange={(e) => setSelectedCIId(e.target.value)}
              style={{ ...inputBase, borderColor: submitted && !selectedCIId ? '#dc2626' : '#e5e7eb', cursor: 'pointer' }}
            >
              <option value="">Seleziona CI...</option>
              {(cisData?.configurationItems?.items ?? [])
                .filter((c) => c.id !== ci.id)
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.type.replace(/_/g, ' ')} — {c.environment})
                  </option>
                ))
              }
            </select>
            {submitted && !selectedCIId && (
              <p style={{ fontSize: 12, color: '#dc2626', margin: '4px 0 0 0' }}>Seleziona un CI.</p>
            )}
          </div>
          <div style={{ marginBottom: 8 }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 500, color: '#374151', marginBottom: 6 }}>
              Dependency Type
            </label>
            <select
              value={depType}
              onChange={(e) => setDepType(e.target.value)}
              style={{ ...inputBase }}
            >
              {DEP_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>
        </form>
      </Modal>

      {/* ── Edit Dialog ─────────────────────────────────────────── */}
      <Modal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title="Modifica CI"
        width={520}
        footer={
          <>
            <button
              type="button"
              onClick={() => setEditOpen(false)}
              style={{ padding: '9px 18px', background: 'none', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 14, color: '#4a5468', cursor: 'pointer' }}
            >
              Cancel
            </button>
            <button
              type="submit"
              form="edit-ci-form"
              disabled={saving}
              style={{ padding: '9px 18px', backgroundColor: '#4f46e5', color: '#ffffff', border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 500, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.5 : 1 }}
            >
              {saving ? 'Salvataggio…' : 'Salva'}
            </button>
          </>
        }
      >
        {ci && (() => {
          const ciItem = ci
          const varFields = CI_FIELDS[ciItem.type] ?? []
          const fieldLabel: Record<string, string> = {
            ipAddress:  'IP Address',
            location:   'Location',
            vendor:     'Vendor',
            version:    'Version',
            port:       'Port',
            url:        'URL',
            region:     'Region',
            expiryDate: 'Expiry Date',
            notes:      'Notes',
          }
          return (
            <form id="edit-ci-form" onSubmit={handleEditSubmit}>

              {/* Name */}
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 500, color: '#374151', marginBottom: 6 }}>Name</label>
                <input
                  type="text"
                  value={(editForm['name'] as string) ?? ''}
                  onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                  style={{ ...inputBase }}
                />
              </div>

              {/* Status */}
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 500, color: '#374151', marginBottom: 6 }}>Status</label>
                <select
                  value={(editForm['status'] as string) ?? ''}
                  onChange={(e) => setEditForm((f) => ({ ...f, status: e.target.value }))}
                  style={{ ...inputBase }}
                >
                  {['active', 'inactive', 'maintenance', 'decommissioned'].map((s) => (
                    <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
                  ))}
                </select>
              </div>

              {/* Environment */}
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 500, color: '#374151', marginBottom: 6 }}>Environment</label>
                <select
                  value={(editForm['environment'] as string) ?? ''}
                  onChange={(e) => setEditForm((f) => ({ ...f, environment: e.target.value }))}
                  style={{ ...inputBase }}
                >
                  {['production', 'staging', 'development', 'testing', 'dr'].map((env) => (
                    <option key={env} value={env}>{env.charAt(0).toUpperCase() + env.slice(1)}</option>
                  ))}
                </select>
              </div>

              {/* Variable fields per CI type */}
              {varFields.map((field) => {
                const label = fieldLabel[field] ?? field
                if (field === 'notes') {
                  return (
                    <div key={field} style={{ marginBottom: 16 }}>
                      <label style={{ display: 'block', fontSize: 13, fontWeight: 500, color: '#374151', marginBottom: 6 }}>{label}</label>
                      <textarea
                        value={(editForm[field] as string) ?? ''}
                        onChange={(e) => setEditForm((f) => ({ ...f, [field]: e.target.value }))}
                        rows={3}
                        style={{ ...inputBase, resize: 'vertical' }}
                      />
                    </div>
                  )
                }
                if (field === 'expiryDate') {
                  return (
                    <div key={field} style={{ marginBottom: 16 }}>
                      <label style={{ display: 'block', fontSize: 13, fontWeight: 500, color: '#374151', marginBottom: 6 }}>{label}</label>
                      <input
                        type="date"
                        value={(editForm[field] as string) ?? ''}
                        onChange={(e) => setEditForm((f) => ({ ...f, [field]: e.target.value }))}
                        style={{ ...inputBase }}
                      />
                    </div>
                  )
                }
                if (field === 'port') {
                  return (
                    <div key={field} style={{ marginBottom: 16 }}>
                      <label style={{ display: 'block', fontSize: 13, fontWeight: 500, color: '#374151', marginBottom: 6 }}>{label}</label>
                      <input
                        type="number"
                        value={(editForm[field] as string) ?? ''}
                        onChange={(e) => setEditForm((f) => ({ ...f, [field]: e.target.value }))}
                        style={{ ...inputBase }}
                      />
                    </div>
                  )
                }
                return (
                  <div key={field} style={{ marginBottom: 16 }}>
                    <label style={{ display: 'block', fontSize: 13, fontWeight: 500, color: '#374151', marginBottom: 6 }}>{label}</label>
                    <input
                      type="text"
                      value={(editForm[field] as string) ?? ''}
                      onChange={(e) => setEditForm((f) => ({ ...f, [field]: e.target.value }))}
                      style={{ ...inputBase }}
                    />
                  </div>
                )
              })}
            </form>
          )
        })()}
      </Modal>
    </div>
  )
}
