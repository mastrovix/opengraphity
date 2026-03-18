import { useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@apollo/client/react'
import { gql } from '@apollo/client'
import { useMetamodel } from '@/contexts/MetamodelContext'
import { StatusBadge } from '@/components/StatusBadge'
import { DetailField } from '@/components/ui/DetailField'
import { CollapsibleCard } from '@/components/ui/CollapsibleCard'
import { CIGraph } from '@/components/CIGraph'
import { CIIncidentsCard } from '@/components/CIIncidentsCard'
import { CIChangesCard } from '@/components/CIChangesCard'
import { CIIcon } from '@/lib/ciIcon'
import { ciPath } from '@/lib/ciPath'
import { GET_BLAST_RADIUS } from '@/graphql/queries'

// ── Types ─────────────────────────────────────────────────────────────────────

const BASE_TYPE_FIELDS = new Set([
  'id', 'name', 'type', 'status', 'environment',
  'description', 'createdAt', 'updatedAt', 'notes',
  'ownerGroup', 'supportGroup', 'dependencies', 'dependents',
])

interface CIRef {
  id: string; name: string; type: string
  status: string | null; environment: string | null
}

interface CIRelation { relation: string; ci: CIRef }

interface Team { id: string; name: string }

interface CIDetail {
  id: string; name: string; type: string
  status: string | null; environment: string | null
  description: string | null; createdAt: string
  updatedAt: string | null; notes: string | null
  ownerGroup: Team | null; supportGroup: Team | null
  dependencies: CIRelation[]; dependents: CIRelation[]
  [key: string]: unknown
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toPascalCase(str: string): string {
  return str.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('')
}

function RelationList({
  relations,
  navigate,
}: {
  relations: CIRelation[]
  navigate: (path: string) => void
}) {
  const grouped = relations.reduce<Record<string, CIRelation[]>>((acc, rel) => {
    ;(acc[rel.relation] ??= []).push(rel)
    return acc
  }, {})

  return (
    <>
      {Object.entries(grouped).map(([relation, rels]) => (
        <div key={relation} style={{ marginBottom: 12 }}>
          <div style={{
            fontSize: 11, fontWeight: 600, color: '#64748b',
            textTransform: 'uppercase', letterSpacing: '0.06em',
            padding: '8px 0 4px', marginBottom: 6,
          }}>
            {relation.replace(/_/g, ' ')}
          </div>
          <div style={{ paddingLeft: 12, borderLeft: '2px solid #f3f4f6', marginLeft: 4 }}>
            {rels.map(rel => (
              <div
                key={rel.ci.id}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid #f9fafb', cursor: 'pointer' }}
                onClick={() => navigate(ciPath(rel.ci))}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#0f1629', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {rel.ci.name}
                  </div>
                  <div style={{ fontSize: 12, color: '#8892a4', textTransform: 'capitalize' }}>
                    {rel.ci.type.replace(/_/g, ' ')}{rel.ci.environment ? ` · ${rel.ci.environment}` : ''}
                  </div>
                </div>
                {rel.ci.status && <StatusBadge value={rel.ci.status} />}
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

export function CIDetailPage() {
  const { typeName, id } = useParams<{ typeName: string; id: string }>()
  const navigate = useNavigate()
  const { getCIType, loading: metamodelLoading } = useMetamodel()

  const ciType = typeName ? getCIType(typeName) : undefined

  const specificFields = useMemo(
    () => ciType?.fields.filter(f => !BASE_TYPE_FIELDS.has(f.name)).sort((a, b) => a.order - b.order) ?? [],
    [ciType],
  )

  const detailQuery = useMemo(() => {
    if (!typeName || !ciType) return null
    const pascal = toPascalCase(typeName)
    const specificFieldsStr = specificFields.map(f => f.name).join('\n          ')
    return gql`
      query DynamicDetail_${pascal}($id: ID!) {
        ${typeName}(id: $id) {
          id name type status environment description createdAt updatedAt notes
          ownerGroup { id name }
          supportGroup { id name }
          dependencies { relation ci { id name type environment status } }
          dependents { relation ci { id name type environment status } }
          ${specificFieldsStr}
        }
      }
    `
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeName, specificFields.map(f => f.name).join(',')])

  const { data, loading } = useQuery<Record<string, CIDetail | null>>(
    detailQuery ?? gql`query EmptyCIDetail { __typename }`,
    { variables: { id }, skip: !detailQuery || !id },
  )

  const { data: brData } = useQuery<{
    blastRadius: { distance: number; parentId: string | null; ci: { id: string; name: string; type: string; environment: string | null; status: string | null } }[]
  }>(GET_BLAST_RADIUS, { variables: { id }, skip: !id })

  const blastRadius = brData?.blastRadius ?? []
  const ci = typeName && data ? data[typeName] : undefined

  if (metamodelLoading || loading) {
    return <div style={{ padding: 40, color: '#8892a4', fontSize: 14 }}>Caricamento…</div>
  }
  if (!ciType) {
    return <div style={{ padding: 40, color: '#dc2626', fontSize: 14 }}>Tipo CI "{typeName}" non trovato.</div>
  }
  if (!ci) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 200, gap: 12 }}>
        <p style={{ color: '#8892a4', fontSize: 14 }}>CI non trovato.</p>
        <button
          onClick={() => navigate(`/ci/${typeName}`)}
          style={{ color: '#4f46e5', background: 'none', border: 'none', fontSize: 14, cursor: 'pointer' }}
        >
          ← Torna a {ciType.label}
        </button>
      </div>
    )
  }

  return (
    <div>
      <button
        onClick={() => navigate(`/ci/${typeName}`)}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: '#8892a4', background: 'none', border: 'none', fontSize: 13, cursor: 'pointer', padding: 0, marginBottom: 12 }}
      >
        ← {ciType.label}
      </button>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
        <CIIcon icon={ciType.icon} size={24} color={ciType.color} />
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0f1629', margin: 0 }}>{ci.name}</h1>
        {ci.status && <StatusBadge value={ci.status} />}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 16 }}>
        {/* Left column */}
        <div>
          {ci.description && (
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '16px 20px', marginBottom: 16 }}>
              <h3 style={{ fontSize: 13, fontWeight: 600, color: '#8892a4', textTransform: 'uppercase', letterSpacing: '0.04em', margin: '0 0 8px' }}>
                Descrizione
              </h3>
              <p style={{ fontSize: 14, color: '#374151', margin: 0, lineHeight: 1.6 }}>{ci.description}</p>
            </div>
          )}

          {specificFields.length > 0 && (
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '16px 20px', marginBottom: 16 }}>
              <h3 style={{ fontSize: 13, fontWeight: 600, color: '#8892a4', textTransform: 'uppercase', letterSpacing: '0.04em', margin: '0 0 16px' }}>
                Dettagli {ciType.label}
              </h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 24px' }}>
                {specificFields.map(field => (
                  <DetailField
                    key={field.name}
                    label={field.label}
                    value={ci[field.name] !== null && ci[field.name] !== undefined ? String(ci[field.name]) : null}
                  />
                ))}
              </div>
            </div>
          )}

          <CollapsibleCard title="Mappa Dipendenze">
            <CIGraph
              centerCI={{
                id: ci.id, name: ci.name, type: ci.type,
                status: ci.status ?? 'unknown', environment: ci.environment ?? undefined,
              }}
              dependencies={(ci.dependencies as CIRelation[]).map(r => ({
                relationType: r.relation,
                ci: { id: r.ci.id, name: r.ci.name, type: r.ci.type, status: r.ci.status ?? 'unknown', environment: r.ci.environment ?? undefined },
              }))}
              dependents={(ci.dependents as CIRelation[]).map(r => ({
                relationType: r.relation,
                ci: { id: r.ci.id, name: r.ci.name, type: r.ci.type, status: r.ci.status ?? 'unknown', environment: r.ci.environment ?? undefined },
              }))}
              blastRadius={blastRadius.map(b => ({
                ...b.ci,
                status: b.ci.status ?? 'unknown',
                environment: b.ci.environment ?? undefined,
                distance: b.distance, parentId: b.parentId,
              }))}
            />
          </CollapsibleCard>

          <CollapsibleCard title="Dipendenze" count={(ci.dependencies as CIRelation[]).length}>
            {(ci.dependencies as CIRelation[]).length === 0
              ? <p style={{ fontSize: 13, color: '#8892a4', margin: 0 }}>Nessuna dipendenza.</p>
              : <RelationList relations={ci.dependencies as CIRelation[]} navigate={navigate} />}
          </CollapsibleCard>

          <CollapsibleCard title="Dipendenti" count={(ci.dependents as CIRelation[]).length}>
            {(ci.dependents as CIRelation[]).length === 0
              ? <p style={{ fontSize: 13, color: '#8892a4', margin: 0 }}>Nessun dipendente.</p>
              : <RelationList relations={ci.dependents as CIRelation[]} navigate={navigate} />}
          </CollapsibleCard>

          <CIIncidentsCard ciId={ci.id} />
          <CIChangesCard ciId={ci.id} />
        </div>

        {/* Right column */}
        <div>
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '16px 20px' }}>
            <h3 style={{ fontSize: 13, fontWeight: 600, color: '#8892a4', textTransform: 'uppercase', letterSpacing: '0.04em', margin: '0 0 16px' }}>
              Dettagli
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <DetailField label="ID" value={ci.id} mono />
              <DetailField label="Tipo" value={ciType.label} />
              <DetailField label="Environment" value={ci.environment ?? null} />
              {ci.ownerGroup && (
                <div>
                  <div style={{ fontSize: 11, color: '#8892a4', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>Owner Group</div>
                  <span style={{ padding: '2px 8px', borderRadius: 100, backgroundColor: '#eef2ff', fontSize: 12, fontWeight: 500, color: '#4f46e5' }}>
                    {(ci.ownerGroup as Team).name}
                  </span>
                </div>
              )}
              {ci.supportGroup && (
                <div>
                  <div style={{ fontSize: 11, color: '#8892a4', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>Support Group</div>
                  <span style={{ padding: '2px 8px', borderRadius: 100, backgroundColor: '#ecfdf5', fontSize: 12, fontWeight: 500, color: '#059669' }}>
                    {(ci.supportGroup as Team).name}
                  </span>
                </div>
              )}
              <DetailField label="Creato" value={new Date(ci.createdAt).toLocaleDateString('it-IT')} />
              <DetailField label="Aggiornato" value={ci.updatedAt ? new Date(ci.updatedAt).toLocaleDateString('it-IT') : null} />
              {ci.notes && <DetailField label="Note" value={ci.notes as string} />}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
