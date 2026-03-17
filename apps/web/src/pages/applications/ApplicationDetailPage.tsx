import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@apollo/client/react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { StatusBadge } from '@/components/StatusBadge'
import { CountBadge } from '@/components/ui/CountBadge'
import { GET_APPLICATION, GET_BLAST_RADIUS } from '@/graphql/queries'
import { ciPath } from '@/lib/ciPath'
import { DetailField } from '@/components/ui/DetailField'
import { CIGraph } from '@/components/CIGraph'

interface CIRef {
  id: string
  name: string
  type: string
  status: string | null
  environment: string | null
}

interface CIRelation {
  relation: string
  ci: CIRef
}

interface Team {
  id: string
  name: string
}

interface ApplicationDetail {
  id: string
  name: string
  type: string
  status: string | null
  environment: string | null
  description: string | null
  createdAt: string
  updatedAt: string | null
  notes: string | null
  url: string | null
  ownerGroup: Team | null
  supportGroup: Team | null
  dependencies: CIRelation[]
  dependents: CIRelation[]
}

const InfoField = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div>
    <div style={{ fontSize: 11, color: '#8892a4', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>{label}</div>
    <div style={{ fontSize: 13, fontWeight: 500, color: '#111827' }}>{children}</div>
  </div>
)

export function ApplicationDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [depsOpen, setDepsOpen] = useState(false)
  const [depentsOpen, setDepentsOpen] = useState(false)
  const [graphOpen, setGraphOpen] = useState(false)

  const { data, loading } = useQuery<{ application: ApplicationDetail | null }>(GET_APPLICATION, {
    variables: { id },
    skip: !id,
  })
  const { data: brData } = useQuery<{ blastRadius: { distance: number; parentId: string | null; ci: { id: string; name: string; type: string; environment: string | null; status: string | null } }[] }>(
    GET_BLAST_RADIUS,
    { variables: { id }, skip: !id }
  )
  const blastRadius = brData?.blastRadius ?? []

  if (loading) return <div style={{ padding: 40, color: '#8892a4', fontSize: 14 }}>Loading…</div>

  const app = data?.application
  if (!app) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 200, gap: 12 }}>
        <p style={{ color: '#8892a4', fontSize: 14 }}>Applicazione non trovata.</p>
        <button onClick={() => navigate('/applications')} style={{ color: '#4f46e5', background: 'none', border: 'none', fontSize: 14, cursor: 'pointer' }}>← Torna alle Applicazioni</button>
      </div>
    )
  }

  return (
    <div>
      <button onClick={() => navigate('/applications')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: '#8892a4', background: 'none', border: 'none', fontSize: 13, cursor: 'pointer', padding: 0, marginBottom: 12 }}>
        ← Applicazioni
      </button>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 24 }}>📦</span>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0f1629', margin: 0 }}>{app.name}</h1>
        {app.status && <StatusBadge value={app.status} />}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 16 }}>
        {/* Left column */}
        <div>
          {app.description && (
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '16px 20px', marginBottom: 16 }}>
              <h3 style={{ fontSize: 13, fontWeight: 600, color: '#8892a4', textTransform: 'uppercase', letterSpacing: '0.04em', margin: '0 0 8px' }}>Descrizione</h3>
              <p style={{ fontSize: 14, color: '#374151', margin: 0, lineHeight: 1.6 }}>{app.description}</p>
            </div>
          )}

          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '16px 20px', marginBottom: 16 }}>
            <h3 style={{ fontSize: 13, fontWeight: 600, color: '#8892a4', textTransform: 'uppercase', letterSpacing: '0.04em', margin: '0 0 16px' }}>Info Tecniche</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 24px' }}>
              <DetailField label="URL" value={app.url ?? null} />

              <div style={{ gridColumn: '1 / -1' }}><DetailField label="Note" value={app.notes ?? null} /></div>
            </div>
          </div>

          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, marginBottom: 16, overflow: 'hidden' }}>
            <div
              onClick={() => setGraphOpen(p => !p)}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', padding: '14px 20px', borderBottom: graphOpen ? '1px solid #e5e7eb' : 'none' }}
            >
              <span style={{ fontSize: 14, fontWeight: 600, color: '#111827' }}>Mappa Dipendenze</span>
              {graphOpen ? <ChevronDown size={16} color="#8892a4" /> : <ChevronRight size={16} color="#8892a4" />}
            </div>
            {graphOpen && (
              <div style={{ padding: 16 }}>
                <CIGraph
                  centerCI={{ id: app.id, name: app.name, type: app.type, status: app.status ?? 'unknown', environment: app.environment ?? undefined }}
                  dependencies={app.dependencies.map(r => ({ relationType: r.relation, ci: { id: r.ci.id, name: r.ci.name, type: r.ci.type, status: r.ci.status ?? 'unknown', environment: r.ci.environment ?? undefined } }))}
                  dependents={app.dependents.map(r => ({ relationType: r.relation, ci: { id: r.ci.id, name: r.ci.name, type: r.ci.type, status: r.ci.status ?? 'unknown', environment: r.ci.environment ?? undefined } }))}
                  blastRadius={blastRadius.map(b => ({ ...b.ci, status: b.ci.status ?? 'unknown', environment: b.ci.environment ?? undefined, distance: b.distance, parentId: b.parentId }))}
                />
              </div>
            )}
          </div>

          {/* Dependencies */}
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 20, marginBottom: 16 }}>
            <div onClick={() => setDepsOpen(v => !v)} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, color: '#0f1629', margin: 0, display: 'flex', alignItems: 'center' }}>
                Dipendenze <CountBadge count={app.dependencies.length} />
              </h3>
              {depsOpen ? <ChevronDown size={16} color="#8892a4" /> : <ChevronRight size={16} color="#8892a4" />}
            </div>
            {depsOpen && (
              <div style={{ marginTop: 12 }}>
                {app.dependencies.length === 0
                  ? <p style={{ fontSize: 13, color: '#8892a4', margin: 0 }}>Nessuna dipendenza.</p>
                  : (() => {
                      const grouped = app.dependencies.reduce((acc, rel) => {
                        if (!acc[rel.relation]) acc[rel.relation] = []
                        acc[rel.relation].push(rel)
                        return acc
                      }, {} as Record<string, typeof app.dependencies>)
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

          {/* Dependents */}
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 20, marginBottom: 16 }}>
            <div onClick={() => setDepentsOpen(v => !v)} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, color: '#0f1629', margin: 0, display: 'flex', alignItems: 'center' }}>
                Dipendenti <CountBadge count={app.dependents.length} />
              </h3>
              {depentsOpen ? <ChevronDown size={16} color="#8892a4" /> : <ChevronRight size={16} color="#8892a4" />}
            </div>
            {depentsOpen && (
              <div style={{ marginTop: 12 }}>
                {app.dependents.length === 0
                  ? <p style={{ fontSize: 13, color: '#8892a4', margin: 0 }}>Nessun dipendente.</p>
                  : (() => {
                      const grouped = app.dependents.reduce((acc, rel) => {
                        if (!acc[rel.relation]) acc[rel.relation] = []
                        acc[rel.relation].push(rel)
                        return acc
                      }, {} as Record<string, typeof app.dependents>)
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
        </div>

        {/* Right column */}
        <div>
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '16px 20px' }}>
            <h3 style={{ fontSize: 13, fontWeight: 600, color: '#8892a4', textTransform: 'uppercase', letterSpacing: '0.04em', margin: '0 0 16px' }}>Dettagli</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <DetailField label="ID" value={app.id} mono />
              <DetailField label="Tipo" value={app.type} />
              <DetailField label="Environment" value={app.environment ?? null} />
              {app.status      && <InfoField label="Status"><StatusBadge value={app.status} /></InfoField>}
              <InfoField label="Owner Group">
                {app.ownerGroup
                  ? <span style={{ padding: '2px 8px', borderRadius: 100, backgroundColor: '#eef2ff', fontSize: 12, fontWeight: 500, color: '#4f46e5' }}>{app.ownerGroup.name}</span>
                  : <span style={{ color: '#c4cad4' }}>—</span>}
              </InfoField>
              <InfoField label="Support Group">
                {app.supportGroup
                  ? <span style={{ padding: '2px 8px', borderRadius: 100, backgroundColor: '#ecfdf5', fontSize: 12, fontWeight: 500, color: '#059669' }}>{app.supportGroup.name}</span>
                  : <span style={{ color: '#c4cad4' }}>—</span>}
              </InfoField>
              <DetailField label="Creato" value={new Date(app.createdAt).toLocaleDateString('it-IT')} />
              <DetailField label="Aggiornato" value={app.updatedAt ? new Date(app.updatedAt).toLocaleDateString('it-IT') : null} />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
