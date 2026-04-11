import { useMemo, useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { PageContainer } from '@/components/PageContainer'
import { toPascalCase } from '@/lib/stringUtils'
import { useQuery, useMutation, useLazyQuery } from '@apollo/client/react'
import { gql } from '@apollo/client'
import { useMetamodel } from '@/contexts/MetamodelContext'
import { StatusBadge } from '@/components/StatusBadge'
import { DetailField } from '@/components/ui/DetailField'
import { CollapsibleCard } from '@/components/ui/CollapsibleCard'
import { CollapsibleGroup } from '@/components/ui/CollapsibleGroup'
import { CIGraph } from '@/components/CIGraph'
import { CIIncidentsCard } from '@/components/CIIncidentsCard'
import { CIChangesCard } from '@/components/CIChangesCard'
import { CIIcon } from '@/lib/ciIcon'
import { ciPath } from '@/lib/ciPath'
import { GET_BLAST_RADIUS, GET_ALL_CIS } from '@/graphql/queries'
import { ADD_CI_RELATIONSHIP, REMOVE_CI_RELATIONSHIP } from '@/graphql/mutations'
import { X, Plus } from 'lucide-react'
import { toast } from 'sonner'

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

function RelationList({
  relations,
  navigate,
  onDelete,
}: {
  relations: CIRelation[]
  navigate: (path: string) => void
  onDelete?: (rel: CIRelation) => void
}) {
  const grouped = relations.reduce<Record<string, CIRelation[]>>((acc, rel) => {
    ;(acc[rel.relation] ??= []).push(rel)
    return acc
  }, {})

  return (
    <>
      {Object.entries(grouped).map(([relation, rels]) => (
        <CollapsibleGroup key={relation} title={relation.replace(/_/g, ' ')} count={rels.length}>
          {rels.map(rel => (
            <div
              key={rel.ci.id}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid #f9fafb', cursor: 'pointer' }}
              onClick={() => navigate(ciPath(rel.ci))}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-slate-dark)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {rel.ci.name}
                </div>
                <div style={{ fontSize: 12, color: 'var(--color-slate-light)', textTransform: 'capitalize' }}>
                  {rel.ci.type.replace(/_/g, ' ')}{rel.ci.environment ? ` · ${rel.ci.environment}` : ''}
                </div>
              </div>
              {rel.ci.status && <StatusBadge value={rel.ci.status} />}
              {onDelete && (
                <button
                  onClick={e => { e.stopPropagation(); onDelete(rel) }}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, marginLeft: 'auto', flexShrink: 0 }}
                  title="Delete"
                >
                  <X size={14} color="#ef4444" />
                </button>
              )}
            </div>
          ))}
        </CollapsibleGroup>
      ))}
    </>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

export function CIDetailPage() {
  const { typeName, id } = useParams<{ typeName: string; id: string }>()
  const navigate = useNavigate()
  const { t } = useTranslation()
  const { getCIType, loading: metamodelLoading } = useMetamodel()

  const ciType = typeName ? getCIType(typeName) : undefined

  // ── Relation management state ────────────────────────────────────────────
  const [showAddRel, setShowAddRel] = useState(false)
  const [addRelForm, setAddRelForm] = useState<{
    relationType: string; direction: 'outgoing' | 'incoming'; search: string; targetCI: CIRef | null
  }>({ relationType: 'DEPENDS_ON', direction: 'outgoing', search: '', targetCI: null })
  const [deleteRel, setDeleteRel] = useState<{
    sourceId: string; targetId: string; relationType: string; name: string
  } | null>(null)

  const [addRelMutation] = useMutation(ADD_CI_RELATIONSHIP)
  const [removeRelMutation] = useMutation(REMOVE_CI_RELATIONSHIP)

  const [searchCIs, { data: ciSearchData }] = useLazyQuery<{
    allCIs: { items: { id: string; name: string; type: string; status: string | null; environment: string | null }[] }
  }>(GET_ALL_CIS)

  const ciSearchResults = (ciSearchData?.allCIs.items ?? []).filter(c => c.id !== id)

  const handleCISearch = useCallback((term: string) => {
    setAddRelForm(prev => ({ ...prev, search: term, targetCI: null }))
    if (term.length >= 2) {
      searchCIs({ variables: { search: term, limit: 10 } })
    }
  }, [searchCIs])

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

  const { data, loading, refetch } = useQuery<Record<string, CIDetail | null>>(
    detailQuery ?? gql`query EmptyCIDetail { __typename }`,
    { variables: { id }, skip: !detailQuery || !id },
  )

  const { data: brData } = useQuery<{
    blastRadius: { distance: number; parentId: string | null; ci: { id: string; name: string; type: string; environment: string | null; status: string | null } }[]
  }>(GET_BLAST_RADIUS, { variables: { id }, skip: !id })

  const blastRadius = brData?.blastRadius ?? []
  const ci = typeName && data ? data[typeName] : undefined

  // ── Relation handlers ──────────────────────────────────────────────────
  async function handleAddRelation() {
    if (!addRelForm.targetCI || !ci) return
    const sourceId = addRelForm.direction === 'outgoing' ? ci.id : addRelForm.targetCI.id
    const targetId = addRelForm.direction === 'outgoing' ? addRelForm.targetCI.id : ci.id
    try {
      await addRelMutation({ variables: { sourceId, targetId, relationType: addRelForm.relationType } })
      toast.success(t('pages.ci.relationAdded'))
      setShowAddRel(false)
      setAddRelForm({ relationType: 'DEPENDS_ON', direction: 'outgoing', search: '', targetCI: null })
      refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleRemoveRelation() {
    if (!deleteRel) return
    try {
      await removeRelMutation({ variables: { sourceId: deleteRel.sourceId, targetId: deleteRel.targetId, relationType: deleteRel.relationType } })
      toast.success(t('pages.ci.relationRemoved'))
      setDeleteRel(null)
      refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  if (metamodelLoading || loading) {
    return <div style={{ padding: 40, color: 'var(--color-slate-light)', fontSize: 14 }}>Caricamento…</div>
  }
  if (!ciType) {
    return <div style={{ padding: 40, color: 'var(--color-trigger-sla-breach)', fontSize: 14 }}>Tipo CI "{typeName}" non trovato.</div>
  }
  if (!ci) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 200, gap: 12 }}>
        <p style={{ color: 'var(--color-slate-light)', fontSize: 14 }}>CI non trovato.</p>
        <button
          onClick={() => navigate(`/ci/${typeName}`)}
          style={{ color: 'var(--color-brand)', background: 'none', border: 'none', fontSize: 14, cursor: 'pointer' }}
        >
          ← Torna a {ciType.label}
        </button>
      </div>
    )
  }

  return (
    <PageContainer>
      <button
        onClick={() => navigate(`/ci/${typeName}`)}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--color-slate-light)', background: 'none', border: 'none', fontSize: 14, cursor: 'pointer', padding: 0, marginBottom: 12 }}
      >
        ← {ciType.label}
      </button>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
        <CIIcon icon={ciType.icon} size={24} color={ciType.color} />
        <h1 style={{ fontSize: 24, fontWeight: 600, color: 'var(--color-slate-dark)', margin: 0 }}>{ci.name}</h1>
        {ci.status && <StatusBadge value={ci.status} />}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 16 }}>
        {/* Left column */}
        <div>
          <CollapsibleCard title="Informazioni" defaultOpen={true}>
            {ci.description && (
              <DetailField
                label="Descrizione"
                value={ci.description}
              />
            )}

            {ci.description && specificFields.length > 0 && (
              <div style={{ borderTop: '1px solid #f3f4f6', marginBottom: 16 }} />
            )}

            {specificFields.map(f => (
              <DetailField
                key={f.name}
                label={f.label}
                value={ci[f.name] !== null && ci[f.name] !== undefined ? String(ci[f.name]) : null}
              />
            ))}

            {ci.notes && (
              <>
                <div style={{ borderTop: '1px solid #f3f4f6', margin: '12px 0' }} />
                <DetailField label="Note" value={ci.notes as string} />
              </>
            )}
          </CollapsibleCard>

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

          <CollapsibleCard
            title={`Relazioni (${(ci.dependencies as CIRelation[]).length + (ci.dependents as CIRelation[]).length})`}
            defaultOpen={false}
          >
            {(ci.dependencies as CIRelation[]).length === 0 && (ci.dependents as CIRelation[]).length === 0 ? (
              <p style={{ fontSize: 14, color: 'var(--color-slate-light)', margin: 0 }}>Nessuna relazione.</p>
            ) : (
              <>
                {(ci.dependencies as CIRelation[]).length > 0 && (
                  <div style={{ marginBottom: (ci.dependents as CIRelation[]).length > 0 ? 16 : 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-slate)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
                      Dipendenze
                    </div>
                    <RelationList
                      relations={ci.dependencies as CIRelation[]}
                      navigate={navigate}
                      onDelete={rel => setDeleteRel({ sourceId: ci.id, targetId: rel.ci.id, relationType: rel.relation, name: rel.ci.name })}
                    />
                  </div>
                )}

                {(ci.dependencies as CIRelation[]).length > 0 && (ci.dependents as CIRelation[]).length > 0 && (
                  <div style={{ borderTop: '1px solid #f3f4f6', margin: '8px 0 16px 0' }} />
                )}

                {(ci.dependents as CIRelation[]).length > 0 && (
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-slate)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
                      Dipendenti
                    </div>
                    <RelationList
                      relations={ci.dependents as CIRelation[]}
                      navigate={navigate}
                      onDelete={rel => setDeleteRel({ sourceId: rel.ci.id, targetId: ci.id, relationType: rel.relation, name: rel.ci.name })}
                    />
                  </div>
                )}
              </>
            )}

            {/* Delete confirmation */}
            {deleteRel && (
              <div style={{ padding: '12px 16px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, marginTop: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 13, color: '#991b1b' }}>
                  {t('pages.ci.removeRelation', { relationType: deleteRel.relationType, name: deleteRel.name })}
                </span>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    onClick={() => setDeleteRel(null)}
                    style={{ padding: '4px 12px', fontSize: 13, borderRadius: 6, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer', color: 'var(--color-slate-dark)' }}
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    onClick={handleRemoveRelation}
                    style={{ padding: '4px 12px', fontSize: 13, borderRadius: 6, border: 'none', background: '#ef4444', color: '#fff', cursor: 'pointer' }}
                  >
                    {t('common.delete')}
                  </button>
                </div>
              </div>
            )}

            {/* Add relation button */}
            {!showAddRel && (
              <button
                onClick={() => setShowAddRel(true)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 12, padding: '6px 14px', fontSize: 13, fontWeight: 500, borderRadius: 6, border: '1px solid var(--color-brand)', background: 'transparent', color: 'var(--color-brand)', cursor: 'pointer' }}
              >
                <Plus size={14} /> {t('pages.ci.addRelation')}
              </button>
            )}

            {/* Add relation form */}
            {showAddRel && (
              <div style={{ padding: 16, background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 8, marginTop: 12 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
                  {/* Relation type */}
                  <div>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--color-slate)', marginBottom: 4 }}>
                      {t('pages.ci.relationType')}
                    </label>
                    <select
                      value={addRelForm.relationType}
                      onChange={e => setAddRelForm(prev => ({ ...prev, relationType: e.target.value }))}
                      style={{ width: '100%', padding: '6px 8px', fontSize: 13, borderRadius: 6, border: '1px solid #d1d5db', background: '#fff' }}
                    >
                      <option value="DEPENDS_ON">DEPENDS_ON</option>
                      <option value="HOSTED_ON">HOSTED_ON</option>
                      <option value="USES_CERTIFICATE">USES_CERTIFICATE</option>
                    </select>
                  </div>
                  {/* Direction */}
                  <div>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--color-slate)', marginBottom: 4 }}>
                      {t('pages.ci.direction')}
                    </label>
                    <select
                      value={addRelForm.direction}
                      onChange={e => setAddRelForm(prev => ({ ...prev, direction: e.target.value as 'outgoing' | 'incoming' }))}
                      style={{ width: '100%', padding: '6px 8px', fontSize: 13, borderRadius: 6, border: '1px solid #d1d5db', background: '#fff' }}
                    >
                      <option value="outgoing">{t('pages.ci.dirOutgoing')}</option>
                      <option value="incoming">{t('pages.ci.dirIncoming')}</option>
                    </select>
                  </div>
                  {/* CI search */}
                  <div style={{ position: 'relative' }}>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--color-slate)', marginBottom: 4 }}>
                      CI Target
                    </label>
                    <input
                      placeholder={t('pages.ci.searchTarget')}
                      value={addRelForm.search}
                      onChange={e => handleCISearch(e.target.value)}
                      style={{ width: '100%', padding: '6px 8px', fontSize: 13, borderRadius: 6, border: '1px solid #d1d5db', boxSizing: 'border-box' }}
                    />
                    {ciSearchResults.length > 0 && !addRelForm.targetCI && (
                      <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 6, maxHeight: 180, overflowY: 'auto', zIndex: 10, boxShadow: '0 4px 12px rgba(0,0,0,.08)' }}>
                        {ciSearchResults.map(c => (
                          <div
                            key={c.id}
                            onClick={() => setAddRelForm(prev => ({ ...prev, targetCI: c, search: c.name }))}
                            style={{ padding: '8px 12px', fontSize: 13, cursor: 'pointer', borderBottom: '1px solid #f3f4f6' }}
                            onMouseEnter={e => (e.currentTarget.style.background = '#f1f5f9')}
                            onMouseLeave={e => (e.currentTarget.style.background = '#fff')}
                          >
                            <span style={{ fontWeight: 500 }}>{c.name}</span>{' '}
                            <span style={{ color: 'var(--color-slate-light)', fontSize: 12 }}>({c.type.replace(/_/g, ' ')})</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button
                    onClick={() => { setShowAddRel(false); setAddRelForm({ relationType: 'DEPENDS_ON', direction: 'outgoing', search: '', targetCI: null }) }}
                    style={{ padding: '6px 14px', fontSize: 13, borderRadius: 6, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer', color: 'var(--color-slate-dark)' }}
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    onClick={handleAddRelation}
                    disabled={!addRelForm.targetCI}
                    style={{ padding: '6px 14px', fontSize: 13, borderRadius: 6, border: 'none', background: addRelForm.targetCI ? 'var(--color-brand)' : '#d1d5db', color: '#fff', cursor: addRelForm.targetCI ? 'pointer' : 'default' }}
                  >
                    {t('pages.ci.addRelation')}
                  </button>
                </div>
              </div>
            )}
          </CollapsibleCard>

          <CIIncidentsCard ciId={ci.id} />
          <CIChangesCard ciId={ci.id} />
        </div>

        {/* Right column */}
        <div>
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '16px 20px' }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.04em', margin: '0 0 16px' }}>
              Dettagli
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <DetailField label="ID" value={ci.id} mono />
              <DetailField label="Tipo" value={ciType.label} />
              <DetailField label="Environment" value={ci.environment ?? null} />
              {ci.ownerGroup && (
                <div>
                  <div style={{ fontSize: 12, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>Owner Group</div>
                  <span style={{ padding: '2px 8px', borderRadius: 100, backgroundColor: 'var(--color-brand-light)', fontSize: 12, fontWeight: 500, color: 'var(--color-brand)' }}>
                    {(ci.ownerGroup as Team).name}
                  </span>
                </div>
              )}
              {ci.supportGroup && (
                <div>
                  <div style={{ fontSize: 12, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>Support Group</div>
                  <span style={{ padding: '2px 8px', borderRadius: 100, backgroundColor: '#ecfdf5', fontSize: 12, fontWeight: 500, color: 'var(--color-trigger-automatic)' }}>
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
    </PageContainer>
  )
}
