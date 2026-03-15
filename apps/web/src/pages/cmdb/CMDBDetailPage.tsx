import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@apollo/client/react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { StatusBadge } from '@/components/StatusBadge'
import { TypeBadge } from '@/components/Badges'
import { CountBadge } from '@/components/ui/CountBadge'
import { GET_CI_BY_ID } from '@/graphql/queries'

interface CIRef {
  id:          string
  name:        string
  type:        string
  status:      string | null
  environment: string | null
}

interface Team {
  id:   string
  name: string
}

interface CIDetail {
  id:           string
  name:         string
  type:         string
  __typename:   string
  status:       string | null
  environment:  string | null
  description:  string | null
  createdAt:    string
  updatedAt:    string | null
  notes:        string | null
  ownerGroup:   Team | null
  supportGroup: Team | null
  // Application
  url?:     string | null
  version?: string | null
  vendor?:  string | null
  // Database / DatabaseInstance
  port?:    string | null
  // DatabaseInstance
  ipAddress?: string | null
  dbVersion?: string | null
  // Server
  location?:  string | null
  osVersion?: string | null
  // Certificate
  serialNumber?:    string | null
  expiresAt?:       string | null
  certificateType?: string | null
  // relations
  dependencies?: CIRef[]
  dependents?:   CIRef[]
}

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
  certificate:       '🔒',
  ssl_certificate:   '🔒',
  api_endpoint:      '🔌',
}

function ciPath(id: string, type: string): string {
  switch (type) {
    case 'application':        return `/applications/${id}`
    case 'database':           return `/databases/${id}`
    case 'database_instance':  return `/database-instances/${id}`
    case 'server':             return `/servers/${id}`
    case 'certificate':        return `/certificates/${id}`
    default:                   return `/cmdb/${id}`
  }
}

function CIRow({ ci, onClick }: { ci: CIRef; onClick?: () => void }) {
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
          {ci.type.replace(/_/g, ' ')} {ci.environment ? `· ${ci.environment}` : ''}
        </div>
      </div>
      {ci.status && <StatusBadge value={ci.status} />}
    </div>
  )
}

const InfoField = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div>
    <div style={{ fontSize: 11, color: '#8892a4', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>{label}</div>
    <div style={{ fontSize: 13, fontWeight: 500, color: '#111827' }}>{children}</div>
  </div>
)

export function CMDBDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [infoOpen,    setInfoOpen]    = useState(true)
  const [depsOpen,    setDepsOpen]    = useState(false)
  const [depentsOpen, setDepentsOpen] = useState(false)

  const { data, loading } = useQuery<{ ciById: CIDetail | null }, { id: string | undefined }>(
    GET_CI_BY_ID,
    { variables: { id }, skip: !id },
  )

  const ci = data?.ciById

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

  const dependencies = ci.dependencies ?? []
  const dependents   = ci.dependents   ?? []

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
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 24 }}>{TYPE_ICON[ci.type] ?? '📄'}</span>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0f1629', letterSpacing: '-0.01em', margin: 0 }}>
            {ci.name}
          </h1>
          <TypeBadge type={ci.type} />
          {ci.status && <StatusBadge value={ci.status} />}
        </div>
      </div>

      {/* Information card */}
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, marginBottom: 16 }}>
        <div
          onClick={() => setInfoOpen((v) => !v)}
          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 20px', cursor: 'pointer', borderBottom: infoOpen ? '1px solid #e5e7eb' : 'none', borderRadius: infoOpen ? '10px 10px 0 0' : 10 }}
        >
          <h3 style={{ fontSize: 14, fontWeight: 600, color: '#0f1629', margin: 0 }}>Informazioni</h3>
          {infoOpen ? <ChevronDown size={16} color="#8892a4" /> : <ChevronRight size={16} color="#8892a4" />}
        </div>

        {infoOpen && (
          <div style={{ padding: '16px 20px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px 32px' }}>
            {/* ID — full width */}
            <div style={{ gridColumn: '1 / -1' }}>
              <InfoField label="ID">
                <span style={{ fontFamily: 'DM Mono, monospace', fontSize: 12, cursor: 'default', display: 'block', maxWidth: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {ci.id}
                </span>
              </InfoField>
            </div>
            <InfoField label="Tipo"><TypeBadge type={ci.type} /></InfoField>
            {ci.status && <InfoField label="Status"><StatusBadge value={ci.status} /></InfoField>}
            {ci.environment && (
              <InfoField label="Environment"><span style={{ textTransform: 'capitalize' }}>{ci.environment}</span></InfoField>
            )}
            <InfoField label="Creato">{new Date(ci.createdAt).toLocaleDateString('it-IT')}</InfoField>
            {ci.updatedAt && (
              <InfoField label="Aggiornato">{new Date(ci.updatedAt).toLocaleDateString('it-IT')}</InfoField>
            )}
            <InfoField label="Owner Group">
              {ci.ownerGroup
                ? <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 100, backgroundColor: '#eef2ff', fontSize: 12, fontWeight: 500, color: '#4f46e5' }}>{ci.ownerGroup.name}</span>
                : <span style={{ color: '#c4cad4' }}>—</span>}
            </InfoField>
            <InfoField label="Support Group">
              {ci.supportGroup
                ? <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 100, backgroundColor: '#ecfdf5', fontSize: 12, fontWeight: 500, color: '#059669' }}>{ci.supportGroup.name}</span>
                : <span style={{ color: '#c4cad4' }}>—</span>}
            </InfoField>
            {/* Description */}
            {ci.description && (
              <div style={{ gridColumn: '1 / -1' }}>
                <InfoField label="Descrizione">{ci.description}</InfoField>
              </div>
            )}
            {/* Notes */}
            {ci.notes && (
              <div style={{ gridColumn: '1 / -1' }}>
                <InfoField label="Note">{ci.notes}</InfoField>
              </div>
            )}

            {/* Application fields */}
            {ci.__typename === 'Application' && (
              <>
                {ci.url     && <InfoField label="URL">{ci.url}</InfoField>}
                {ci.version && <InfoField label="Version">{ci.version}</InfoField>}
                {ci.vendor  && <InfoField label="Vendor">{ci.vendor}</InfoField>}
              </>
            )}

            {/* Database fields */}
            {ci.__typename === 'Database' && (
              <>
                {ci.port && <InfoField label="Port">{ci.port}</InfoField>}
              </>
            )}

            {/* DatabaseInstance fields */}
            {ci.__typename === 'DatabaseInstance' && (
              <>
                {ci.ipAddress && <InfoField label="IP Address">{ci.ipAddress}</InfoField>}
                {ci.port      && <InfoField label="Port">{ci.port}</InfoField>}
                {ci.vendor    && <InfoField label="Vendor">{ci.vendor}</InfoField>}
                {ci.dbVersion && <InfoField label="DB Version">{ci.dbVersion}</InfoField>}
              </>
            )}

            {/* Server fields */}
            {ci.__typename === 'Server' && (
              <>
                {ci.ipAddress  && <InfoField label="IP Address">{ci.ipAddress}</InfoField>}
                {ci.location   && <InfoField label="Location">{ci.location}</InfoField>}
                {ci.vendor     && <InfoField label="Vendor">{ci.vendor}</InfoField>}
                {ci.osVersion  && <InfoField label="OS Version">{ci.osVersion}</InfoField>}
              </>
            )}

            {/* Certificate fields */}
            {ci.__typename === 'Certificate' && (
              <>
                {ci.serialNumber    && <InfoField label="Serial Number">{ci.serialNumber}</InfoField>}
                {ci.expiresAt       && <InfoField label="Scadenza">{new Date(ci.expiresAt).toLocaleDateString('it-IT')}</InfoField>}
                {ci.certificateType && <InfoField label="Tipo Certificato">{ci.certificateType}</InfoField>}
              </>
            )}
          </div>
        )}
      </div>

      {/* Dependencies */}
      {ci.__typename !== 'Certificate' && (
        <>
          <div style={{ backgroundColor: '#ffffff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20, marginBottom: 16 }}>
            <div
              onClick={() => setDepsOpen((v) => !v)}
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', margin: 0 }}
            >
              <h3 style={{ fontSize: 14, fontWeight: 600, color: '#0f1629', margin: 0, display: 'flex', alignItems: 'center' }}>
                Dipendenze
                <CountBadge count={dependencies.length} />
              </h3>
              {depsOpen ? <ChevronDown size={16} color="#8892a4" /> : <ChevronRight size={16} color="#8892a4" />}
            </div>
            {depsOpen && (
              <div style={{ marginTop: 16 }}>
                {dependencies.length === 0 ? (
                  <p style={{ fontSize: 13, color: '#8892a4', margin: 0 }}>Nessuna dipendenza.</p>
                ) : (
                  dependencies.map((dep) => (
                    <CIRow key={dep.id} ci={dep} onClick={() => navigate(ciPath(dep.id, dep.type))} />
                  ))
                )}
              </div>
            )}
          </div>

          <div style={{ backgroundColor: '#ffffff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20, marginBottom: 16 }}>
            <div
              onClick={() => setDepentsOpen((v) => !v)}
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', margin: 0 }}
            >
              <h3 style={{ fontSize: 14, fontWeight: 600, color: '#0f1629', margin: 0, display: 'flex', alignItems: 'center' }}>
                Dipendenti
                <CountBadge count={dependents.length} />
              </h3>
              {depentsOpen ? <ChevronDown size={16} color="#8892a4" /> : <ChevronRight size={16} color="#8892a4" />}
            </div>
            {depentsOpen && (
              <div style={{ marginTop: 16 }}>
                {dependents.length === 0 ? (
                  <p style={{ fontSize: 13, color: '#8892a4', margin: 0 }}>Nessun dipendente.</p>
                ) : (
                  dependents.map((dep) => (
                    <CIRow key={dep.id} ci={dep} onClick={() => navigate(ciPath(dep.id, dep.type))} />
                  ))
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
