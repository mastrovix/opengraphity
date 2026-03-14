import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation } from '@apollo/client/react'
import { StatusBadge } from '@/components/StatusBadge'
import { CIGraph } from '@/components/CIGraph'
import { TypeBadge } from '@/components/Badges'
import { Modal } from '@/components/Modal'
import { GET_CI_DETAIL, GET_BLAST_RADIUS, GET_CIS } from '@/graphql/queries'
import { ADD_CI_DEPENDENCY, UPDATE_CI } from '@/graphql/mutations'

interface CIRef {
  id:          string
  name:        string
  type:        string
  status:      string
  environment: string
}

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

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ backgroundColor: '#ffffff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20, marginBottom: 16 }}>
      <h3 style={{ fontSize: 14, fontWeight: 600, color: '#0f1629', margin: '0 0 16px 0' }}>{title}</h3>
      {children}
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #f1f3f9', gap: 12 }}>
      <span style={{ fontSize: 12, color: '#8892a4', flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 13, color: '#0f1629', fontWeight: 500, textAlign: 'right', wordBreak: 'break-all' }}>{value}</span>
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
  const [depsOpen,      setDepsOpen]      = useState(false)
  const [depentsOpen,   setDepentsOpen]   = useState(false)
  const [blastOpen,     setBlastOpen]     = useState(false)
  const [editOpen,      setEditOpen]      = useState(false)
  const [editForm,      setEditForm]      = useState<Record<string, string | number | null>>({})

  const { data, loading, refetch } = useQuery<{ configurationItem: CIDetail | null }, { id: string | undefined }>(
    GET_CI_DETAIL,
    { variables: { id }, skip: !id },
  )

  const { data: cisData } = useQuery<{ configurationItems: CIRef[] }>(GET_CIS)

  const { data: blastData, loading: blastLoading } = useQuery<{ blastRadius: CIRef[] }>(
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

      {/* Graph card — full width */}
      <Card title="Mappa delle Dipendenze">
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
      </Card>

      {/* Two-column layout */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 16, alignItems: 'start' }}>
        {/* Main column */}
        <div>
          {/* Dependencies */}
          <div style={{ backgroundColor: '#ffffff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20, marginBottom: 16 }}>
            <div
              onClick={() => setDepsOpen((v) => !v)}
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', margin: 0 }}
            >
              <h3 style={{ fontSize: 14, fontWeight: 600, color: '#0f1629', margin: 0 }}>
                Dipendenze{' '}
                <span style={{ fontSize: 13, color: '#8892a4', fontWeight: 400 }}>({ci.dependenciesWithType.length})</span>
              </h3>
              <span style={{ transform: depsOpen ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 200ms ease', color: '#8892a4', lineHeight: 1 }}>▾</span>
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
              <h3 style={{ fontSize: 14, fontWeight: 600, color: '#0f1629', margin: 0 }}>
                Dipendenti{' '}
                <span style={{ fontSize: 13, color: '#8892a4', fontWeight: 400 }}>({ci.dependentsWithType.length})</span>
              </h3>
              <span style={{ transform: depentsOpen ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 200ms ease', color: '#8892a4', lineHeight: 1 }}>▾</span>
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
              <h3 style={{ fontSize: 14, fontWeight: 600, color: '#0f1629', margin: 0 }}>
                Blast Radius{' '}
                <span style={{ fontSize: 13, color: '#8892a4', fontWeight: 400 }}>({blastData?.blastRadius?.length ?? 0})</span>
              </h3>
              <span style={{ transform: blastOpen ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 200ms ease', color: '#8892a4', lineHeight: 1 }}>▾</span>
            </div>
            {blastOpen && (
              <div style={{ marginTop: 16 }}>
                {blastLoading ? (
                  <p style={{ fontSize: 13, color: '#8892a4', margin: 0 }}>Loading…</p>
                ) : !blastData?.blastRadius?.length ? (
                  <p style={{ fontSize: 13, color: '#8892a4', margin: 0 }}>Nessun impatto downstream rilevato.</p>
                ) : (
                  blastData.blastRadius.map((d) => (
                    <CIRow key={d.id} ci={d} onClick={() => navigate(`/cmdb/${d.id}`)} />
                  ))
                )}
              </div>
            )}
          </div>
        </div>

        {/* Sidebar */}
        <div>
          {/* Information */}
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
              if (raw === null || raw === undefined || raw === '') {
                return <span style={{ color: '#c4cad4' }}>—</span>
              }
              if (field === 'expiryDate') {
                return String(new Date(String(raw)).toLocaleDateString())
              }
              return String(raw)
            }

            return (
              <Card title="Information">
                {/* Fixed fields */}
                <InfoRow label="ID"          value={ciItem.id} />
                <InfoRow label="Type"        value={<TypeBadge type={ciItem.type} />} />
                <InfoRow label="Status"      value={<StatusBadge value={ciItem.status} />} />
                <InfoRow label="Environment" value={<span style={{ textTransform: 'capitalize' }}>{ciItem.environment}</span>} />
                <InfoRow label="Owner" value={
                  ciItem.owner
                    ? <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 100, backgroundColor: '#eef2ff', fontSize: 12, fontWeight: 500, color: '#4f46e5' }}>{ciItem.owner.name}</span>
                    : <span style={{ color: '#c4cad4' }}>—</span>
                } />
                <InfoRow label="Support Group" value={
                  ciItem.supportGroup
                    ? <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 100, backgroundColor: '#ecfdf5', fontSize: 12, fontWeight: 500, color: '#059669' }}>{ciItem.supportGroup.name}</span>
                    : <span style={{ color: '#c4cad4' }}>—</span>
                } />
                <InfoRow label="Created" value={new Date(ciItem.createdAt).toLocaleDateString()} />
                <InfoRow label="Updated" value={new Date(ciItem.updatedAt).toLocaleDateString()} />

                {/* Divider */}
                {typeFields.length > 0 && (
                  <div style={{ borderTop: '1px solid #e5e7eb', margin: '8px 0' }} />
                )}

                {/* Variable fields per CI type */}
                {typeFields.map((field) => (
                  <InfoRow key={field} label={FIELD_LABELS[field] ?? field} value={renderFieldValue(field)} />
                ))}
              </Card>
            )
          })()}

          {/* Actions */}
          <Card title="Actions">
            <button
              onClick={() => setDialogOpen(true)}
              style={{ width: '100%', padding: '9px 16px', backgroundColor: '#4f46e5', color: '#ffffff', border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 500, cursor: 'pointer' }}
            >
              + Add Dependency
            </button>
          </Card>
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
              {(cisData?.configurationItems ?? [])
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
