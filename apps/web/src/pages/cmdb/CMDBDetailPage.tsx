import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@apollo/client/react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { StatusBadge } from '@/components/StatusBadge'
import { TypeBadge } from '@/components/Badges'
import { CountBadge } from '@/components/ui/CountBadge'
import { GET_CI_BY_ID } from '@/graphql/queries'
import { ciPath } from '@/lib/ciPath'
import { DetailField } from '@/components/ui/DetailField'
import { CIGraph } from '@/components/CIGraph'

interface CIRef {
  id:          string
  name:        string
  type:        string
  status:      string | null
  environment: string | null
}

interface CIRelation {
  relation: string
  ci:       CIRef
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
  vendor?:       string | null
  instanceType?: string | null
  // Database / DatabaseInstance
  port?:    string | null
  // DatabaseInstance / Server
  ipAddress?: string | null
  version?: string | null
  // Server
  location?:  string | null
  os?: string | null
  // Certificate
  serialNumber?:    string | null
  expiresAt?:       string | null
  certificateType?: string | null
  // relations
  dependencies?: CIRelation[]
  dependents?:   CIRelation[]
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
  const [graphOpen,   setGraphOpen]   = useState(false)
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
              <DetailField label="ID" value={ci.id} mono />
            </div>
            <DetailField label="Tipo" value={ci.type} />
            {ci.status && <InfoField label="Status"><StatusBadge value={ci.status} /></InfoField>}
            <DetailField label="Environment" value={ci.environment ?? null} />
            <DetailField label="Creato" value={new Date(ci.createdAt).toLocaleDateString('it-IT')} />
            <DetailField label="Aggiornato" value={ci.updatedAt ? new Date(ci.updatedAt).toLocaleDateString('it-IT') : null} />
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
            <div style={{ gridColumn: '1 / -1' }}>
              <DetailField label="Descrizione" value={ci.description ?? null} />
            </div>
            {/* Notes */}
            <div style={{ gridColumn: '1 / -1' }}>
              <DetailField label="Note" value={ci.notes ?? null} />
            </div>

            {/* Application fields */}
            {ci.__typename === 'Application' && (
              <>
                <DetailField label="URL" value={ci.url ?? null} />
              </>
            )}

            {/* Database fields */}
            {ci.__typename === 'Database' && (
              <>
                <DetailField label="Port" value={ci.port ?? null} />
                <DetailField label="Instance Type" value={ci.instanceType ?? null} />
              </>
            )}

            {/* DatabaseInstance fields */}
            {ci.__typename === 'DatabaseInstance' && (
              <>
                <DetailField label="IP Address" value={ci.ipAddress ?? null} />
                <DetailField label="Port" value={ci.port ?? null} />
                <DetailField label="Instance Type" value={ci.instanceType ?? null} />
                <DetailField label="Version" value={ci.version ?? null} />
              </>
            )}

            {/* Server fields */}
            {ci.__typename === 'Server' && (
              <>
                <DetailField label="IP Address" value={ci.ipAddress ?? null} />
                <DetailField label="Location" value={ci.location ?? null} />
                <DetailField label="Vendor" value={ci.vendor ?? null} />
                <DetailField label="OS" value={ci.os ?? null} />
                <DetailField label="Version" value={ci.version ?? null} />
              </>
            )}

            {/* Certificate fields */}
            {ci.__typename === 'Certificate' && (
              <>
                <DetailField label="Serial Number" value={ci.serialNumber ?? null} />
                {ci.expiresAt && <InfoField label="Scadenza">{new Date(ci.expiresAt).toLocaleDateString('it-IT')}</InfoField>}
                <DetailField label="Tipo Certificato" value={ci.certificateType ?? null} />
              </>
            )}
          </div>
        )}
      </div>

      {/* Dependency Graph */}
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, marginBottom: 16 }}>
        <div
          onClick={() => setGraphOpen((v) => !v)}
          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 20px', cursor: 'pointer', borderBottom: graphOpen ? '1px solid #e5e7eb' : 'none', borderRadius: graphOpen ? '10px 10px 0 0' : 10 }}
        >
          <h3 style={{ fontSize: 14, fontWeight: 600, color: '#0f1629', margin: 0 }}>Mappa Dipendenze</h3>
          {graphOpen ? <ChevronDown size={16} color="#8892a4" /> : <ChevronRight size={16} color="#8892a4" />}
        </div>
        {graphOpen && ci && (
          <CIGraph
            centerCI={{ id: ci.id, name: ci.name, type: ci.type, status: ci.status ?? 'unknown', environment: ci.environment ?? undefined }}
            dependencies={(ci.dependencies ?? []).map(r => ({ relationType: r.relation, ci: { id: r.ci.id, name: r.ci.name, type: r.ci.type, status: r.ci.status ?? 'unknown', environment: r.ci.environment ?? undefined } }))}
            dependents={(ci.dependents ?? []).map(r => ({ relationType: r.relation, ci: { id: r.ci.id, name: r.ci.name, type: r.ci.type, status: r.ci.status ?? 'unknown', environment: r.ci.environment ?? undefined } }))}
            blastRadius={[]}
          />
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
                {dependencies.length === 0
                  ? <p style={{ fontSize: 13, color: '#8892a4', margin: 0 }}>Nessuna dipendenza.</p>
                  : (() => {
                      const grouped = dependencies.reduce((acc, rel) => {
                        if (!acc[rel.relation]) acc[rel.relation] = []
                        acc[rel.relation].push(rel)
                        return acc
                      }, {} as Record<string, typeof dependencies>)
                      return Object.entries(grouped).map(([relation, rels]) => (
                        <div key={relation} style={{ marginBottom: 12 }}>
                          <div style={{
                            fontSize: 11, fontWeight: 600,
                            color: '#64748b',
                            textTransform: 'uppercase' as const,
                            letterSpacing: '0.06em',
                            padding: '8px 0 4px 0',
                            marginBottom: 6,
                          }}>
                            {relation.replace(/_/g, ' ')}
                          </div>
                          <div style={{ paddingLeft: 12, borderLeft: '2px solid #f3f4f6', marginLeft: 4 }}>
                            {rels.map(rel => (
                              <div key={rel.ci.id}
                                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid #f9fafb', cursor: 'pointer' }}
                                onClick={() => navigate(ciPath(rel.ci))}>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ fontSize: 13, fontWeight: 600, color: '#0f1629', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{rel.ci.name}</div>
                                  <div style={{ fontSize: 12, color: '#8892a4', textTransform: 'capitalize' as const }}>{rel.ci.type.replace(/_/g, ' ')}{rel.ci.environment ? ` · ${rel.ci.environment}` : ''}</div>
                                </div>
                                {rel.ci.status && <StatusBadge value={rel.ci.status} />}
                              </div>
                            ))}
                          </div>
                        </div>
                      ))
                    })()
                }
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
                {dependents.length === 0
                  ? <p style={{ fontSize: 13, color: '#8892a4', margin: 0 }}>Nessun dipendente.</p>
                  : (() => {
                      const grouped = dependents.reduce((acc, rel) => {
                        if (!acc[rel.relation]) acc[rel.relation] = []
                        acc[rel.relation].push(rel)
                        return acc
                      }, {} as Record<string, typeof dependents>)
                      return Object.entries(grouped).map(([relation, rels]) => (
                        <div key={relation} style={{ marginBottom: 12 }}>
                          <div style={{
                            fontSize: 11, fontWeight: 600,
                            color: '#64748b',
                            textTransform: 'uppercase' as const,
                            letterSpacing: '0.06em',
                            padding: '8px 0 4px 0',
                            marginBottom: 6,
                          }}>
                            {relation.replace(/_/g, ' ')}
                          </div>
                          <div style={{ paddingLeft: 12, borderLeft: '2px solid #f3f4f6', marginLeft: 4 }}>
                            {rels.map(rel => (
                              <div key={rel.ci.id}
                                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid #f9fafb', cursor: 'pointer' }}
                                onClick={() => navigate(ciPath(rel.ci))}>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ fontSize: 13, fontWeight: 600, color: '#0f1629', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{rel.ci.name}</div>
                                  <div style={{ fontSize: 12, color: '#8892a4', textTransform: 'capitalize' as const }}>{rel.ci.type.replace(/_/g, ' ')}{rel.ci.environment ? ` · ${rel.ci.environment}` : ''}</div>
                                </div>
                                {rel.ci.status && <StatusBadge value={rel.ci.status} />}
                              </div>
                            ))}
                          </div>
                        </div>
                      ))
                    })()
                }
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
