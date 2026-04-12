import { useMemo, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
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
                <div style={{ fontSize: 'var(--font-size-body)', fontWeight: 500, color: 'var(--color-slate-dark)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {rel.ci.name}
                </div>
                <div style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', textTransform: 'capitalize' }}>
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
    return <div style={{ padding: 40, color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)' }}>Caricamento…</div>
  }
  if (!ciType) {
    return <div style={{ padding: 40, color: 'var(--color-trigger-sla-breach)', fontSize: 'var(--font-size-body)' }}>Tipo CI "{typeName}" non trovato.</div>
  }
  if (!ci) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 200, gap: 12 }}>
        <p style={{ color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)' }}>CI non trovato.</p>
        <button
          onClick={() => navigate(`/ci/${typeName}`)}
          style={{ color: 'var(--color-brand)', background: 'none', border: 'none', fontSize: 'var(--font-size-body)', cursor: 'pointer' }}
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
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--color-slate-light)', background: 'none', border: 'none', fontSize: 'var(--font-size-body)', cursor: 'pointer', padding: 0, marginBottom: 12 }}
      >
        ← {ciType.label}
      </button>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
        <CIIcon icon={ciType.icon} size={24} color={ciType.color} />
        <h1 style={{ fontSize: 'var(--font-size-page-title)', fontWeight: 600, color: 'var(--color-slate-dark)', margin: 0 }}>{ci.name}</h1>
        {ci.status && <StatusBadge value={ci.status} />}
      </div>

      <div>
        <div>
          <CollapsibleCard title="Informazioni" defaultOpen={true}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <DetailField label="ID" value={ci.id} mono />
              <DetailField label="Tipo" value={ciType.label} />
              <DetailField label="Environment" value={ci.environment ?? null} />
              <DetailField label="Creato" value={new Date(ci.createdAt).toLocaleDateString('it-IT')} />
              <DetailField label="Aggiornato" value={ci.updatedAt ? new Date(ci.updatedAt).toLocaleDateString('it-IT') : null} />
              {ci.ownerGroup && (
                <DetailField label="Owner Group" value={
                  <span style={{ padding: '2px 8px', borderRadius: 100, backgroundColor: 'var(--color-brand-light)', fontSize: 'var(--font-size-body)', fontWeight: 500, color: 'var(--color-brand)' }}>
                    {(ci.ownerGroup as Team).name}
                  </span>
                } />
              )}
              {ci.supportGroup && (
                <DetailField label="Support Group" value={
                  <span style={{ padding: '2px 8px', borderRadius: 100, backgroundColor: '#ecfdf5', fontSize: 'var(--font-size-body)', fontWeight: 500, color: 'var(--color-trigger-automatic)' }}>
                    {(ci.supportGroup as Team).name}
                  </span>
                } />
              )}
              {specificFields.map(f => (
                <DetailField
                  key={f.name}
                  label={f.label}
                  value={ci[f.name] !== null && ci[f.name] !== undefined ? String(ci[f.name]) : null}
                />
              ))}
            </div>
            {ci.description && (
              <>
                <div style={{ borderTop: '1px solid #f3f4f6', margin: '12px 0' }} />
                <DetailField label="Descrizione" value={ci.description} />
              </>
            )}
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
            headerRight={
              <button
                onClick={e => { e.stopPropagation(); setShowAddRel(true) }}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', fontSize: 'var(--font-size-body)', fontWeight: 500, borderRadius: 6, border: '1px solid var(--color-brand)', background: 'transparent', color: 'var(--color-brand)', cursor: 'pointer' }}
              >
                <Plus size={12} /> {t('pages.ci.addRelation')}
              </button>
            }
          >
            {(ci.dependencies as CIRelation[]).length === 0 && (ci.dependents as CIRelation[]).length === 0 ? (
              <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', margin: 0 }}>Nessuna relazione.</p>
            ) : (
              <>
                {(ci.dependencies as CIRelation[]).length > 0 && (
                  <div style={{ marginBottom: (ci.dependents as CIRelation[]).length > 0 ? 16 : 0 }}>
                    <div style={{ fontSize: 'var(--font-size-label)', fontWeight: 700, color: 'var(--color-slate)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
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
                    <div style={{ fontSize: 'var(--font-size-label)', fontWeight: 700, color: 'var(--color-slate)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
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
                <span style={{ fontSize: 'var(--font-size-body)', color: '#991b1b' }}>
                  {t('pages.ci.removeRelation', { relationType: deleteRel.relationType, name: deleteRel.name })}
                </span>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    onClick={() => setDeleteRel(null)}
                    style={{ padding: '4px 12px', fontSize: 'var(--font-size-body)', borderRadius: 6, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer', color: 'var(--color-slate-dark)' }}
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    onClick={handleRemoveRelation}
                    style={{ padding: '4px 12px', fontSize: 'var(--font-size-body)', borderRadius: 6, border: 'none', background: '#ef4444', color: '#fff', cursor: 'pointer' }}
                  >
                    {t('common.delete')}
                  </button>
                </div>
              </div>
            )}

            {/* Add relation modal */}
            {showAddRel && ci && createPortal(
              <div
                style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: 16 }}
                onClick={e => { if (e.target === e.currentTarget) { setShowAddRel(false); setAddRelForm({ relationType: 'DEPENDS_ON', direction: 'outgoing', search: '', targetCI: null }) } }}
              >
                <div style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 480, boxShadow: '0 24px 80px rgba(0,0,0,0.22)' }}>
                  {/* Header */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 24px', borderBottom: '1px solid #f3f4f6' }}>
                    <h2 style={{ margin: 0, fontSize: 'var(--font-size-card-title)', fontWeight: 700, color: 'var(--color-slate-dark)' }}>
                      {t('pages.ci.addRelation')} — {ci.name}
                    </h2>
                    <button onClick={() => { setShowAddRel(false); setAddRelForm({ relationType: 'DEPENDS_ON', direction: 'outgoing', search: '', targetCI: null }) }} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 6, display: 'flex' }}>
                      <X size={20} color="var(--color-slate)" />
                    </button>
                  </div>

                  {/* Body */}
                  <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
                    {/* Relation type */}
                    <div>
                      <label style={{ display: 'block', fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', marginBottom: 4 }}>
                        {t('pages.ci.relationType')}
                      </label>
                      <select
                        value={addRelForm.relationType}
                        onChange={e => setAddRelForm(prev => ({ ...prev, relationType: e.target.value, targetCI: null, search: '' }))}
                        style={{ width: '100%', padding: '8px 10px', fontSize: 'var(--font-size-body)', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', boxSizing: 'border-box' }}
                      >
                        <option value="DEPENDS_ON">DEPENDS_ON</option>
                        <option value="HOSTED_ON">HOSTED_ON</option>
                        <option value="USES_CERTIFICATE">USES_CERTIFICATE</option>
                      </select>
                    </div>

                    {/* Direction */}
                    <div>
                      <label style={{ display: 'block', fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', marginBottom: 6 }}>
                        {t('pages.ci.direction')}
                      </label>
                      <div style={{ display: 'flex', gap: 12 }}>
                        {(['outgoing', 'incoming'] as const).map(dir => (
                          <label key={dir} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-body)', cursor: 'pointer', color: addRelForm.direction === dir ? 'var(--color-brand)' : 'var(--color-slate)' }}>
                            <input type="radio" name="rel-dir" checked={addRelForm.direction === dir} onChange={() => setAddRelForm(prev => ({ ...prev, direction: dir }))} />
                            {dir === 'outgoing' ? t('pages.ci.dirOutgoing') : t('pages.ci.dirIncoming')}
                          </label>
                        ))}
                      </div>
                    </div>

                    {/* CI search */}
                    <div style={{ position: 'relative' }}>
                      <label style={{ display: 'block', fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', marginBottom: 4 }}>
                        CI Target
                      </label>
                      <input
                        placeholder={t('pages.ci.searchTarget')}
                        value={addRelForm.search}
                        onChange={e => handleCISearch(e.target.value)}
                        style={{ width: '100%', padding: '8px 10px', fontSize: 'var(--font-size-body)', borderRadius: 6, border: '1px solid #d1d5db', boxSizing: 'border-box' }}
                      />
                      {addRelForm.targetCI && (
                        <div style={{ marginTop: 6, padding: '6px 10px', background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 6, fontSize: 'var(--font-size-body)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                          <span><strong>{addRelForm.targetCI.name}</strong> <span style={{ color: '#94a3b8', fontSize: 'var(--font-size-body)' }}>({addRelForm.targetCI.type})</span></span>
                          <button onClick={() => setAddRelForm(prev => ({ ...prev, targetCI: null, search: '' }))} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2 }}><X size={14} color="#94a3b8" /></button>
                        </div>
                      )}
                      {ciSearchResults.length > 0 && !addRelForm.targetCI && (
                        <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 6, maxHeight: 180, overflowY: 'auto', zIndex: 10, boxShadow: '0 4px 12px rgba(0,0,0,.08)', marginTop: 2 }}>
                          {ciSearchResults.map(c => (
                            <div
                              key={c.id}
                              onClick={() => setAddRelForm(prev => ({ ...prev, targetCI: c, search: c.name }))}
                              style={{ padding: '8px 12px', fontSize: 'var(--font-size-body)', cursor: 'pointer', borderBottom: '1px solid #f3f4f6' }}
                              onMouseEnter={e => (e.currentTarget.style.background = '#f1f5f9')}
                              onMouseLeave={e => (e.currentTarget.style.background = '#fff')}
                            >
                              <span style={{ fontWeight: 500 }}>{c.name}</span>{' '}
                              <span style={{ color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)' }}>({c.type.replace(/_/g, ' ')})</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Footer */}
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '14px 24px', borderTop: '1px solid #f3f4f6' }}>
                    <button
                      onClick={() => { setShowAddRel(false); setAddRelForm({ relationType: 'DEPENDS_ON', direction: 'outgoing', search: '', targetCI: null }) }}
                      style={{ padding: '8px 16px', fontSize: 'var(--font-size-body)', borderRadius: 6, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer', color: 'var(--color-slate-dark)' }}
                    >
                      {t('common.cancel')}
                    </button>
                    <button
                      onClick={handleAddRelation}
                      disabled={!addRelForm.targetCI}
                      style={{ padding: '8px 16px', fontSize: 'var(--font-size-body)', borderRadius: 6, border: 'none', background: addRelForm.targetCI ? '#38bdf8' : '#d1d5db', color: '#fff', cursor: addRelForm.targetCI ? 'pointer' : 'default', fontWeight: 500, transition: 'background 150ms' }}
                      onMouseEnter={e => { if (addRelForm.targetCI) (e.currentTarget as HTMLElement).style.background = '#0ea5e9' }}
                      onMouseLeave={e => { if (addRelForm.targetCI) (e.currentTarget as HTMLElement).style.background = '#38bdf8' }}
                    >
                      {t('pages.ci.addRelation')}
                    </button>
                  </div>
                </div>
              </div>,
              document.body,
            )}
          </CollapsibleCard>

          <CIIncidentsCard ciId={ci.id} />
          <CIChangesCard ciId={ci.id} />
        </div>

      </div>
    </PageContainer>
  )
}
