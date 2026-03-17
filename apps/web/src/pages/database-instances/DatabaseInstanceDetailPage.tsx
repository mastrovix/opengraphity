import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@apollo/client/react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { StatusBadge } from '@/components/StatusBadge'
import { CountBadge } from '@/components/ui/CountBadge'
import { GET_DATABASE_INSTANCE, GET_BLAST_RADIUS } from '@/graphql/queries'
import { ciPath } from '@/lib/ciPath'
import { DetailField } from '@/components/ui/DetailField'
import { CIGraph } from '@/components/CIGraph'
import { CIIncidentsCard } from '@/components/CIIncidentsCard'
import { CIChangesCard } from '@/components/CIChangesCard'

interface CIRef { id: string; name: string; type: string; status: string | null; environment: string | null }
interface CIRelation { relation: string; ci: CIRef }
interface Team { id: string; name: string }
interface DBInstanceDetail {
  id: string; name: string; type: string; status: string | null; environment: string | null
  description: string | null; createdAt: string; updatedAt: string | null; notes: string | null
  ipAddress: string | null; port: string | null; instanceType: string | null; version: string | null
  ownerGroup: Team | null; supportGroup: Team | null; dependencies: CIRelation[]; dependents: CIRelation[]
}

const InfoField = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div>
    <div style={{ fontSize: 11, color: '#8892a4', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>{label}</div>
    <div style={{ fontSize: 13, fontWeight: 500, color: '#111827' }}>{children}</div>
  </div>
)

export function DatabaseInstanceDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [depsOpen, setDepsOpen] = useState(false)
  const [depentsOpen, setDepentsOpen] = useState(false)
  const [graphOpen, setGraphOpen] = useState(false)

  const { data, loading } = useQuery<{ databaseInstance: DBInstanceDetail | null }>(GET_DATABASE_INSTANCE, { variables: { id }, skip: !id })
  const { data: brData } = useQuery<{ blastRadius: { distance: number; parentId: string | null; ci: { id: string; name: string; type: string; environment: string | null; status: string | null } }[] }>(
    GET_BLAST_RADIUS,
    { variables: { id }, skip: !id }
  )
  const blastRadius = brData?.blastRadius ?? []

  if (loading) return <div style={{ padding: 40, color: '#8892a4', fontSize: 14 }}>Loading…</div>

  const dbi = data?.databaseInstance
  if (!dbi) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 200, gap: 12 }}>
        <p style={{ color: '#8892a4', fontSize: 14 }}>DB Instance non trovata.</p>
        <button onClick={() => navigate('/database-instances')} style={{ color: '#4f46e5', background: 'none', border: 'none', fontSize: 14, cursor: 'pointer' }}>← Torna alle DB Instance</button>
      </div>
    )
  }

  return (
    <div>
      <button onClick={() => navigate('/database-instances')} style={{ display: 'inline-flex', gap: 6, color: '#8892a4', background: 'none', border: 'none', fontSize: 13, cursor: 'pointer', padding: 0, marginBottom: 12 }}>← DB Instance</button>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <span style={{ fontSize: 24 }}>🗄</span>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0f1629', margin: 0 }}>{dbi.name}</h1>
        {dbi.status && <StatusBadge value={dbi.status} />}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 16 }}>
        <div>
          {dbi.description && (
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '16px 20px', marginBottom: 16 }}>
              <h3 style={{ fontSize: 13, fontWeight: 600, color: '#8892a4', textTransform: 'uppercase', letterSpacing: '0.04em', margin: '0 0 8px' }}>Descrizione</h3>
              <p style={{ fontSize: 14, color: '#374151', margin: 0 }}>{dbi.description}</p>
            </div>
          )}
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '16px 20px', marginBottom: 16 }}>
            <h3 style={{ fontSize: 13, fontWeight: 600, color: '#8892a4', textTransform: 'uppercase', letterSpacing: '0.04em', margin: '0 0 16px' }}>Info Tecniche</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 24px' }}>
              <DetailField label="IP Address" value={dbi.ipAddress ?? null} />
              <DetailField label="Port" value={dbi.port ?? null} />
              <DetailField label="Instance Type" value={dbi.instanceType ?? null} />
              <DetailField label="Version" value={dbi.version ?? null} />
              <div style={{ gridColumn: '1 / -1' }}><DetailField label="Note" value={dbi.notes ?? null} /></div>
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
                  centerCI={{ id: dbi.id, name: dbi.name, type: dbi.type, status: dbi.status ?? 'unknown', environment: dbi.environment ?? undefined }}
                  dependencies={dbi.dependencies.map(r => ({ relationType: r.relation, ci: { id: r.ci.id, name: r.ci.name, type: r.ci.type, status: r.ci.status ?? 'unknown', environment: r.ci.environment ?? undefined } }))}
                  dependents={dbi.dependents.map(r => ({ relationType: r.relation, ci: { id: r.ci.id, name: r.ci.name, type: r.ci.type, status: r.ci.status ?? 'unknown', environment: r.ci.environment ?? undefined } }))}
                  blastRadius={blastRadius.map(b => ({ ...b.ci, status: b.ci.status ?? 'unknown', environment: b.ci.environment ?? undefined, distance: b.distance, parentId: b.parentId }))}
                />
              </div>
            )}
          </div>

          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 20, marginBottom: 16 }}>
            <div onClick={() => setDepsOpen(v => !v)} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, color: '#0f1629', margin: 0, display: 'flex', alignItems: 'center' }}>Dipendenze <CountBadge count={dbi.dependencies.length} /></h3>
              {depsOpen ? <ChevronDown size={16} color="#8892a4" /> : <ChevronRight size={16} color="#8892a4" />}
            </div>
            {depsOpen && (
              <div style={{ marginTop: 12 }}>
                {dbi.dependencies.length === 0
                  ? <p style={{ fontSize: 13, color: '#8892a4', margin: 0 }}>Nessuna dipendenza.</p>
                  : (() => {
                      const grouped = dbi.dependencies.reduce((acc, rel) => {
                        if (!acc[rel.relation]) acc[rel.relation] = []
                        acc[rel.relation].push(rel)
                        return acc
                      }, {} as Record<string, typeof dbi.dependencies>)
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
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 20, marginBottom: 16 }}>
            <div onClick={() => setDepentsOpen(v => !v)} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, color: '#0f1629', margin: 0, display: 'flex', alignItems: 'center' }}>Dipendenti <CountBadge count={dbi.dependents.length} /></h3>
              {depentsOpen ? <ChevronDown size={16} color="#8892a4" /> : <ChevronRight size={16} color="#8892a4" />}
            </div>
            {depentsOpen && (
              <div style={{ marginTop: 12 }}>
                {dbi.dependents.length === 0
                  ? <p style={{ fontSize: 13, color: '#8892a4', margin: 0 }}>Nessun dipendente.</p>
                  : (() => {
                      const grouped = dbi.dependents.reduce((acc, rel) => {
                        if (!acc[rel.relation]) acc[rel.relation] = []
                        acc[rel.relation].push(rel)
                        return acc
                      }, {} as Record<string, typeof dbi.dependents>)
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
          <CIIncidentsCard ciId={dbi.id} />
          <CIChangesCard ciId={dbi.id} />
        </div>
        <div>
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '16px 20px' }}>
            <h3 style={{ fontSize: 13, fontWeight: 600, color: '#8892a4', textTransform: 'uppercase', letterSpacing: '0.04em', margin: '0 0 16px' }}>Dettagli</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <DetailField label="ID" value={dbi.id} mono />
              <DetailField label="Tipo" value={dbi.type} />
              <DetailField label="Environment" value={dbi.environment ?? null} />
              {dbi.status      && <InfoField label="Status"><StatusBadge value={dbi.status} /></InfoField>}
              <InfoField label="Owner Group">{dbi.ownerGroup ? <span style={{ padding: '2px 8px', borderRadius: 100, backgroundColor: '#eef2ff', fontSize: 12, fontWeight: 500, color: '#4f46e5' }}>{dbi.ownerGroup.name}</span> : <span style={{ color: '#c4cad4' }}>—</span>}</InfoField>
              <InfoField label="Support Group">{dbi.supportGroup ? <span style={{ padding: '2px 8px', borderRadius: 100, backgroundColor: '#ecfdf5', fontSize: 12, fontWeight: 500, color: '#059669' }}>{dbi.supportGroup.name}</span> : <span style={{ color: '#c4cad4' }}>—</span>}</InfoField>
              <DetailField label="Creato" value={new Date(dbi.createdAt).toLocaleDateString('it-IT')} />
              <DetailField label="Aggiornato" value={dbi.updatedAt ? new Date(dbi.updatedAt).toLocaleDateString('it-IT') : null} />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
